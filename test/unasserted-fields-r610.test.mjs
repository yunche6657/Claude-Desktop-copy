// R610: ten fields across eight tools are computed and never asserted. The one that looked contradictory is a correct
// definition nobody pinned.
//
// THE METHOD
//   For each tool: take the field names of its `--json` rows, subtract the names its test files mention. The remainder is what
//   the tool computes that nothing checks.
//
//       R590 set-lifetimes      declaredAt
//       R591 set-reset-reach    declaredAt
//       R593 set-key-symmetry   declaredAt, adds
//       R594 map-key-reach      declaredAt, setShape, readOp, readShape + top-level unstableDisagree
//       R595 clear-asymmetry    coMentionLine
//       R601 stale-comment      line + top-level total
//       R600, R602              (none — fully named)
//
//   `declaredAt` dominates because it is display data: a line number a reader uses, never a claim. Benign class.
//
// THE ONE THAT LOOKED WRONG
//   `map-key-reach` reports `unstableDisagree: 6` while 7 rows carry `unstableSet: true`. They are different quantities:
//
//       unstableSet === true   7   the SET key's shape is call / computed / constructed
//       unstableDisagree       6   of those, the ones where the read key also differs
//
//   The seventh is `pending`, whose set and read keys are textually identical (`key(id,origin)` both sides). Its shape is a call
//   so the instability flag fires; its keys agree so the disagreement filter excludes it. Both numbers are right.
//
// WHY PINNING THEM STILL MATTERS
//   `unstableDisagree === count(unstableSet && !agrees)` is derived, and a derived fact no test states can drift silently: any
//   refactor of either filter moves one number and not the other, and a reader comparing them concludes the tool is broken rather
//   than reading the definition. R596's comma bug and R609's mask regression were both found because a number MOVED — a pinned
//   field is what makes movement visible.
//
// THE OTHER FIELDS, CHECKED
//       setShape / readShape   equal to keyShape() on the recorded text for every row — 0 mismatches
//       readOp                 'get' where a .get( exists, 'delete' otherwise — 0 inconsistent
//       adds, coMentionLine, line, total   counts and line numbers, display data
//
// WHAT IS NOT CLAIMED
//   Not that a name appearing in a test file means the field is asserted: the check is textual, so a mention in a comment counts.
//   That inflates coverage — the safe direction here.
//   Not that these ten are the whole gap: implicit properties (a row's absence, the ORDER of rows) are named nowhere and cannot be
//   found this way. `map-key-reach`'s sort is exactly such a property.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UNASSERTED, DERIVED_PAIR } from '../desktop/unasserted-fields.cjs';
import { keyShape } from '../tools/map-key-reach.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const scanMaps = () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'map-key-reach.cjs'), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(0, 400));
  return JSON.parse(r.stdout);
};

test('the derived relation holds exactly', () => {
  const d = scanMaps();
  const computed = d.rows.filter((r) => r.unstableSet && r.readKey !== null && !r.agrees).length;
  assert.equal(computed, d.unstableDisagree,
    `unstableDisagree is ${d.unstableDisagree} but the relation yields ${computed}`);
  assert.equal(d.unstableDisagree, DERIVED_PAIR.counts2);
});

test('the seventh row is the one whose keys agree', () => {
  const d = scanMaps();
  const unstable = d.rows.filter((r) => r.unstableSet);
  assert.equal(unstable.length, DERIVED_PAIR.counts);
  const agree = unstable.filter((r) => r.agrees);
  assert.equal(agree.length, unstable.length - d.unstableDisagree, 'the agreeing unstable rows no longer explain the gap');
  for (const r of agree) {
    assert.equal(r.setKey, r.readKey, `${r.name} is counted as agreeing but its keys differ`);
  }
});

test('setShape and readShape match keyShape on the recorded text', () => {
  // keyShape is imported at the top; ESM modules have no require.
  const mod = { keyShape };
  const d = scanMaps();
  for (const r of d.rows) {
    assert.equal(mod.keyShape(r.setKey), r.setShape, `${r.name}: setShape drifted`);
    if (r.readKey !== null) assert.equal(mod.keyShape(r.readKey), r.readShape, `${r.name}: readShape drifted`);
  }
});

test('readOp matches which method the file actually calls', () => {
  const d = scanMaps();
  for (const r of d.rows) {
    if (!r.readKey || !r.readOp) continue;
    const text = fs.readFileSync(path.join(ROOT, r.file), 'utf8');
    const esc = r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasGet = new RegExp('\\b' + esc + '\\.get\\(').test(text);
    if (hasGet) assert.equal(r.readOp, 'get', `${r.file} ${r.name} has a .get( but readOp is ${r.readOp}`);
  }
});

test('the recorded field list is a subset of what the tools emit', () => {
  // Guard against the record naming a field that no longer exists.
  const d = scanMaps();
  const rowKeys = new Set();
  for (const r of d.rows.slice(0, 40)) for (const k of Object.keys(r)) rowKeys.add(k);
  for (const e of UNASSERTED.filter((x) => x.tool === 'map-key-reach' && !x.top)) {
    for (const f of e.fields) assert.ok(rowKeys.has(f), `map-key-reach no longer emits ${f}`);
  }
});

test('the record states what a pinned field buys', () => {
  assert.match(DERIVED_PAIR.riskIfUnpinned, /changes one number and not the other/, 'the drift risk is not stated');
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'unasserted-fields.cjs'), 'utf8');
  assert.ok(src.includes('being pinned is that its movement'), 'the purpose of pinning is not stated');
});

test('the measurement limits are declared', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'unasserted-fields.cjs'), 'utf8');
  assert.match(src, /Not that a name appearing in a test file means the field is asserted/, 'the textual-check caveat is missing');
  assert.match(src, /ORDER of rows/, 'the implicit-property gap is not named');
});
