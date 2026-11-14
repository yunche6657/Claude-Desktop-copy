// R424: Grep reports `timedOut` — the plumbing, not just the field.
//
// WHAT WAS ACTUALLY WRONG
//   R420/R421 recorded `Grep.timedOut` as a missing output field. Investigating showed the field
//   was the smallest part of it:
//
//     src/utils/ripgrep.ts detects timeouts and defines RipgrepTimeoutError with a
//     `partialResults` member, whose comment says it exists "to distinguish between 'no matches'
//     and 'timed out'". But it throws only when the timeout produced ZERO lines:
//
//         if (isTimeout && lines.length === 0) { reject(new RipgrepTimeoutError(...)); return }
//         resolve(lines)                    // <-- partial output on timeout = SUCCESS
//
//     `partialResults` is declared and read nowhere. GrepTool's comment claims the error
//     "propagates up so Claude knows the search didn't complete" — false in the partial case,
//     which is the common one on a large repository.
//
//   So adding the schema field alone would have shipped a field that is always false. That is
//   worse than not having it: the model would trust a boolean that never fires.
//
// WHAT THIS FILE GUARDS
//   The three parts that together make the field honest: the callback exists, the tool sets it,
//   and every output branch carries it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const RIPGREP = path.join(SRC, 'src', 'utils', 'ripgrep.ts');
const GREP = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'GrepTool', 'GrepTool.ts');

const ripgrep = () => fs.readFileSync(RIPGREP, 'utf8');
const grep = () => fs.readFileSync(GREP, 'utf8');

test('ripGrep accepts an out-of-band timeout report', () => {
  // Added as a PARAMETER, not a changed return type: five call sites share this function and only
  // GrepTool needs the distinction.
  const s = ripgrep();
  assert.match(s, /onTimeout\?: \(partial: \{ lineCount: number \}\) => void/,
    'the onTimeout parameter is gone: Grep can no longer learn about a partial timeout');
  assert.match(s, /Promise<string\[\]> \{/,
    'the return type changed: the other four call sites would need updating');
});

test('the partial-timeout branch reports, the zero-result branch still rejects', () => {
  const s = ripgrep();
  // Zero results: unchanged behaviour — an error, because an empty timed-out search must not read
  // as "no matches".
  assert.match(s, /if \(isTimeout && lines\.length === 0\) \{[\s\S]{0,400}?new RipgrepTimeoutError\(/,
    'the zero-result timeout no longer rejects: an empty truncated search would look like "none"');
  // Partial results: the case that used to be silently resolved.
  assert.match(s, /if \(isTimeout && lines\.length > 0\) \{[\s\S]{0,120}?onTimeout\?\.\(/,
    'the partial-result timeout no longer reports: this is the defect R424 fixed');
});

test('GrepTool records the flag and threads it into every output branch', () => {
  const g = grep();
  assert.match(g, /let timedOut = false/,
    'the flag is gone: nothing records that the search timed out');
  assert.match(g, /ripGrep\(args, absolutePath, abortController\.signal, \(\) => \{[\s\S]{0,80}?timedOut = true/,
    'the callback is no longer passed to ripGrep');

  // Three output modes: content, count, files_with_matches. A flag present in two of three would
  // make the field depend on which mode the caller happened to use.
  // R428 inserted the totalFiles/totalLines spreads between appliedOffset and timedOut, so this
  // must not require them to be adjacent — only present in the same branch.
  const spreads = (g.match(/\.\.\.\(timedOut \? \{ timedOut: true \} : \{\}\),/g) || []).length;
  assert.equal(spreads, 3,
    'expected timedOut in all three output branches, found ' + spreads);
  const offsetSpreads = (g.match(/\.\.\.\(offset > 0 && \{ appliedOffset: offset \}\),/g) || []).length;
  assert.equal(offsetSpreads, 3,
    'the appliedOffset spread count changed; re-derive the branch count');

  // And declared in the schema.
  const at = g.indexOf('const outputSchema');
  const seg = g.slice(at, at + 2600);
  assert.match(seg, /^\s{4}timedOut: z/m, 'timedOut is not in the output schema');
});

test('the flag is optional — a normal search must not carry it', () => {
  // `timedOut: false` on every result would be noise in a shape the model reads on every call.
  const g = grep();
  assert.ok(!/timedOut: false/.test(g),
    'a literal `timedOut: false` is being emitted: the field should be absent unless true');
  assert.match(g, /\.\.\.\(timedOut \? \{ timedOut: true \} : \{\}\)/,
    'the conditional spread changed shape; re-derive whether the field is still absent by default');
});

test('the misleading comment is corrected, not left contradicting the code', () => {
  // The old comment claimed the error "propagates up". Leaving it would send the next reader down
  // the same wrong path this round started on.
  const g = grep();
  assert.ok(!/throws RipgrepTimeoutError which propagates up/.test(g),
    'the comment claiming the timeout error propagates is back, and it is inaccurate');
  assert.match(g, /resolves with partial lines when it times out|partial lines/i,
    'the corrected comment explaining partial-line behaviour is gone');
});

test('the adopted bundle carries the new field', () => {
  const { text } = findChunk('True when the search timed out and results may be incomplete');
  assert.ok(text.includes('True when the search timed out and results may be incomplete'),
    'the field description is missing from the bundle');
});
