// R434: Bash reports timedOutAfterMs — same shape as R424's Grep.timedOut.
//
// WHERE THE SIGNAL WAS
//   `ShellCommand.ts` already knew the timeout and its duration, and formatted it into prose:
//
//       else if (code === SIGTERM) {
//         result.stderr = prependStderr(
//           `Command timed out after ${formatDuration(this.#timeout)}`, result.stderr,
//         )
//       }
//
//   `this.#timeout` IS the millisecond value the contract asks for. It had no structured carrier.
//
// THE BRANCH DISTINCTION THAT MATTERS
//   The timeout timer has two outcomes:
//
//       #handleTimeout(self) {
//         if (shouldAutoBackground && onTimeoutCallback) {
//           onTimeoutCallback(background.bind(self))   // command KEEPS RUNNING
//         } else {
//           doKill(SIGTERM)                            // command is KILLED
//         }
//       }
//
//   Auto-backgrounding reuses the same timer without timing anything out. Recording a duration
//   there would claim a command was killed when it was merely moved to the background. So the flag
//   is set only in the kill branch, and that is the load-bearing assertion here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const SHELL = path.join(SRC, 'src', 'utils', 'ShellCommand.ts');
const BASH = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'BashTool', 'BashTool.tsx');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const shell = () => fs.readFileSync(SHELL, 'utf8');
const bash = () => fs.readFileSync(BASH, 'utf8');

function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the contract keeps timedOutAfterMs optional', () => {
  const dts = fs.readFileSync(DTS, 'utf8');
  const at = dts.indexOf('export interface BashOutput');
  assert.ok(at > 0, 'BashOutput is gone');
  const open = dts.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < dts.length; i += 1) {
    if (dts[i] === '{') depth += 1;
    else if (dts[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.match(dts.slice(open + 1, end), /timedOutAfterMs\?: number/,
    'timedOutAfterMs is no longer an optional number');
});

test('ExecResult carries the field, and the instance keeps the flag', () => {
  const c = code(shell());
  assert.match(c, /timedOutAfterMs\?: number/, 'ExecResult lost timedOutAfterMs');
  assert.match(c, /#timedOutAfterMs: number \| undefined = undefined/,
    'the instance flag is gone: there is no way to tell a fired timeout from a configured one');
  // The configured limit must remain a separate, always-present value.
  assert.match(c, /#timeout: number/, 'the configured timeout field is gone');
});

test('the flag is set ONLY in the kill branch, never when auto-backgrounding', () => {
  const c = code(shell());

  const handlerAt = c.indexOf('static #handleTimeout');
  assert.ok(handlerAt > 0, 'the timeout handler is gone');
  const handler = c.slice(handlerAt, handlerAt + 700);

  const setAt = handler.indexOf('self.#timedOutAfterMs = self.#timeout');
  const killAt = handler.indexOf('self.#doKill(SIGTERM)');
  const bgAt = handler.indexOf('self.#onTimeoutCallback(');

  assert.ok(setAt > 0, 'the flag is never set: the field would always be absent');
  assert.ok(bgAt > 0, 'the auto-background call moved');
  assert.ok(killAt > 0, 'the kill call moved');

  // It must be in the else branch — after the background call, next to the kill.
  assert.ok(setAt > bgAt,
    'the flag is set before the background branch is resolved: an auto-backgrounded command '
    + 'would be reported as timed out although it is still running');
  assert.ok(Math.abs(setAt - killAt) < 200,
    'the flag is not adjacent to doKill(SIGTERM): re-derive which branch sets it');
});

test('the result copies the flag only when it was set', () => {
  const c = code(shell());
  assert.match(c, /this\.#timedOutAfterMs !== undefined\s*\?\s*\{ timedOutAfterMs: this\.#timedOutAfterMs \}/,
    'the result does not conditionally copy the flag');
  // No unconditional field: a normal completion must stay a small object.
  assert.ok(!/^\s+timedOutAfterMs: this\.#timeout,$/m.test(c),
    'the result reports the CONFIGURED timeout on every call instead of the fired one');
});

test('BashTool surfaces the value from `result`, not from the configured limit', () => {
  const c = code(bash());
  assert.match(c, /\.\.\.\(result\.timedOutAfterMs !== undefined/,
    'BashTool does not report timedOutAfterMs from the result');
  assert.match(c, /\{ timedOutAfterMs: result\.timedOutAfterMs \}/,
    'the reported value is not the fired duration');
  // It must live in the data object where `result` is in scope, not in a destructuring pattern.
  // The declaration carries a type annotation (`const data: Out = {`), which is why matching
  // `const data = {` alone would miss it.
  const at = c.indexOf('...(result.timedOutAfterMs !== undefined');
  assert.ok(at > 0, 'the spread is gone');
  const dataAt = c.lastIndexOf('const data: Out = {', at);
  assert.ok(dataAt > 0 && dataAt < at,
    'the spread is not inside the data object literal');
  // And `result` must be assigned above it.
  const resultAt = c.lastIndexOf('result = generatorResult.value', at);
  assert.ok(resultAt > 0 && resultAt < at,
    '`result` is not assigned before the data object is built: the value would be undefined');
});

test('the schema declares timedOutAfterMs as optional', () => {
  const c = code(bash());
  const at = c.indexOf('const outputSchema');
  assert.ok(at > 0, 'BashTool lost its outputSchema');
  const end = c.indexOf('type OutputSchema', at);
  const seg = c.slice(at, end > 0 ? end : at + 4200);
  assert.match(seg, /timedOutAfterMs: z[\s\S]{0,120}?\.optional\(\)/,
    'timedOutAfterMs is not declared optional');
});

test('the six remaining Bash fields are still absent', () => {
  // R433 concluded these need mechanisms, not schema lines. Recording it here so a later round
  // does not assume they were forgotten.
  const c = code(bash());
  for (const f of ['backgroundCwdHint', 'backgroundEndsWithFinalResponse',
    'backgroundWakesOwner', 'staleReadFileStateHint', 'ghRateLimitHint']) {
    assert.ok(!c.includes(f), f + ' appeared without its mechanism');
  }
});

test('the adopted bundle carries the field', () => {
  const { text } = findChunk('Set when the command was killed by its timeout');
  assert.ok(text.includes('timedOutAfterMs'), 'timedOutAfterMs is missing from the built chunk');
});
