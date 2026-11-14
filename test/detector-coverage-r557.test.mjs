// R557: four detectors, four "no defects" — so measure the detectors before believing them.
//
// THE PROBLEM WITH FOUR ZEROS IN A ROW
//   R553 built `duplicated-lists`, R554 `list-skeleton-divergence`, R555 `presence-test-divergence`, R556
//   `member-branch-divergence`. Every one concluded "not a defect". A detector that finds nothing is either right or
//   blind, and the difference is COVERAGE — how much of its stated subject it can classify. R555's presence detector
//   reached 13 of 161 sites (8%) and said so only in prose, which is the same failure this session keeps recording:
//   a pattern that does not describe the input, with its output trusted anyway.
//
// MEASURED
//       detector                   examined / denominator   ratio   findings
//       duplicated-lists            1667 / 1667            100%     31
//       list-skeleton-divergence     162 /  162            100%     31 -> 4 after repair
//       presence-test-divergence      13 /  162              8%      0
//       member-branch-divergence     117 /  162             72%     16
//
//   Two of the four classify everything. One classifies 8%, so its zero means "zero within 8%".
//
// AND THE MEASUREMENT FOUND A DEFECT IN THE DETECTOR ITSELF
//   `list-skeleton-divergence` reported 31 of 31 groups — every list it examined. That is the signature of a rule that
//   cannot fail, and reading the worst group showed why: `['alpha','beta']` are synthetic fixture NAMES, and nineteen
//   different tests use them to mean "two servers". `const init = control({… sdkMcpServers: […]})` and
//   `for (const n of […]) handles[n] = await runtime.register(…)` are not two spellings of one operation.
//
//   Two filters were added, and both came from reading cases rather than from theory:
//     1. leading token — variants whose skeletons start differently are doing different jobs
//     2. loop variable name — `delete env[k]` and `delete env[key]` are one operation, not two
//   The count went 31 -> 5 -> 4, and the remaining four are genuine (different assertion messages in one, different
//   surrounding context in the others).
//
// WHAT IS NOT CLAIMED
//   Not that 4 is the true number of divergences: the filters are heuristics, and a real divergence that also changes
//   the leading token would now be hidden. That is the cost of narrowing, taken deliberately and recorded here.
//   Not that `presence-test-divergence`'s 8% makes its zero worthless: 148 of the 161 sites iterate a list without
//   ever testing a value, so there is nothing for it to compare. The 8% is the whole population it can speak about.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const run = (tool, args = []) => spawnSync(process.execPath, [path.join(ROOT, 'tools', tool), ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

let coverage = null;
function cov() {
  if (coverage) return coverage;
  const r = run('detector-coverage.cjs', ['--json']);
  assert.equal(r.status, 0, 'the coverage tool failed:\n' + (r.stderr || '').slice(0, 800));
  coverage = JSON.parse(r.stdout);
  return coverage;
}

test('every detector reports a denominator and an examined count', () => {
  const d = cov();
  assert.equal(d.rows.length, 4, `expected 4 detectors, found ${d.rows.length}`);
  for (const r of d.rows) {
    assert.ok(r.denominator > 0, `${r.detector} has no denominator, so its findings cannot be interpreted`);
    assert.ok(r.examined <= r.denominator, `${r.detector} claims to examine more than exists`);
  }
  assert.ok(d.codeSites > 100, `only ${d.codeSites} code sites: the shared source is not being read`);
});

test('the detector with narrow coverage is identified rather than left implicit', () => {
  const d = cov();
  const presence = d.rows.find((r) => r.detector === 'presence-test-divergence');
  assert.ok(presence, 'the presence detector is missing from the coverage report');
  const ratio = presence.examined / presence.denominator;
  assert.ok(ratio < 0.25,
    `presence coverage is now ${(ratio * 100).toFixed(0)}%: if it widened, the recorded 8% is stale`);
  // And the reason must be stated, not just the number.
  assert.match(presence.note, /no presence test/, 'the coverage gap is reported without its cause');
});

test('the skeleton detector no longer flags every group it examines', () => {
  // 31 of 31 was the signature of a rule that cannot fail.
  const sk = run('list-skeleton-divergence.cjs', ['--json']);
  assert.equal(sk.status, 0, 'the skeleton detector failed');
  const d = JSON.parse(sk.stdout);
  assert.ok(d.listsExamined > 10, 'not enough lists examined for this to mean anything');
  assert.ok(d.withDivergence < d.listsExamined,
    `all ${d.listsExamined} groups are flagged again: the filters are gone`);
  assert.ok(d.withDivergence > 0, 'no group is flagged at all, which would mean the filters ate everything');
});

test('the two filters that narrowed the skeleton detector are present and explained', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'list-skeleton-divergence.cjs'), 'utf8');
  assert.match(src, /function leadingToken/, 'the leading-token filter is gone');
  assert.match(src, /THE LOOP VARIABLE NAME IS NOT PART OF THE OPERATION/,
    'the loop-variable normalisation is not explained');
  assert.match(src, /nineteen different tests use them to mean "two servers"|fixture NAMES/,
    'the case that motivated the filter is not recorded');
});

test('a rename is not a divergence', () => {
  // The concrete pair: `delete env[k]` vs `delete env[key]`.
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'list-skeleton-divergence.cjs'), 'utf8');
  // The normalisation must replace the loop variable at its declaration AND at its uses.
  assert.match(src, /split\(`const\$\{name\}of`\)/, 'the declaration is not normalised');
  assert.match(src, /split\(`\[\$\{name\}\]`\)/, 'subscript uses are not normalised');
});

test('the member-branch detector still covers most of the denominator', () => {
  const d = cov();
  const branch = d.rows.find((r) => r.detector === 'member-branch-divergence');
  const ratio = branch.examined / branch.denominator;
  assert.ok(ratio > 0.5, `member-branch coverage fell to ${(ratio * 100).toFixed(0)}%`);
});

test('the coverage tool records that its own thresholds are heuristics', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'list-skeleton-divergence.cjs'), 'utf8');
  assert.match(src, /the cost of narrowing|taken deliberately|heuristic/i,
    'the narrowing cost is not recorded at the detector');
});
