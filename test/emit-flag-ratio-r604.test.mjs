// R604: R603 split mechanical changes into widening and narrowing. That label was a proxy. The quantity it stood in for is
// EMITTED/FLAGGED, and it reclassifies R601.
//
// THE MEASUREMENT (each tool run with --json)
//       round  tool                emitted  flagged  ratio
//       R590   set-lifetimes           41       41   1.00
//       R591   set-reset-reach         41        4   0.10
//       R593   set-key-symmetry        22        0   0.00
//       R594   map-key-reach          202       55   0.27
//       R595   clear-asymmetry          1        1   1.00
//       R600   source-divergence       21       21   1.00
//       R601   stale-comment          415        2   0.005   ← the outlier
//       R602   denial-vs-witness       14       14   1.00
//
// WHY THE RATIO REPLACES THE LABEL
//   R603 called R601 "narrowing" because its judgement is a verdict. But a verdict delivered on 2 of 415 rows is not what makes
//   output untrustworthy — untrustworthy is when a reader cannot tell a finding from a non-finding, which needs the FLAGGED
//   FRACTION to be large.
//
//   At 0.005 a reader ignores 413 rows and reads two. At 1.00 every row demands attention, so a wrong row costs as much as a
//   right one. R591 at 0.10 and R594 at 0.27 sit between: small enough to skim, large enough that the flagged set is the whole
//   bottleneck.
//
// THE THREE REGIMES
//       ratio ≈ 1.00      every row is the answer; the tool IS its list. Population must therefore be small — R595 emits 1,
//                         R600 emits 21. A tool that flags everything has to narrow the POPULATION first.
//       0.05 – 0.5        a ranked shortlist. Both failure modes apply.
//       < 0.01            an inventory with an annotation. Precision can be poor without harm.
//
// WHAT IS NOT CLAIMED
//   Not that the middle band is always bad: R594's 55 keys were each read and all 55 were false. The ratio predicted the COST
//   correctly; it did not cause the outcome.
//   Not that these ratios are stable: they move with the tree. R591 reports 4 of 41 today and reported 4 of 38 when written,
//   because three comma-form declarations have been visible since R596.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RATIOS, RECLASSIFICATION } from '../desktop/emit-flag-ratio.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runJson = (tool) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', tool), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `${tool} failed:\n` + (r.stderr || '').slice(0, 500));
  return JSON.parse(r.stdout);
};

test('every recorded count matches the tool that produces it', () => {
  // Each entry names the JSON key its `emitted` count comes from, so a drifting tool is caught rather than trusted.
  const keys = {
    'set-lifetimes': (d) => d.sets,
    'set-reset-reach': (d) => d.total,
    'set-key-symmetry': (d) => d.sets,
    'map-key-reach': (d) => d.maps,
    'clear-asymmetry': (d) => d.pairs,
    'source-divergence': (d) => d.candidates,
    'stale-comment': (d) => d.total,
    'denial-vs-witness': (d) => d.rows.length,
  };
  for (const row of RATIOS) {
    const d = runJson(row.tool + '.cjs');
    assert.equal(keys[row.tool](d), row.emitted,
      `${row.round} ${row.tool}: recorded ${row.emitted}, tool reports ${keys[row.tool](d)}`);
  }
});

test('the flagged counts match too, where the tool exposes one', () => {
  const flaggedOf = {
    'set-reset-reach': (d) => d.rows.filter((r) => r.tier !== 'none').length,
    'map-key-reach': (d) => d.disagrees,
    'stale-comment': (d) => d.stale,
    'denial-vs-witness': (d) => d.rows.length,
    'set-lifetimes': (d) => d.sets,
    'source-divergence': (d) => d.candidates,
    'clear-asymmetry': (d) => d.pairs,
  };
  for (const row of RATIOS) {
    const fn = flaggedOf[row.tool];
    if (!fn) continue;
    const d = runJson(row.tool + '.cjs');
    assert.equal(fn(d), row.flagged,
      `${row.round} ${row.tool}: recorded flagged ${row.flagged}, tool reports ${fn(d)}`);
  }
});

test('R601 is the only inventory below 0.01', () => {
  const ratios = RATIOS.map((r) => ({ ...r, ratio: r.emitted ? r.flagged / r.emitted : 0 }));
  // A ratio below 0.01 is only an inventory when the emitted population is large enough that skimming is the point.
  // A small population at a low ratio is just a small population.
  const below = ratios.filter((r) => r.ratio < 0.01 && r.emitted > 100);
  assert.equal(below.length, 1, `${below.length} tools are inventories now, not the recorded one`);
  assert.equal(below[0].round, 'R601');
  assert.equal(RECLASSIFICATION.outlier, 'R601 is the only tool below 0.01');
});

test('the reclassification states what replaces the old label', () => {
  assert.match(RECLASSIFICATION.r603Said, /narrows|verdict/, 'the old label is not quoted');
  assert.match(RECLASSIFICATION.actual, /415 rows and flags 2/, 'the actual numbers are not stated');
  assert.match(RECLASSIFICATION.why, /FLAGGED fraction/, 'the replacing quantity is not named');
});

test('every row carries a regime and the regimes are the three named ones', () => {
  const allowed = new Set(['is-the-list', 'shortlist', 'inventory-plus-flag', 'empty-flag']);
  for (const r of RATIOS) assert.ok(allowed.has(r.regime), `${r.round} has regime ${r.regime}`);
  // The relationship the regimes encode: "is-the-list" rows must be small populations.
  for (const r of RATIOS.filter((x) => x.regime === 'is-the-list')) {
    assert.ok(r.emitted <= 50, `${r.round} flags everything over ${r.emitted} rows, so the regime claim fails`);
  }
});

test('the record refuses to call the middle band a defect', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'emit-flag-ratio.cjs'), 'utf8');
  assert.match(src, /Not that the middle band is always bad/, 'the middle-band caveat is missing');
  assert.ok(/predicts: 'the COST/.test(src), 'what the ratio does and does not predict is not stated');
});

test('the instability of the counts is declared', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'emit-flag-ratio.cjs'), 'utf8');
  assert.match(src, /Not that these ratios are stable/, 'the stability caveat is missing');
  assert.match(src, /4 of 38|comma-form/, 'the concrete drift example is missing');
});
