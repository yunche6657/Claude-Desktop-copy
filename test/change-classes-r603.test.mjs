// R603: four mechanical changes. The one that WIDENED found the only defect; the three that NARROWED found nothing.
//
// THE OBSERVATION
//   R596's fix was mechanical and it worked: widening the declaration regex to also accept `, NAME = new Set(` raised the Map
//   population from 167 to 202 and exposed `tabAdmissions`, the only real key mismatch in the tree. The fix taught the tool to
//   SEE MORE.
//
//   R591, R594 and R602 were also mechanical and all three produced noise: 9 false candidates from "does this file reset a
//   set", 33 false Map keys from "do the two names match", 12 false pairs from "are these in the same function". Each taught the
//   tool to JUDGE MORE.
//
//   Both are cheap. Only one accumulates. The difference is not effort or cleverness — it is whether the change moves a row from
//   "not examined" into "examined", or from "examined" into "convicted".
//
// THE TWO CLASSES
//       widening    increases the POPULATION examined. A false entry is a row that gets looked at and dismissed.
//       narrowing   adds a VERDICT rule over an existing population. A false entry is a row REPORTED AS A DEFECT.
//
//   Widening is self-correcting: extra rows join the same reader loop, and the loop's cost is linear in rows. Narrowing is not:
//   its output is unordered by construction — every row looks equally like a finding — so a reader either trusts it wholesale or
//   re-reads everything, which defeats the tool.
//
// THE MEASURED RECORD HERE
//       widening   R596 declaration regex    +35 maps, 1 real finding, 0 false
//       narrowing  R591 file-resets-a-set      9 candidates, 0 real
//       narrowing  R594 two-names-match       33 keys,      0 real
//       narrowing  R602 same-function         12 pairs,      0 real
//
//   Four observations, not a rate. Enough to order the NEXT attempt: try widening first, because a widening change that fails
//   costs a longer list, while a narrowing change that fails costs its own credibility.
//
// THE EXCEPTION THAT PROVES THE RULE
//   R597's `callRelation` narrowed and was USEFUL — it never said "suspicious", it SPLIT six rows into three named classes so a
//   reader could skip two. Narrowing used as a SORT: a wrong sort misplaces a row; it does not accuse one. The test is whether
//   the output says "check this" or "this is one of N kinds".
//
// WHAT IS NOT CLAIMED
//   Not that narrowing is useless — see above.
//   Not that 1-in-4 is a rate. Four changes is an anecdote with a denominator, and the population of "mechanical changes a
//   project like this makes" is not sampled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CLASSES, SORT_EXCEPTION } from '../desktop/change-classes.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the two classes are distinguished by what a false entry costs', () => {
  assert.equal(CLASSES.length, 2);
  const wide = CLASSES.find((c) => c.kind === 'widening');
  const narrow = CLASSES.find((c) => c.kind === 'narrowing');
  assert.ok(wide && narrow);
  assert.match(wide.moves, /not examined → examined/);
  assert.match(narrow.moves, /examined → convicted/);
  assert.equal(wide.selfCorrecting, true);
  assert.equal(narrow.selfCorrecting, false);
});

test('the widening record is the R596 numbers, and it found something', () => {
  const wide = CLASSES.find((c) => c.kind === 'widening');
  assert.equal(wide.measured.populationBefore, 167);
  assert.equal(wide.measured.populationAfter, 202);
  assert.ok(wide.measured.real >= 1, 'the widening claims no real finding, contradicting R596');
  assert.equal(wide.measured.false, 0);
});

test('the three narrowing records are the R591/R594/R602 counts, all with zero real findings', () => {
  const narrow = CLASSES.find((c) => c.kind === 'narrowing');
  assert.equal(narrow.measured.length, 3);
  const byRound = Object.fromEntries(narrow.measured.map((m) => [m.round, m]));
  assert.equal(byRound.R591.candidates, 9);
  assert.equal(byRound.R594.candidates, 33);
  assert.equal(byRound.R602.candidates, 12);
  for (const m of narrow.measured) assert.equal(m.real, 0, `${m.round} now claims a real finding`);
});

test('the sort exception is recorded as narrowing that worked, with its criterion', () => {
  assert.equal(SORT_EXCEPTION.round, 'R597');
  assert.match(SORT_EXCEPTION.criterion, /check this|one of N kinds/, 'the criterion is not stated');
  assert.match(SORT_EXCEPTION.whyItWorked, /never says|skip two/, 'why it differs from a verdict is not stated');
});

test('the record refuses to state a rate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'change-classes.cjs'), 'utf8');
  assert.match(src, /anecdote with a denominator/, 'the rate caveat is missing');
  assert.match(src, /Not that 1-in-4 is a rate/, 'the numeric caveat is missing');
});

test('the record does not dismiss narrowing outright', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'change-classes.cjs'), 'utf8');
  assert.match(src, /Not that narrowing is useless/, 'the scope limit is missing');
});

test('the widening claim is checkable against the tool that made it', () => {
  // The numbers in the record must match what the current tool reports, or the record is about a tool that moved.
  // spawnSync is imported at the top; ESM modules have no require.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'map-key-reach.cjs'), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0);
  const d = JSON.parse(r.stdout);
  const wide = CLASSES.find((c) => c.kind === 'widening');
  assert.equal(d.maps, wide.measured.populationAfter,
    `the tool now reports ${d.maps} maps, not the recorded ${wide.measured.populationAfter}`);
});
