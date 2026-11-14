// R540: listing the numeric claims nothing guards — and the aggregation key that had to be fixed before the list
// meant anything.
//
// WHY THIS IS THE INVERSE OF corrections.cjs
//   corrections.cjs answers "is every REGISTERED correction applied on both copies?" It cannot answer "which claims
//   were never registered at all". R536 found 367 where the real value was 352; that number sat in four evidence files
//   and three had no banner until R537. The lesson was not that the correction mechanism works — it was that a wrong
//   number can sit in the record with nothing pointing at it. This tool lists where that could happen next.
//
// THE AGGREGATION KEY WAS WRONG FIRST, AND THE WRONG VERSION LOOKED REASONABLE
//   Keying on the bare number produced a table where `2` appeared in eleven files. Opening those files showed why that
//   is meaningless: the elevens were 2 branches, 2 tools, and an incidental digit inside prose — three unrelated facts
//   sharing a character. A ranking built on that points a reader at noise, and the 367 case it exists to surface gets
//   buried in it.
//
//   Keying on `number|unit` changed the picture: 144 distinct claims instead of 216, and the top of the list became
//   `44 tools` (14 files, 6 rounds) followed by `39 tools`, which are real repeated measurements. `367 branches` now
//   ranks on its own terms — 4 files, 3 rounds — instead of colliding with every other 367 in the repository.
//
// WHAT THE OUTPUT IS AND IS NOT
//   A candidate list, ranked by recurrence. An unregistered number is NOT an error: most claims are correct, and this
//   tool cannot tell a right number from a wrong one — it has no second source. What it can say is which numbers are
//   repeated enough that a correction would matter, and which of those have no registry entry to hang a banner on.
//
// WHAT IS NOT CLAIMED
//   Not that the unit vocabulary is complete: a claim phrased in a way none of the patterns match is invisible here.
//   Not that a repeated claim is a claim about the same thing — `7 fields` in seven files could be seven different
//   field counts, and the tool cannot distinguish them. Not that an unregistered number is unguarded in practice: a
//   later round may correct it in prose without a registry entry, which is the failure mode this list cannot detect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'numeric-claims.cjs');

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

test('every claim carries a unit, and the same number with different units is not merged', () => {
  // The defect the first version had. `2 branches` and `2 tools` must be separate rows.
  const d = report();
  for (const r of d.rows) {
    assert.ok(r.unit, `claim ${r.value} has no unit`);
    assert.equal(typeof r.unit, 'string');
  }
  const twos = d.rows.filter((r) => r.value === '2');
  const units = new Set(twos.map((r) => r.unit));
  assert.ok(twos.length === 0 || units.size > 1 || twos.length === 1,
    'the value 2 appears under only one unit: either the data changed or units are being collapsed');

  // And no two rows may share a value+unit pair, which is what the key must guarantee.
  const keys = d.rows.map((r) => `${r.value}|${r.unit}`);
  assert.equal(new Set(keys).size, keys.length, 'the same value+unit appears in two rows');
});

test('the 367 branches claim is found under its own unit', () => {
  // The case this tool exists for. It must appear as `branches`, not folded in with any other 367.
  const d = report();
  const row = d.rows.find((r) => r.value === '367' && r.unit === 'branches');
  assert.ok(row, 'the 367-branch claim is no longer detected');
  assert.ok(row.fileCount >= 3, `367 branches claimed in only ${row.fileCount} file(s)`);
  assert.equal(row.registered, true, '367 is no longer marked as covered by a registry entry');
});

test('a registered claim and an unregistered one are labelled differently', () => {
  const d = report();
  assert.ok(d.rows.some((r) => r.registered), 'no claim is marked registered: the registry join is broken');
  assert.ok(d.rows.some((r) => !r.registered), 'every claim is marked registered: the join is too permissive');
  // 44 tools is the most-repeated claim and is registered by the R502 denominator work.
  const fortyFour = d.rows.find((r) => r.value === '44' && r.unit === 'tools');
  assert.ok(fortyFour, '44 tools is gone');
  assert.equal(fortyFour.registered, true, '44 tools is no longer joined to its correction');
});

test('the report states that an unregistered number is not an error', () => {
  const r = run([]);
  assert.match(r.stdout, /Absence is not an error/,
    'the caveat that absence is not a defect is gone from the output');
  assert.match(r.stdout, /how R536 happened/,
    'the reason the list exists is no longer stated');
});

test('the unit-key fix is recorded at the tool', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /THE KEY HAS TO BE `number \+ unit`/, 'the fix is not documented');
  // The concrete evidence, checked as separate facts so a re-wrap of the paragraph cannot break the assertion.
  assert.match(src, /ELEVEN FILES/i, 'the eleven-file observation is gone');
  assert.match(src, /2 branches, 2 tools/, 'the three unrelated facts sharing a digit are no longer named');
  assert.match(src, /144 distinct claims/, 'the before/after measurement is gone');
});

test('the limits of pattern matching are stated', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /WHAT THIS CANNOT SEE/, 'the disclosure section is gone');
  assert.match(src, /patterns match is invisible here/, 'the phrasing blind spot is not disclosed');
  assert.match(src, /seven different field counts|different field counts/,
    'the coincidence risk for repeated claims is not disclosed');
  assert.match(src, /corrected in prose without a\s*\n?\s*\/\/?\s*registry entry|cannot detect/,
    'the prose-correction blind spot is not disclosed');
});
