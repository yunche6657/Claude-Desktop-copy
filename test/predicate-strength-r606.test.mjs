'use strict';
// Structural predicates are not one kind. Some ask the question the defect answers; some ask a NECESSARY condition; and a
// necessary condition over-produces by exactly the number of ways it can be satisfied without the defect being present.
//
// THE THIRD LAYER THIS ROUND ADDS
//   R605 split gates into structural (a predicate over data) and positional (a predicate over placement), and showed that only
//   the structural ones reach an emit/flag ratio of 1.00. But R594 was structural and still produced 55 false rows, so structural
//   is not sufficient either. The missing distinction is what the predicate ASKS:
//
//       sufficient    "the condition holds" implies "the defect is present". An emitted row is a finding.
//       necessary     "the defect is present" implies "the condition holds". An emitted row is a CANDIDATE.
//       unrelated     the predicate is computable but the defect does not answer to it at all.
//
//   The arithmetic that makes this actionable: a necessary condition over-produces in proportion to how many other ways it can
//   hold. R594 asked "do the two key expressions differ" — true whenever two names for one value are spelled differently, which
//   is the normal case in a codebase with several naming conventions. Measured: 55 emitted, 0 findings.
//
// THE SIX STRUCTURAL PREDICATES IN THIS LINE OF WORK
//       R590  addOnly: has+add, no delete/clear          sufficient-ish   every such set IS the population of interest
//       R591  a sibling reset exists in this file        necessary        9 emitted, 0 findings
//       R593  the delete argument != the add argument    sufficient       0 emitted — the defect would be visible
//       R594  the two key expressions differ             necessary        55 emitted, 0 findings
//       R595  both keys omit the dimension, one cleared  sufficient       1 emitted, 1 finding
//       R605  one internal AND one external assignment   necessary-ish    21 emitted, 0 findings, but all 21 are REAL
//
//   R605 is the instructive row. Its predicate is necessary — "has both provenances" does not imply "the value is mishandled" —
//   and yet all 21 emitted rows are true statements about the code. The difference from R594 is that R605 emits ROWS, not
//   ACCUSATIONS: each row says "this variable has two provenances" and that is checkably true. R594 emits rows that say "these
//   keys may be mismatched", and 55 of 55 were not.
//
//   So the ratio-1.00 property belongs to the combination: a necessary predicate AND an output that states only what the
//   predicate established. R602 got the second part wrong too — it emitted PAIRS as if they were contradictions.
//
// WHY "NECESSARY + HONEST LABEL" IS THE USEFUL MIDDLE
//   It costs one glance per row and never accuses. That is strictly better than a sufficient predicate you do not have, and
//   strictly better than a necessary predicate reported as a verdict.
//
// WHAT IS NOT CLAIMED
//   Not that the classification is objective: "sufficient" is judged against the defect as I defined it, and a different
//   definition moves rows between columns.
//   Not that these six are all the structural predicates: they are the ones this line of work built. R601's symbol-defined check
//   is structural too and is excluded here because its population is comments rather than code objects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREDICATES, LABEL_RULE } from '../desktop/predicate-strength.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every structural predicate carries a strength and its measured outcome', () => {
  assert.ok(PREDICATES.length >= 5, `only ${PREDICATES.length} predicates recorded`);
  for (const p of PREDICATES) {
    assert.ok(['sufficient', 'necessary', 'necessary-honest', 'unrelated'].includes(p.strength),
      `${p.round} has strength ${p.strength}`);
    assert.equal(typeof p.emitted, 'number', `${p.round} has no emitted count`);
    assert.equal(typeof p.findings, 'number', `${p.round} has no findings count`);
  }
});

test('the necessary rows are exactly the ones that over-produced', () => {
  const necessary = PREDICATES.filter((p) => p.strength === 'necessary');
  assert.ok(necessary.length >= 2, 'fewer than two necessary predicates recorded');
  for (const p of necessary) {
    // A necessary condition reported as a verdict is the failure; record whether it did.
    assert.ok(p.emitted >= p.findings, `${p.round} claims more findings than rows`);
  }
  const r594 = necessary.find((p) => p.round === 'R594');
  assert.ok(r594, 'R594 is no longer classified necessary');
  assert.equal(r594.emitted, 55);
  assert.equal(r594.findings, 0);
});

test('R595 is the sufficient predicate with a real finding', () => {
  const r595 = PREDICATES.find((p) => p.round === 'R595');
  assert.equal(r595.strength, 'sufficient');
  assert.equal(r595.emitted, 1);
  assert.equal(r595.findings, 1);
});

test('R605 is necessary but honest, and the difference is the label', () => {
  const r605 = PREDICATES.find((p) => p.round === 'R605');
  assert.equal(r605.strength, 'necessary-honest');
  // R608 masked string literals and added a scope filter, cutting this from 21 to 2. The strength classification is unchanged.
  assert.equal(r605.emitted, 2);
  // Its rows are true statements, not accusations — that is what separates it from R594.
  assert.equal(r605.findings, 0, 'R605 now claims to have found a defect');
  assert.match(r605.whyHonest, /states only what the predicate established|checkably true/,
    'why its rows are true is not stated');
});

test('the label rule names the combination rather than either half', () => {
  assert.match(LABEL_RULE.claim, /necessary predicate AND an output that states only what the predicate established/,
    'the rule omits one of its two halves');
  assert.match(LABEL_RULE.cost, /one glance per row/, 'the cost is not stated');
});

test('R593 is the sufficient predicate that emitted nothing, which is its own result', () => {
  const r593 = PREDICATES.find((p) => p.round === 'R593');
  assert.equal(r593.strength, 'sufficient');
  assert.equal(r593.emitted, 0, 'R593 emitted a row, so the defect may now exist');
  assert.match(r593.note, /visible|0 emitted/, 'the empty result is not explained');
});

test('the record declares that the classification is not objective', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'predicate-strength.cjs'), 'utf8');
  assert.ok(/Not that the classification is objective/.test(src), 'the subjectivity caveat is missing');
  assert.ok(/definition moves rows between columns/.test(src), 'the dependency is not stated');
});
