'use strict';
// Structural predicates are not one kind. Some ask the question the defect answers; some ask only a NECESSARY condition — and a
// necessary condition over-produces in proportion to how many other ways it can hold.
//
// THE THIRD LAYER
//   R605 split gates into structural (predicate over data) and positional (predicate over placement), and showed only structural
//   ones reach an emit/flag ratio of 1.00. But R594 was structural and still produced 55 false rows, so structural is not
//   sufficient either. The missing distinction is what the predicate ASKS:
//
//       sufficient      "condition holds" implies "defect present"  → an emitted row is a finding
//       necessary       "defect present" implies "condition holds"  → an emitted row is a CANDIDATE
//       unrelated       computable, but the defect does not answer to it
//
//   A necessary condition over-produces by the number of OTHER ways it can hold. R594 asked "do the two key expressions differ",
//   which is true whenever two names for one value are spelled differently — the normal case in a codebase with several naming
//   conventions. Measured: 55 emitted, 0 findings.
//
// THE SIX STRUCTURAL PREDICATES IN THIS LINE
//       R590  addOnly: has+add, no delete/clear          sufficient       41 emitted, population of interest
//       R591  a sibling reset exists in this file        necessary         6 emitted, 0 findings
//       R593  delete argument != add argument            sufficient        0 emitted — the defect would be visible
//       R594  the two key expressions differ             necessary        55 emitted, 0 findings
//       R595  both keys omit the dimension, one cleared   sufficient        1 emitted, 1 finding
//       R605  one internal AND one external assignment   necessary-honest  21 emitted, 0 findings, all 21 TRUE
//
// R605 IS THE INSTRUCTIVE ROW
//   Its predicate is necessary — "has both provenances" does not imply "the value is mishandled" — yet all 21 emitted rows are
//   true statements about the code. The difference from R594 is that R605 emits ROWS, not ACCUSATIONS: each row says "this
//   variable has two provenances", and that is checkably true. R594 emits rows that say "these keys may be mismatched", and 55 of
//   55 were not.
//
//   So ratio 1.00 belongs to a COMBINATION: a necessary predicate AND an output that states only what the predicate established.
//   R602 failed the second half as well — it emitted pairs as if they were contradictions.
//
// WHY "necessary + honest label" IS THE USEFUL MIDDLE
//   It costs one glance per row and never accuses. Strictly better than a sufficient predicate you do not have, and strictly
//   better than a necessary predicate reported as a verdict.
//
// WHAT IS NOT CLAIMED
//   Not that the classification is objective: "sufficient" is judged against the defect as I defined it, and a different
//   definition moves rows between columns.
//   Not that these six are all the structural predicates: R601's symbol-defined check is structural too, excluded here because its
//   population is comments rather than code objects.

/** Each structural predicate, its strength, and what it produced. */
const PREDICATES = [
  {
    round: 'R590',
    predicate: 'addOnly: has has+add and no delete/clear',
    strength: 'sufficient',
    emitted: 41,
    findings: 41,
    note: 'every such set IS the population of interest, so no flag is needed',
  },
  {
    round: 'R591',
    predicate: 'a sibling set is reset somewhere in this file',
    strength: 'necessary',
    emitted: 6,
    findings: 0,
    note: 'reset reach is necessary for a key to omit a dimension, not sufficient',
  },
  {
    round: 'R593',
    predicate: 'the delete argument differs from the add argument',
    strength: 'sufficient',
    emitted: 0,
    findings: 0,
    note: '0 emitted — the defect would be visible here, and none exists',
  },
  {
    round: 'R594',
    predicate: 'the two key expressions differ',
    strength: 'necessary',
    emitted: 55,
    findings: 0,
    note: 'true whenever two names for one value are spelled differently, which is the normal case',
  },
  {
    round: 'R595',
    predicate: 'both keys omit the dimension AND only one side is cleared',
    strength: 'sufficient',
    emitted: 1,
    findings: 1,
    note: 'the only sufficient predicate here that emitted anything',
  },
  {
    round: 'R605',
    predicate: 'the variable has one internal AND one external assignment',
    strength: 'necessary-honest',
    emitted: 2,
    findings: 0,
    whyHonest: 'each row states only what the predicate established — "this variable has two provenances" — and that is '
      + 'checkably true for all 21',
  },
];

/** The rule, stated as the combination rather than either half. */
const LABEL_RULE = {
  claim: 'a necessary predicate AND an output that states only what the predicate established reaches ratio 1.00',
  why: 'the rows are checkable even though the predicate cannot convict',
  cost: 'one glance per row, and no row accuses',
  contrast: 'R594 had a necessary predicate and an accusing label; R602 had a positional predicate and an accusing label',
};

module.exports = { PREDICATES, LABEL_RULE };
