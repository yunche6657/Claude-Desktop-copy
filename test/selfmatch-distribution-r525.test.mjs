// R525: distribution drift is now compared, because membership comparison could not see R524's change.
//
// WHAT SLIPPED THROUGH
//   R524 changed the dedup key from (binding, offset, pattern) to (offset, pattern). One call site had been reported
//   twice — once per readFileSync binding in scope — so nine rows disappeared from `fixture` and appeared in
//   `not-self`. Total stayed 97. No row appeared or vanished as an individual.
//
//   The baseline comparison passed, because it compares MEMBERSHIP: which (file, pattern, offset) keys exist. Every
//   key that remained was matched to a counterpart; nothing was added, escalated or lost. The distribution had moved
//   by nine and the report was green.
//
//   A count per verdict is not a redundant view of the same rows — it is the only view that sees a redistribution
//   with a constant total. Three distinct changes are invisible to membership and visible here:
//     - a dedup or finder change that merges rows without removing any distinct key
//     - a classifier change that moves N rows from one verdict to another
//     - any change that keeps the total but reshuffles it
//
// WHAT WAS MEASURED
//   1. same rows, stored distribution says fixture 15 / not-self 76   -> exit 1, reports the two deltas, NEW and
//                                                                        VANISHED both remain 0
//   2. control with a consistent distribution                          -> exit 0
//   3. stored distribution omits a category that exists now            -> exit 1, names `filtered: 0 -> 3`
//
// IT FAILS THE CHECK, NOT JUST THE REPORT
//   A warning printed next to a green exit would be absorbed the same way the nine rows were. Distribution drift
//   sets exit 1 for the same reason a vanished row does: a change a green report would hide.
//
// WHAT IS NOT CLAIMED
//   Not that every distribution change is a defect: a legitimate reclassification should move the counts, and the
//   remedy is to re-baseline after review — the failure message says so. Not that the counts are independent of the
//   rows: they are derived from the same scan, so a finder bug that mislabels everything consistently would still
//   match a baseline built from the same broken finder. The gate detects change, not correctness.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'comment-selfmatch.cjs');
const BASE = path.join(ROOT, 'evidence', 'SELFMATCH-BASELINE.json');
const TMP = path.join(ROOT, '..', '.tmp');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

// This file is itself scanned; refresh the baseline so its own rows are not read as drift.
test.before(() => { run(['--baseline-write']); });

const baseline = () => JSON.parse(fs.readFileSync(BASE, 'utf8'));

function checkWith(rows, byReason, tag) {
  const b = baseline();
  const p = path.join(TMP, `r525-${tag}.json`);
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...b, rows, byReason }, null, 2), 'utf8');
  try {
    const r = run(['--baseline-check', '--baseline', p]);
    return { status: r.status, out: r.stdout || '' };
  } finally {
    fs.rmSync(p, { force: true });
  }
}

test('the baseline records a per-verdict distribution', () => {
  const b = baseline();
  assert.ok(b.byReason && typeof b.byReason === 'object', 'the baseline has no byReason map');
  const sum = Object.values(b.byReason).reduce((a, x) => a + x, 0);
  assert.equal(sum, b.rows.length,
    `byReason sums to ${sum} but there are ${b.rows.length} rows: the stored distribution is already inconsistent`);
});

test('a changed distribution with identical rows fails the check', () => {
  // R524's exact shape: nine rows left `fixture`, no row appeared or vanished.
  const b = baseline();
  const stale = { ...b.byReason, fixture: (b.byReason.fixture || 0) + 9 };
  const moved = Object.keys(stale).find((k) => k !== 'fixture' && stale[k] > 9);
  stale[moved] -= 9;

  const d = checkWith(b.rows, stale, 'dist');
  assert.equal(d.status, 1, 'a redistributed-but-same-membership scan set passed the check');
  assert.match(d.out, /DISTRIBUTION: \d+ verdict category change/,
    'the drift was not reported as a distribution change');
  assert.match(d.out, /fixture: \d+ -> \d+/, 'the fixture delta is not named');
  // Membership must be untouched, which is what makes this a distribution-only finding.
  assert.match(d.out, /NEW: 0/);
  assert.match(d.out, /VANISHED: 0/);
});

test('a consistent distribution passes', () => {
  const b = baseline();
  const d = checkWith(b.rows, b.byReason, 'ok');
  assert.equal(d.status, 0, 'a consistent baseline failed:\n' + d.out);
});

test('a category missing from the stored distribution is reported', () => {
  const b = baseline();
  const partial = { ...b.byReason };
  const victim = Object.keys(partial).find((k) => partial[k] > 0);
  delete partial[victim];
  const d = checkWith(b.rows, partial, 'miss');
  assert.equal(d.status, 1, 'a missing category passed the check');
  assert.match(d.out, new RegExp(`${victim}: 0 -> \\d+`),
    `the missing category ${victim} is not named with its recovered count`);
});

test('the failure message distinguishes drift from defect', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /Drift is not automatically a/,
    'the failure message no longer says drift may be intended');
  assert.match(source, /re-baseline|Re-run --baseline-write/,
    'the message no longer says how to accept an intended change');
  // And the exit must actually carry it, not just the prose.
  assert.match(source, /reasonDrift\.length > 0/,
    'the distribution drift no longer participates in mustFail');
});

test('the rationale for a separate distribution comparison is recorded', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /DISTRIBUTION DRIFT, WHICH MEMBERSHIP COMPARISON CANNOT SEE/,
    'the rationale heading is gone');
  assert.match(source, /fixture` fell from 15 to 6/,
    'the concrete instance that motivated this is no longer recorded');
  assert.match(source, /Membership comparison alone would stay green/,
    'the report no longer explains why membership alone is insufficient');
});
