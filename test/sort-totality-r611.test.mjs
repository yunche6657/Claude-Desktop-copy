// R611: two tools sort with a comparator that is not a total order. Output is stable in practice; nothing guarantees it.
//
// THE COMPARATORS
//       map-key-reach    score(b) - score(a) || a.file.localeCompare(b.file)
//       set-reset-reach  order[tier] - order[tier] || a.file.localeCompare(b.file)
//
//   Both use TWO keys: a rank, then the file. Two rows of the same rank in the SAME FILE compare equal, so the comparator returns
//   0 and their order is whatever the sort's stability preserves — the input order.
//
// MEASURED
//       map-key-reach   31 groups hold more than one set at one score in one file
//       the worst       session-kernel.cjs at score 0 — 18 sets in one group
//
//   In those 31 groups the intra-group order is decided by input order alone. A reader who takes "the first row" of such a group
//   is reading the filesystem's opinion.
//
// WHY IT IS STABLE ANYWAY, AND WHY THAT IS NOT A GUARANTEE
//       V8's Array.prototype.sort is stable, so equal rows keep input order
//       readdirSync returns the same order on the same directory of the same filesystem
//
//   Measured: three consecutive runs of each of four tools produce byte-identical output, and two readdirSync calls in one process
//   agree. Both facts are environmental. A different Node version, a network volume, or a copied tree can reorder the ties — and
//   no test would notice, because no test asserts an order at all.
//
// THE FIX IS ONE TERM, DEFERRED
//   Adding `|| a.name.localeCompare(b.name)` makes both comparators total. Deferred for R608's reason: changing the order moves
//   every recorded position, and three rounds quote rows by index or by "the first one".
//
// WHAT IS NOT CLAIMED
//   Not that the current output is wrong: it is deterministic here and now, and every consumer reads all rows.
//   Not that a third key is always wanted: within a `set-reset-reach` tier the name is arguably meaningless and grouping by file is
//   the intent. The point is that the order WITHIN A FILE is unowned.
//   Not that only these two sort: `stale-comment` and `source-divergence` build rows in scan order and never sort, so their order is
//   filesystem order plus declaration order — the same dependency without even a comparator to inspect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMPARATORS, STABILITY, FIX } from '../desktop/sort-totality.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runJson = (tool) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', tool), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `${tool} failed:\n` + (r.stderr || '').slice(0, 400));
  return JSON.parse(r.stdout);
};

test('the comparators still have only two keys', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'map-key-reach.cjs'), 'utf8');
  assert.match(src, /return score\(b\) - score\(a\) \|\| a\.file\.localeCompare\(b\.file\);/,
    'the map-key-reach comparator changed — re-measure the ties');
  assert.ok(!/a\.name\.localeCompare/.test(src), 'the third key was added, so the deferral note is stale');

  const src2 = fs.readFileSync(path.join(ROOT, 'tools', 'set-reset-reach.cjs'), 'utf8');
  assert.match(src2, /order\[a\.tier\] - order\[b\.tier\] \|\| a\.file\.localeCompare\(b\.file\)/,
    'the set-reset-reach comparator changed');
  assert.ok(!/a\.name\.localeCompare/.test(src2), 'the third key was added there too');
});

test('the 31 tied groups are still 31', () => {
  const d = runJson('map-key-reach.cjs');
  const score = (r) => (r.readKey === null ? 0 : (r.agrees ? 0 : 2) + (r.unstableSet ? 3 : 0));
  const groups = new Map();
  for (const r of d.rows) {
    const k = score(r) + '|' + r.file;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.name);
  }
  const tied = [...groups.values()].filter((names) => names.length > 1);
  assert.equal(tied.length, COMPARATORS[0].groupsWithTies,
    `the tool now has ${tied.length} tied groups, record says ${COMPARATORS[0].groupsWithTies}`);
});

test('the widest tie is the recorded 18 in session-kernel', () => {
  const d = runJson('map-key-reach.cjs');
  const score = (r) => (r.readKey === null ? 0 : (r.agrees ? 0 : 2) + (r.unstableSet ? 3 : 0));
  const groups = new Map();
  for (const r of d.rows) {
    const k = score(r) + '|' + r.file;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.name);
  }
  let widest = { key: null, n: 0 };
  for (const [k, names] of groups) if (names.length > widest.n) widest = { key: k, n: names.length };
  assert.equal(widest.key, `${COMPARATORS[0].worst.score}|${COMPARATORS[0].worst.file}`,
    'the widest tie moved to a different group');
  assert.equal(widest.n, COMPARATORS[0].worst.sets);
});

test('output is currently byte-identical across runs, which is the measured fact', () => {
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'map-key-reach.cjs')], {
      cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
    });
    runs.push(r.stdout);
  }
  assert.equal(runs[0], runs[1], 'run 1 and 2 differ — the order is already unstable');
  assert.equal(runs[1], runs[2], 'run 2 and 3 differ');
});

test('the stability rests on two named environmental facts', () => {
  assert.equal(STABILITY.dependsOn.length, 2);
  assert.match(STABILITY.dependsOn[0], /stable/, 'the sort-stability dependency is not named');
  assert.match(STABILITY.dependsOn[1], /readdirSync/, 'the readdirSync dependency is not named');
  assert.match(STABILITY.unaudited, /no test asserts row order/, 'the absence of an order test is not stated');
});

test('the fix is one term and the deferral gives a reason', () => {
  assert.equal(FIX.term, '|| a.name.localeCompare(b.name)');
  assert.match(FIX.deferredBecause, /moves every recorded position/, 'the deferral reason is not stated');
});

test('the record does not claim the current output is wrong', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'sort-totality.cjs'), 'utf8');
  assert.match(src, /Not that the current output is wrong/, 'the scope limit is missing');
  assert.match(src, /within a `set-reset-reach` tier the name is arguably meaningless|cannot inspect|unowned/,
    'the counter-argument to a third key is missing');
});

test('the tools that never sort are named too', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'sort-totality.cjs'), 'utf8');
  assert.match(src, /stale-comment/, 'the never-sorted tools are not named');
  assert.match(src, /filesystem order plus declaration order|same dependency/, 'their dependency is not described');
});
