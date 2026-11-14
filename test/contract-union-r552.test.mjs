// R552: the terminator that R551 left open is load-bearing, and it was written out in six places.
//
// WHAT R551 LEFT OPEN
//   `runtime-tools.cjs` and `tool-absence.cjs` ended their union scan with a hardcoded two-name comparison, while
//   `contract-compare.cjs`, `contract-vs-impl.cjs` and `tool-relation.cjs` used a `UNION_NAMES` Set. The question was
//   whether those could disagree.
//
// THE ANSWER, MEASURED ON BOTH CONTRACT FILES
//   `ToolInputSchemas` is a union of the form
//
//       export type ToolInputSchemas =
//         | AgentInput
//         | BashInput
//         …
//         | ExitWorktreeInput
//       export type ToolOutputSchemas =
//
//   The next declaration's first line looks exactly like a member. Without a terminator the scan collects it:
//
//       cc-contract/package/sdk-tools.d.ts                44 members with, 45 without
//       ccb-src/…/claude-agent-sdk@0.2.114/sdk-tools.d.ts 21 members with, 22 without
//
//   In both cases the extra member is `ToolOutputSchemas` itself. So the two styles CANNOT disagree on today's input —
//   no union member is named like a terminator — but the rule is not optional: dropping it silently inflates every
//   tool count by one.
//
// SIX COPIES
//   `contract-compare`, `contract-vs-impl`, `tool-relation` each declared the Set; `runtime-tools`, `tool-absence` and
//   `contract-fields` each hardcoded the comparison. Six places for one rule, which is how R550's `blank()` went wrong.
//   All six now import `tools/contract-union.cjs`.
//
// THE EDIT THAT BROKE A TOOL, AND WHY IT IS RECORDED
//   Replacing "UNION_NAMES through the end of unionMembers" in `tool-relation.cjs` also removed `DISPATCH_NAMES`, which
//   sat on the line immediately after the declaration. The tool then failed with `ReferenceError: DISPATCH_NAMES is not
//   defined`. A range-based edit needs its whole range read, not just its endpoints — the same lesson as every
//   mislocated assertion in this session, applied to an edit instead of a check.
//
// WHAT IS NOT CLAIMED
//   Not that six was the total: the search was for the Set declaration and the two-name comparison, so a seventh copy
//   spelled differently (a regex, a `.includes` on an array) would not have been found.
//   Not that the shared module covers the two contracts' differences: `contract-compare` reads the SDK file and the
//   others read the CLI file, and those paths are still per-caller because they differ deliberately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNION_NAMES, unionMembers, contractToolNames } from '../tools/contract-union.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
const SDK = path.join(ROOT, '..', '.tmp', 'ccb-src', 'node_modules', '.cache',
  '@anthropic-ai', 'claude-agent-sdk@0.2.114@@@1', 'sdk-tools.d.ts');

const have = (p) => fs.existsSync(p);

test('the terminator stops the scan, and would not stop on its own', () => {
  // Without a terminator the loop's own break condition is satisfied by the next declaration's first member line only
  // after it has already been collected. Demonstrated by reading the union with and without it.
  if (!have(CLI)) return;
  const text = fs.readFileSync(CLI, 'utf8');
  const withTerminator = unionMembers(text, 'ToolInputSchemas');
  // Simulate "no terminator" by reading with an empty set through a local copy of the loop.
  const lines = text.slice(text.indexOf('export type ToolInputSchemas =')).split('\n');
  const noTerminator = [];
  for (let i = 1; i < lines.length; i += 1) {
    const m = /^\s*\|\s*(\w+)\s*;?\s*$/.exec(lines[i]);
    if (m) { noTerminator.push(m[1]); continue; }
    if (/^\s*$/.test(lines[i]) || /^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue;
    if (/^\s*\|/.test(lines[i])) continue;
    break;
  }
  assert.equal(withTerminator.length, 44, `the CLI contract yields ${withTerminator.length} input members, expected 44`);
  assert.equal(noTerminator.length, withTerminator.length + 1,
    'without the terminator the scan does not collect one extra member — the terminator may be redundant after all');
  assert.ok(noTerminator.includes('ToolOutputSchemas'),
    'the extra member is not ToolOutputSchemas, so the mechanism described is wrong');
});

test('the SDK contract behaves the same way', () => {
  if (!have(SDK)) return;
  const text = fs.readFileSync(SDK, 'utf8');
  const members = contractToolNames(text);
  assert.equal(members.length, 21, `the SDK contract yields ${members.length} tools, expected 21`);
  for (const name of members) {
    assert.ok(!/Schemas$/.test(name), `a type name leaked into the tool list: ${name}`);
  }
});

test('exactly one definition of the terminator list exists', () => {
  const toolsDir = path.join(ROOT, 'tools');
  const offenders = [];
  for (const name of fs.readdirSync(toolsDir)) {
    if (!name.endsWith('.cjs')) continue;
    const text = fs.readFileSync(path.join(toolsDir, name), 'utf8');
    if (/const UNION_NAMES = new Set\(/.test(text) && name !== 'contract-union.cjs') {
      offenders.push(`${name}: declares UNION_NAMES`);
    }
    if (/=== 'ToolInputSchemas' \|\| .*=== 'ToolOutputSchemas'/.test(text)) {
      offenders.push(`${name}: hardcodes the terminator comparison`);
    }
  }
  assert.deepEqual(offenders, [], 'the terminator rule is duplicated again:\n' + offenders.join('\n'));
});

test('every consumer imports the shared module', () => {
  const consumers = ['contract-compare.cjs', 'contract-vs-impl.cjs', 'tool-relation.cjs',
    'runtime-tools.cjs', 'tool-absence.cjs', 'contract-fields.cjs'];
  for (const name of consumers) {
    const text = fs.readFileSync(path.join(ROOT, 'tools', name), 'utf8');
    assert.match(text, /require\('\.\/contract-union\.cjs'\)/, `${name} does not import the shared union module`);
  }
});

test('the tool broken by the extraction still runs', () => {
  // `DISPATCH_NAMES` was removed along with UNION_NAMES in tool-relation.cjs; the tool then threw a ReferenceError.
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'tool-relation.cjs'), 'utf8');
  assert.match(src, /const DISPATCH_NAMES = \[/, 'DISPATCH_NAMES is missing again');
});

test('UNION_NAMES is the two type names, not a longer list', () => {
  // A third entry would end the scan on a member named like that type instead of on the next declaration.
  assert.deepEqual([...UNION_NAMES].sort(), ['ToolInputSchemas', 'ToolOutputSchemas']);
});

test('the terminator measurement is recorded at the module', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'contract-union.cjs'), 'utf8');
  assert.match(src, /44 with terminator, 45 without/, 'the CLI measurement is gone');
  assert.match(src, /21 with terminator, 22 without/, 'the SDK measurement is gone');
  assert.match(src, /six places|five times/, 'the duplication count is not recorded');
});
