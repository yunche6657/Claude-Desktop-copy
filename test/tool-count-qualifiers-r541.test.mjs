// R541: "the tool count" is three numbers, and a sentence naming one without its denominator is right about one
// reading and wrong about the other two.
//
// THE THREE READINGS
//       44   contract tools      — the union declared by the contract files
//       39   runtime registered  — what the build registers and the init frame reports
//       23   actually offered    — what the request body carries
//
//   R507 established the third: the init frame reports 39, the request carries 23, because 17 are withheld and one
//   appears only in the request. So "39 tools" is true of the frame and false of the request, and the number alone
//   cannot say which is meant.
//
// R540 COULD NOT SEE THIS
//   Its unit key is `tools` for all three, so they rank as three separate rows — `44 tools`, `39 tools`, `23 tools` —
//   with nothing linking them as readings of one measurement. That is the gap this round closes.
//
// MEASURED
//   52 occurrences across evidence: 44 appears 29 times, 39 twenty-one times, 23 twice.
//   19 carry no qualifier on the line and none in the nearest heading.
//
//   Sampling them showed the 19 are mostly EARLY files, written before the distinction existed — `agent-core-round100`
//   predates it by four hundred rounds. Not calling those wrong is the point: they are not wrong, they are
//   unqualified, and a reader taking the number from them cannot tell which reading it is.
//
//   One is worth a second look on its own: `contract-denominator-r488.md:104` says "22 个 vs 45 个差了 23 个工具" —
//   there the 23 is a DIFFERENCE, not the offered count, and it shares a numeral with the third reading.
//
// A BOUNDARY BUG COST THIS ROUND ITS FIRST MEASUREMENT
//   `/(\d+)\s*(?:个工具|tools?)\b/` matched `44 tools` and nothing else. `\b` is defined on ASCII word characters and
//   具 is not one, so the position after it is not a boundary. The first run reported 10 occurrences where a grep
//   found 21. The `\b` now applies to the ASCII branch only.
//
// WHAT IS NOT CLAIMED
//   Not that an unqualified line is wrong: an early round may predate the distinction, and a line inside a section
//   whose heading established the denominator is fine. Not that the qualifier vocabulary is complete — a fourth
//   phrasing would be invisible. Not that 44/39/23 are the only readings: they are the ones the evidence names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'tool-count-qualifiers.cjs');

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

test('Chinese tool-count phrases are matched, not just the English form', () => {
  // The boundary bug. If `N 个工具` stops matching, the occurrence count collapses to a handful and the whole report
  // becomes about English only — which is a small fraction of the evidence.
  const d = report();
  assert.ok(d.occurrences > 40,
    `only ${d.occurrences} occurrences found: the Chinese alternation may be failing to match again`);
  assert.ok(d.byValue['44'] > 20, `44 appears only ${d.byValue['44']} times`);
  assert.ok(d.byValue['39'] > 15, `39 appears only ${d.byValue['39']} times`);
});

test('the boundary is kept for the ASCII branch so toolsets does not match', () => {
  // Removing \b entirely would fix the Chinese case and break this one.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /个工具\|tools\?\\b\)/, 'the ASCII branch lost its boundary');
});

test('the three readings are named with their meanings', () => {
  const r = run([]);
  assert.match(r.stdout, /contract tools/, 'the 44 reading is not named');
  assert.match(r.stdout, /runtime registered/, 'the 39 reading is not named');
  assert.match(r.stdout, /actually offered/, 'the 23 reading is not named');
});

test('the R507 frame-versus-request distinction is stated', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /init frame reports 39/, 'the frame reading is not explained');
  assert.match(src, /request carries 23/, 'the request reading is not explained');
  assert.match(src, /17 are withheld/, 'the mechanism separating them is gone');
});

test('a heading can qualify a block, and the tool checks it', () => {
  const d = report();
  // Every reported row must have been checked against its heading; a row whose heading qualified it is not reported.
  for (const row of d.rows) {
    assert.equal(row.qualified, false, `${row.file}:${row.line} is qualified on its own line but was reported`);
    assert.equal(row.qualifiedByHeading, false,
      `${row.file}:${row.line} is qualified by its heading but was reported`);
  }
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /function sectionAt/, 'heading lookup is gone');
});

test('the unqualified list is reported as ambiguous rather than wrong', () => {
  const r = run([]);
  assert.match(r.stdout, /not automatically wrong/,
    'the report no longer says an unqualified line may be legitimate');
  assert.match(r.stdout, /cannot tell which of three/,
    'the consequence of an unqualified number is not stated');
  assert.ok(report().unqualified > 0, 'no unqualified occurrence found at all: the qualifier check may be too loose');
});

test('the difference-not-count case is recorded', () => {
  // `22 vs 45, a difference of 23 tools` shares its numeral with the offered-count reading. Worth naming because it is
  // the kind of coincidence the tool cannot distinguish.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /A NUMERAL CAN COLLIDE WITH A DIFFERENCE/, 'the collision section is gone');
  assert.match(src, /there 23 is the DIFFERENCE, not the/, 'the concrete case is no longer named');
  assert.match(src, /22 个 vs 45 个差了 23 个工具/, 'the quoted line is gone');
});
