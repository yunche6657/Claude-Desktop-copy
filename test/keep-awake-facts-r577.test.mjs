// R577: the largest repeated list, read on both sides. The key held — and the two sides use it asymmetrically.
//
// WHAT WAS CHECKED
//   R576's ledger marked `duplicated-lists` as `sound` but noted its key had never been challenged since R553. So this round
//   took the LARGEST group — 12 members, 2 sites — and read every site:
//
//       desktop/keep-awake-activity.cjs:6    const REQUIRED = ['remoteClient', 'violinBow', …];
//       test/keep-awake-activity-r378:17     const keys     = ['remoteClient', 'violinBow', …];
//
//   This is a legitimate shared list. The test enumerates all 4096 boolean combinations and asserts `activityKind` agrees
//   with the original bundle's `sessionActivityKind` for each, which it cannot do without naming all twelve facts. The key
//   held.
//
// THE ASYMMETRY, WHICH IS THE FINDING
//       production   REQUIRED.some(key => typeof facts[key] !== 'boolean')            ORDER DOES NOT MATTER
//       test         keys.map((key, index) => [key, Boolean(mask & (1 << index))])    ORDER MATTERS — index IS the bit
//
//   A production reorder changes which fact each bit means. The test would still pass, because it builds its expectation
//   from the same permuted list — a silently different test rather than a failing one. Both orders match today; neither
//   side records that the order is load-bearing.
//
// THE DETECTOR, AND WHY IT WAS NARROWED ONCE
//   `tools/index-order-lists.cjs` looks for repeated lists walked by index on one side and not the other.
//
//     first version: does the FILE contain `.map((x, i)`  -> 37 of 102 groups, almost all the file's unrelated code
//     scoped to 12 lines after the site                   -> 3 groups
//
//   Of the three, one is this case, one is a proof-script deletion list (order cannot matter, since the body is
//   `delete env[k]`), and one is a false positive: both `script-index.cjs` sites are `for (const key of […])` and the window
//   caught an unrelated `.entries()` twelve lines below. Recorded rather than patched again, per R571's lesson that a rule
//   patched a third time starts inventing shapes.
//
// WHAT IS NOT CLAIMED
//   Not that the check would catch a production reorder — it would not, and nothing else would either. What this round adds
//   is the record that the order is load-bearing, at the place where someone might reorder.
//   Not that the other two hits are hazards: one is order-independent by its body, one is a false positive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KEEP_AWAKE_FACTS } from '../desktop/keep-awake-facts.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'index-order-lists.cjs');

/** The list contents at a site, in file order. */
function orderIn(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = /(?:const|let)\s+(?:REQUIRED|keys)\s*=\s*\[([\s\S]{0,400}?)\]/.exec(text);
  assert.ok(m, `${file} no longer declares the list`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

test('both sides still carry the same twelve facts, in the same order', () => {
  const prod = orderIn(KEEP_AWAKE_FACTS.production.file);
  const test_ = orderIn(KEEP_AWAKE_FACTS.test.file);
  assert.deepEqual(prod, KEEP_AWAKE_FACTS.members, 'the production list changed shape');
  assert.deepEqual(test_, KEEP_AWAKE_FACTS.members, 'the test list changed shape');
  assert.deepEqual(prod, test_,
    'the two orders diverged: the test now enumerates a different bit-to-fact mapping');
});

test('the order matters on the test side and not the production side', () => {
  const prod = fs.readFileSync(path.join(ROOT, KEEP_AWAKE_FACTS.production.file), 'utf8');
  const test_ = fs.readFileSync(path.join(ROOT, KEEP_AWAKE_FACTS.test.file), 'utf8');
  assert.match(prod, /REQUIRED\.some\(/, 'the production use is no longer a completeness check');
  assert.match(test_, /1\s*<<\s*index/, 'the test no longer builds its bit mask from the index');
  assert.equal(KEEP_AWAKE_FACTS.production.orderMatters, false);
  assert.equal(KEEP_AWAKE_FACTS.test.orderMatters, true);
});

test('the enumerated combination count matches the list length', () => {
  // 4096 in the record; if a thirteenth fact is added the number must change with it.
  assert.equal(KEEP_AWAKE_FACTS.combinations, 2 ** KEEP_AWAKE_FACTS.members.length);
  const test_ = fs.readFileSync(path.join(ROOT, KEEP_AWAKE_FACTS.test.file), 'utf8');
  assert.match(test_, new RegExp(`2 \\*\\* keys\\.length|mask < 2 \\*\\*`),
    'the test no longer enumerates 2**length combinations');
});

test('the detector is scoped to the site, not the file', () => {
  // The correction that took 37 groups to 3.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /function readsByIndex\(text, line\)/, 'the site-scoped signature is gone');
  assert.match(src, /37 of 102 groups/, 'the file-scoped result is not recorded');
});

test('the detector finds this case and reports few others', () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the audit failed:\n' + (r.stderr || '').slice(0, 600));
  const d = JSON.parse(r.stdout);
  assert.ok(d.asymmetric > 0, 'no asymmetric list found, which contradicts the keep-awake case');
  assert.ok(d.asymmetric < 10,
    `${d.asymmetric} asymmetric groups: the check has widened back toward the file scope`);
  const hit = d.rows.find((x) => x.members.includes('violinBow'));
  assert.ok(hit, 'the keep-awake list is not reported');
  assert.ok(hit.indexed.some((s) => s.includes('keep-awake-activity-r378')),
    'the indexed side is not identified as the test');
});

test('the surviving false positive is recorded rather than patched away', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'keep-awake-facts.cjs'), 'utf8');
  assert.match(src, /false positive/, 'the false positive is not recorded');
  assert.match(src, /script-index\.cjs/, 'the file it occurs in is not named');
  assert.match(src, /R571|patched a third time|patched again/, 'the reason for leaving it is missing');
});

test('the record does not claim the test would catch a reorder', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'keep-awake-facts.cjs'), 'utf8');
  assert.match(src, /would still pass|silently different test/,
    'the hazard is described in the wrong direction');
  assert.match(src, /nothing else would either|would not/, 'the limit is not stated');
});
