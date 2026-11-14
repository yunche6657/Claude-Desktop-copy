// R551: two copies of one rule disagreed about the only case that matters — a missing input.
//
// THE DUPLICATION
//   `tools/runtime-tools.cjs` and `tools/tool-absence.cjs` each contain `contractTools()`, which reads the union of
//   tool names out of the SDK contract file. Same path, same parsing, 1.00 similarity by the detector in
//   tools/duplicate-decisions.cjs.
//
// THE DISAGREEMENT
//   Present clause:   runtime-tools:165   `if (!fs.existsSync(CONTRACT)) return null;`
//                     tool-absence:49     `if (!fs.existsSync(CONTRACT)) return [];`
//
//   `null` means "there is no contract, so I cannot tell you"; `[]` means "there are zero contract tools". The caller in
//   tool-absence does `for (const name of contract)`, so an empty array ran zero iterations and produced an EMPTY
//   REPORT — with exit 0.
//
// MEASURED BY MOVING THE FILE ASIDE
//       with the contract:     tool-absence 23 rows, exit 0
//       without the contract:  tool-absence  0 rows, exit 0     <- a clean answer produced by having no input
//                              runtime-tools emits `null` in its JSON
//
//   That is worse than R550's `blank()` duplication, where two copies of a blanker produced different numbers. Here one
//   copy produced NO number and called it zero. A reader of the empty report would conclude nothing is absent.
//
// THE FIX, AND A FIRST ATTEMPT THAT CRASHED
//   `contractTools()` now returns `null`, and `analyse()` returns `{ error }` — the convention this file already uses
//   for a missing `src/tools.ts` and a failed runtime probe. The first attempt set `process.exitCode = 2` and returned
//   from inside `analyse()`, which left `r` undefined at the call site and crashed with a TypeError. Measured after:
//   exit 2, a message naming the path, and the normal run unchanged at 44 contract / 39 runtime.
//
// WHAT IS NOT CLAIMED
//   Not that the two functions are now identical: they still differ in how the union terminator is spelled
//   (`UNION_NAMES.has(...)` versus a two-name comparison), and that difference was not examined.
//   Not that every other duplicate found by tools/duplicate-decisions.cjs was checked — only `blank` (R550) and this
//   pair were read. The remaining ~60 groups are candidates, not conclusions.
//   Not that exit 2 is right for a consumer that expects JSON on stdout: `--json` still prints the error object, so a
//   caller parsing JSON gets a well-formed result with an `error` field rather than an empty array.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = path.join(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

test('a missing contract returns null, not an empty list', () => {
  // The source-level check: the sentinel is distinguishable from "zero tools".
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'tool-absence.cjs'), 'utf8');
  const at = src.indexOf('function contractTools()');
  assert.ok(at >= 0, 'contractTools is gone from tool-absence');
  const head = src.slice(at, at + 400);
  assert.match(head, /if \(!fs\.existsSync\(CONTRACT\)\) return null;/,
    'a missing contract still returns [] — a clean report produced by having no input');
});

test('both copies of the rule now agree on the missing case', () => {
  // The point of the round: one rule, two files, one answer.
  //
  // Checked on the PRESENT-CLAUSE only. Each function also contains an inner `members()` helper with its own
  // `return []` for "this type name was not found" — a different question from "there is no contract file", and a
  // whole-function search for `return [];` matches that inner one and reports a false failure.
  for (const rel of ['tools/runtime-tools.cjs', 'tools/tool-absence.cjs']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const at = src.indexOf('function contractTools()');
    assert.ok(at >= 0, `contractTools is gone from ${rel}`);
    const head = src.slice(at, at + 300);
    assert.match(head, /if \(!fs\.existsSync\(CONTRACT\)\) return null;/,
      `${rel} does not return null when the contract is absent`);
  }
});

test('the caller reports the absence instead of looping zero times', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'tool-absence.cjs'), 'utf8');
  assert.match(src, /if \(!contract\) \{[\s\S]{0,700}?return \{\s*error:/,
    'analyse() no longer returns an error for a missing contract');
  assert.match(src, /Reporting zero absences would be a clean/,
    'the message does not say why an empty report is wrong');
});

test('the normal run is unchanged', () => {
  // The fix must not have altered the working path: 44 contract tools, 39 runtime.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'tool-absence.cjs'), '--json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, 'tool-absence failed on the normal path:\n' + (r.stderr || '').slice(0, 500));
  const d = JSON.parse(r.stdout);
  assert.equal(d.contractCount, 44, `contract tools is ${d.contractCount}, expected 44`);
  assert.equal(d.runtimeCount, 39, `runtime tools is ${d.runtimeCount}, expected 39`);
  assert.equal(d.rows.length, 23, `the absence rows changed: ${d.rows.length}`);
});

test('the divergence is recorded with its measurement', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'tool-absence.cjs'), 'utf8');
  assert.match(src, /23 rows to 0 rows with exit 0/, 'the measured consequence is not recorded');
  assert.match(src, /semantics differ|two copies of one rule|had disagreed/i,
    'the fact that two copies disagreed is not stated');
});

test('the contract file itself is untouched', () => {
  // This round renamed it aside twice to measure the missing case; both restorations are now verified.
  assert.ok(fs.existsSync(CONTRACT), 'the contract file is missing — the experiment did not restore it');
  assert.equal(fs.statSync(CONTRACT).size, 173038,
    `the contract file is ${fs.statSync(CONTRACT).size} bytes, expected 173038: it may have been damaged`);
});
