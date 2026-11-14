// R613: R611 said two tools sort with a non-total comparator. There are four — and the weakest order is the one R611 never
// looked at.
//
// THE CORRECTION
//   A full scan of the same eight tools finds FIVE that sort:
//
//       source-divergence   a.file || a.name           TOTAL      0 tied groups
//       set-lifetimes       a.file                     ONE KEY    6 groups of 32 files
//       set-key-symmetry    rank || a.file             TWO KEYS   2 groups
//       set-reset-reach     tier || a.file             TWO KEYS   6 groups
//       map-key-reach       score || a.file            TWO KEYS  31 groups
//
//   Four of five leave ties undecided, not two. R611's `map-key-reach` figure of 31 was right and is the largest; what it missed
//   was three more tools with the same shape at smaller scale.
//
// THE WORST IS THE ONE R611 DID NOT LOOK AT
//   `set-lifetimes` sorts by FILE ALONE. Every set in one file ties, so intra-file order is entirely input order — no rank, no
//   secondary key. Six of its 32 files hold more than one set; `tools/unhandled-called.cjs` holds three.
//
//   The tool with the MOST ties and the tool with the LEAST ordering are different tools, and R611 named only the first.
//
// `source-divergence` IS THE MODEL
//   Three keys already, zero tied groups. That is the shape the other four would take with one added term — and it is the argument
//   for the fix rather than an abstract preference: one tool in this set already does it.
//
// WHY STILL NOT APPLIED
//   Same reason R608 and R611 gave, now with a wider blast radius: four outputs would reorder, and R591/R593/R594/R611 quote rows by
//   position or by "the first one". It needs a round that re-reads all four.
//
// WHAT IS NOT CLAIMED
//   Not that tied groups are a defect count: set-key-symmetry's 2 are two files holding two sets each at one rank, which is
//   ordinary. The number measures how much order is left to chance, not how wrong anything is.
//   Not that a total order is always better: set-lifetimes sorting only by file may be deliberate — the file IS the grouping. The
//   finding is that intra-file order is unowned, not that name order would mean something.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SORTING, CORRECTION } from '../desktop/sort-census.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runJson = (tool) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', tool), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `${tool} failed:\n` + (r.stderr || '').slice(0, 400));
  return JSON.parse(r.stdout);
};

const ties = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r.name || r.file);
  }
  return [...m.values()].filter((v) => v.length > 1);
};

test('all five sort sites still exist with the recorded keys', () => {
  const expects = [
    { file: 'source-divergence.cjs', fragment: 'a.file.localeCompare(b.file) || a.name.localeCompare(b.name)' },
    { file: 'set-lifetimes.cjs', fragment: 'a.file.localeCompare(b.file)' },
    { file: 'set-key-symmetry.cjs', fragment: 'Number(b.deletes > 0 && !b.agrees)' },
    { file: 'set-reset-reach.cjs', fragment: 'order[a.tier] - order[b.tier]' },
    { file: 'map-key-reach.cjs', fragment: 'score(b) - score(a)' },
  ];
  for (const e of expects) {
    const src = fs.readFileSync(path.join(ROOT, 'tools', e.file), 'utf8');
    assert.ok(src.includes(e.fragment), `${e.file} no longer sorts by ${e.fragment}`);
  }
});

test('set-lifetimes still sorts by file alone, and its tie count is 6 of 32', () => {
  const d = runJson('set-lifetimes.cjs');
  const groups = ties(d.rows, (r) => r.file);
  const row = SORTING.find((s) => s.tool.endsWith('set-lifetimes.cjs'));
  assert.equal(groups.length, row.tiedGroups, `the tool now has ${groups.length} tied files`);
  assert.equal(new Set(d.rows.map((r) => r.file)).size, row.ofFiles, 'the file count moved');
  assert.equal(row.keys.length, 1, 'set-lifetimes gained a key');
});

test('the widest set-lifetimes tie is the recorded three-set file', () => {
  const d = runJson('set-lifetimes.cjs');
  const groups = new Map();
  for (const r of d.rows) {
    if (!groups.has(r.file)) groups.set(r.file, []);
    groups.get(r.file).push(r.name);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const row = SORTING.find((s) => s.tool.endsWith('set-lifetimes.cjs'));
  const widest = sorted[0][1].length;
  const widestFiles = sorted.filter(([, names]) => names.length === widest).map(([file]) => file).sort();
  const recorded = row.worst.map((w) => w.file).sort();
  assert.deepEqual(widestFiles, recorded, 'the set of widest files changed');
  assert.equal(widest, row.worstCount, 'the widest group size changed');
  // They tie on COUNT, not content — each file&apos;s set names are recorded individually.
  for (const w of row.worst) {
    const entry = sorted.find(([file]) => file === w.file);
    assert.ok(entry, w.file + ' is no longer a widest file');
    assert.deepEqual([...entry[1]].sort(), [...w.sets].sort(), w.file + ' holds different sets');
  }
});

test('source-divergence is the total order with zero ties', () => {
  const d = runJson('source-divergence.cjs');
  const groups = ties(d.rows, (r) => `${r.file}|${r.name}`);
  assert.equal(groups.length, 0, 'source-divergence now has ties, so it is no longer the model');
  const row = SORTING.find((s) => s.tool.endsWith('source-divergence.cjs'));
  assert.equal(row.total, true);
  assert.equal(row.keys.length, 2, 'source-divergence no longer has both keys');
});

test('the remaining two counts match', () => {
  const k = runJson('set-key-symmetry.cjs');
  const kGroups = ties(k.rows, (r) => `${Number(r.deletes > 0 && !r.agrees)}|${r.file}`);
  assert.equal(kGroups.length, SORTING.find((s) => s.tool.endsWith('set-key-symmetry.cjs')).tiedGroups);

  const sr = runJson('set-reset-reach.cjs');
  const srGroups = ties(sr.rows, (r) => `${r.tier}|${r.file}`);
  assert.equal(srGroups.length, SORTING.find((s) => s.tool.endsWith('set-reset-reach.cjs')).tiedGroups);
});

test('the correction names what R611 missed and why', () => {
  assert.match(CORRECTION.r611Said, /two tools/, 'the original claim is not quoted');
  assert.equal(CORRECTION.missed.length, 3, 'the missed tools are not all listed');
  assert.match(CORRECTION.why, /without enumerating/, 'the cause is not stated');
  assert.match(CORRECTION.worst, /file alone/, 'the weakest order is not identified');
});

test('the record refuses to call ties a defect count', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'sort-census.cjs'), 'utf8');
  assert.match(src, /Not that tied groups are a defect count/, 'the count caveat is missing');
  assert.match(src, /Not that a total order is always better/, 'the design caveat is missing');
});
