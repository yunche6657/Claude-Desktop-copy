// R538: every addendum ever written reached only one of the two copies, and the registry called it appended.
//
// WHAT WAS MEASURED
//   Six addenda, six `appended` statuses, six absent from their HANDOFF copy:
//
//       tool-absence-r500.md        r504  evidence 123 lines  handoff  81 lines
//       contract-compare-r489.md    r509  evidence  92 lines  handoff  78 lines
//       contract-vs-impl-r491.md    r504  evidence 104 lines  handoff  90 lines
//       artifact-divergence-r492.md r506  evidence 112 lines  handoff  98 lines
//       tool-relation-r493.md       r494  evidence 113 lines  handoff  99 lines
//       tool-relation-r494.md       r501  evidence 133 lines  handoff 119 lines
//
//   Six for six is not an edge case. `analyse()` checked `text.includes(addendumMarker(a))` against the registry
//   entry's own file and stopped there, so the status was true about the file it examined and silent about the file a
//   reader opens — the handoff convention points at the HANDOFF.
//
// WHY IT NEEDED TWO FIXES, AND THE FIRST ONE ALONE DID NOT WORK
//   1. `alsoFile` names the twin, and the status now folds the twin in: an addendum with one side pending is
//      `twin-needs-append`, not `appended`.
//   2. But `--write` still skipped everything that was not `needs-addendum`, so the six stayed pending with no work
//      attempted. And once that loop was widened, `applyAddendum` refused all six with "the banner this addendum
//      depends on is absent" — because the HANDOFF twins had no registry entry, so no banner had ever been applied to
//      them. Registering the twins was the third change, and it is the one that made the mechanism symmetric.
//
//   That sequence is worth keeping: the detection fix, the application fix, and the registration fix were each
//   necessary and each insufficient alone. The first run after fix 1 reported six problems and applied nothing, which
//   looks like the fix failing and was the fix working.
//
// WHAT IS NOT CLAIMED
//   Not that the twin is always the right counterpart: the mapping is a declared table in corrections.json, so a
//   HANDOFF renamed or split in future would drift silently. Not that the added text is byte-identical to the
//   evidence side — only that the addendum marker is present on both. Not that proof-rounder's own copies (the ten
//   `test/*.md` files carrying the same evidence) are covered: nothing enumerates them as twins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'corrections.cjs');
const REGISTRY = path.join(ROOT, 'evidence', 'corrections.json');

const TWINS = [
  ['tool-absence-r500.md', 'HANDOFF-ROUND500-TOOL-ABSENCE.md'],
  ['contract-compare-r489.md', 'HANDOFF-ROUND489-CONTRACT-COMPARE.md'],
  ['contract-vs-impl-r491.md', 'HANDOFF-ROUND491-CONTRACT-VS-IMPL.md'],
  ['artifact-divergence-r492.md', 'HANDOFF-ROUND492-ARTIFACT-DIVERGENCE.md'],
  ['tool-relation-r493.md', 'HANDOFF-ROUND493-TOOL-RELATION.md'],
  ['tool-relation-r494.md', 'HANDOFF-ROUND494-TOOL-RELATION.md'],
];

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
});

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('no addendum is pending on either side', () => {
  const d = report();
  const pending = d.addenda.filter((a) => a.status !== 'appended' || (a.twinStatus && a.twinStatus !== 'appended'));
  assert.deepEqual(pending.map((a) => `${a.file}:${a.status}/${a.twinStatus}`), [],
    'these addenda are not on both copies');
});

test('every addendum declares a twin, and the twin really exists', () => {
  // `alsoFile` is what makes the symmetry checkable. Without it the tool has nothing to compare against and reports
  // `appended` on the strength of one file.
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  for (const a of reg.addenda || []) {
    assert.ok(a.alsoFile, `${a.file} has no twin declared`);
    const p = path.join(ROOT, a.alsoFile);
    assert.ok(fs.existsSync(p), `${a.file}'s twin ${a.alsoFile} does not exist`);
  }
});

test('the twin carries the addendum marker in its banner block, not below the title', () => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  for (const a of reg.addenda || []) {
    const text = fs.readFileSync(path.join(ROOT, a.alsoFile), 'utf8');
    // The marker format is stable: the round the addendum was written in.
    const marker = `addendum-r${a.round}`;
    assert.ok(text.includes(marker), `${a.alsoFile} does not carry ${marker}`);
    // Inside the banner block means above the first heading. An addendum below it would read as original evidence.
    assert.ok(text.indexOf(marker) < text.indexOf('\n# '),
      `${a.alsoFile}'s addendum sits below the title: it will read as part of the original evidence`);
  }
});

test('both copies of each pair are within a few lines of each other', () => {
  // The drift signature was a HANDOFF 42 lines shorter than its evidence file. A large gap means one side was never
  // given the appends, whatever the marker check says.
  for (const [ev, handoff] of TWINS) {
    const evLines = fs.readFileSync(path.join(ROOT, 'evidence', ev), 'utf8').split('\n').length;
    const hLines = fs.readFileSync(path.join(ROOT, handoff), 'utf8').split('\n').length;
    assert.ok(Math.abs(evLines - hLines) < 30,
      `${ev} is ${evLines} lines and ${handoff} is ${hLines}: one side is missing content`);
  }
});

test('the twin registered its own banner, so the addendum has somewhere to live', () => {
  // The second failure: applyAddendum refused all six because the HANDOFF had no banner block. A twin without a
  // registry entry therefore cannot receive an addendum, and that is what the registration fix addressed.
  const d = report();
  for (const [, handoff] of TWINS) {
    const row = d.rows.find((r) => r.file === handoff);
    assert.ok(row, `${handoff} has no registry entry`);
    assert.equal(row.status, 'annotated', `${handoff} is ${row.status}`);
  }
});

test('the write loop handles a pending twin rather than skipping it', () => {
  // The first fix reported six problems and applied nothing, because the loop continued on anything that was not
  // `needs-addendum`. Reading the source is the only way to catch that regression without breaking a real file.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /const twinPending = a\.twinStatus === 'twin-needs-append'/,
    'the twin is no longer consulted by the write loop');
  assert.match(src, /if \(!primaryPending && !twinPending\) continue;/,
    'the loop is back to skipping every twin');
  assert.match(src, /twin-needs-append' : 'appended'|twinStatus !== 'appended'/,
    'the status no longer folds the twin in');
});

test('the drift and its three-part fix are recorded at the tool', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /all six addenda reported `appended`, and all six were absent/,
    'the measurement is no longer recorded');
  assert.match(src, /Six for six is not an edge case/,
    'the scale of the problem is not stated');
  assert.match(src, /the banner this addendum depends on is absent|cannot receive an addendum/,
    'the third fix (registering the twins) is not explained');
});
