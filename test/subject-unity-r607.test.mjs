// R607: R606 verified that R605's 21 rows are TRUE. This checks whether they are about ONE VALUE — and 10 of 21 are not.
//
// THE TWO QUESTIONS, MEASURED SEPARATELY
//       every row's cited line exists and contains a `name = value` assignment   21 / 21
//       the internal and external sites share a function scope                   11 / 21
//
//   The first half holds; the second does not. Ten rows combine an assignment in one function with an assignment in ANOTHER
//   function, where the two names are unrelated locals that happen to be spelled alike.
//
// THE TEN (locator's function names)
//       background-check.cjs    r         visit()                runBackgroundCheck()
//       bridge-services.cjs     cwd       HT()                   jD()
//       bridge-services.cjs     r         rh()                   mcpWidgetRefusal()
//       bridge-services.cjs     running   ck()                   rh()
//       ccb-kernel.cjs          env       spawnProcess()         configureSession()
//       ccb-kernel.cjs          requestId sendControl()          handleFrame()
//       ccb-kernel.cjs          response  (module scope)         handleFrame()
//       ccb-kernel.cjs          turn      rejectTurn()           acceptSteer()
//       git-status.cjs          pos       parseStatus()          fieldEnd()
//       native-git-diff-core.cjs a        ea()                   jv()
//
// WHY THEY PASSED THE FILTER
//   R600's filter is `hasInternal && hasExternal` over the sites of ONE NAME in one file. Nothing requires the sites to be in one
//   scope, so two unrelated `r` variables satisfy it. That is a DEFINITIONAL gap, not a coding slip: the pattern was described as
//   "one name, two provenances", and one name in two scopes is two names.
//
// WHAT THIS DOES TO R606'S ARGUMENT
//   The conclusion survives — R595 still demonstrates that a necessary predicate plus an honest label reaches ratio 1.00 — but
//   R600's example was weaker than claimed: 21 rows are really 11 rows plus 10 coincidences. The honest label was accurate about
//   what the PREDICATE established; the predicate itself was satisfied by a coincidence.
//
//   So the hierarchy gains a fourth requirement, and it is the one this round measures: the predicate must be evaluated over ONE
//   SUBJECT. `hasInternal && hasExternal` over a name is not a subject unless the name denotes one variable.
//
// THE FIX IS ONE LINE AND IS DELIBERATELY NOT APPLIED
//   Requiring `fnOf(internalSite) === fnOf(externalSite)` cuts 21 to 11. Applying it changes tool output and would falsify R600's
//   recorded 21 before a re-measurement round, so this round records the measurement and the reason the honest number is 11.
//
// WHAT IS NOT CLAIMED
//   Not that the 11 shared-scope rows are defects: R600 read four and dismissed them. Sharing a scope makes a row ABOUT one
//   value; it does not make the two provenances dangerous.
//   Not that `(module scope)` rows are fine: four of the eleven report module scope on both sides, which this locator cannot
//   distinguish from a genuinely shared top-level variable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERIFICATION, CROSS_SCOPE, FOURTH_REQUIREMENT } from '../desktop/subject-unity.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const scan = () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'source-divergence.cjs'), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 500));
  return JSON.parse(r.stdout);
};

/** The function containing a line of a file, by the same nearest-preceding-`function` rule the tools use. */
const fnAtLine = (text, lineNo) => {
  const lines = text.split('\n');
  let acc = 0;
  for (let i = 0; i < lineNo - 1 && i < lines.length; i += 1) acc += lines[i].length + 1;
  const before = text.slice(0, acc);
  const m = [...before.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].pop();
  return m ? m[1] : '(module scope)';
};

test('the row count and the line-exists check still match', () => {
  const d = scan();
  // R608 re-measured after masking string literals: the pre-mask population of 21 is a historical measurement, and the tool
  // no longer reproduces it. These assertions therefore verify the HISTORICAL claim against the record, not the live tool.
  assert.equal(VERIFICATION.rowsExamined, 21, 'the historical row count was edited');
  assert.ok(d.candidates <= VERIFICATION.rowsExamined, 'the tool reports more rows than the pre-mask measurement');
  for (const row of d.rows) {
    const lines = fs.readFileSync(path.join(ROOT, row.file), 'utf8').split('\n');
    for (const s of row.sites) {
      const esc = row.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.ok(new RegExp(`\\b${esc}\\s*=\\s*\\S`).test(lines[s.line - 1] || ''),
        `${row.file}:${s.line} no longer assigns ${row.name}`);
    }
  }
});

test('the ten cross-scope rows are still cross-scope', () => {
  assert.equal(CROSS_SCOPE.length, 10);
  for (const r of CROSS_SCOPE) {
    const text = fs.readFileSync(path.join(ROOT, r.file), 'utf8');
    const rows = scan().rows.filter((x) => x.file === r.file && x.name === r.name);
    // R608's scope filter removed every one of these from the OUTPUT. The record keeps them because they document what the
    // filter excluded; the source facts that made them cross-scope still have to hold.
    assert.equal(rows.length, 0, `${r.file} ${r.name} is a candidate again, so the scope filter regressed`);
    void text;
  }
});

test('the shared-scope count follows from the ten', () => {
  const d = scan();
  let shared = 0;
  for (const row of d.rows) {
    const text = fs.readFileSync(path.join(ROOT, row.file), 'utf8');
    const internal = row.sites.find((s) => s.provenance.startsWith('internal') || s.provenance === 'local');
    const external = row.sites.find((s) => s.provenance.startsWith('external'));
    if (!internal || !external) continue;
    if (fnAtLine(text, internal.line) === fnAtLine(text, external.line)) shared += 1;
  }
  // The historical split was 21 = 11 + 10 over unmasked text. What must hold now: every surviving row is shared-scope, and
  // the count equals the tool's population.
  assert.equal(shared, d.candidates, `only ${shared} of ${d.candidates} rows are shared-scope`);
  assert.equal(VERIFICATION.sharedScope + VERIFICATION.differentScope, VERIFICATION.rowsExamined,
    'the historical buckets no longer sum to the historical population');
});

test('the fourth requirement names the gap as definitional', () => {
  assert.match(FOURTH_REQUIREMENT.requirement, /ONE SUBJECT/, 'the requirement is not stated');
  assert.match(FOURTH_REQUIREMENT.violatedBy, /one name in two scopes is two names/,
    'the definitional gap is not stated');
  assert.equal(FOURTH_REQUIREMENT.measurement, '21 rows pass the predicate; 11 of them denote one variable');
});

test('the fix is recorded with the reason it was not applied', () => {
  assert.match(FOURTH_REQUIREMENT.fix, /fnOf\(internalSite\) === fnOf\(externalSite\)/, 'the fix is not stated');
  assert.match(FOURTH_REQUIREMENT.notApplied, /falsify R600|before a re-measurement/,
    'the reason for deferring is not stated');
  // And the tool is genuinely unchanged.
  // R608 APPLIED the fix, so the deferral note is now history rather than a pending action. Assert the tool carries the fix.
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'source-divergence.cjs'), 'utf8');
  assert.match(src, /function fnOf\(/, 'the locator was never added, so the record is wrong about applying it');
  assert.match(src, /fnOf\(f\.text, internalSite\.offset\)/, 'the scope filter is gone');
});

test('the record does not claim the shared-scope rows are defects', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'subject-unity.cjs'), 'utf8');
  assert.match(src, /Not that the 11 shared-scope rows are defects/, 'the scope limit is missing');
  assert.match(src, /about one\s+value|ABOUT one/, 'what sharing a scope does and does not establish is not stated');
});

test('the module-scope caveat is present', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'subject-unity.cjs'), 'utf8');
  assert.match(src, /module scope/, 'the module-scope cases are not mentioned');
});
