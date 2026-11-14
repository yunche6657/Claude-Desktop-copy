'use strict';
// Extracting a defect needs the right SUBJECT (R574–R585). Measuring precision needs the right PROVENANCE. Separating those
// two questions before trusting a tool is the difference between a check that found something and a check that looked busy.
//
// THE OBSERVATION
//   R596's fix was mechanical and it WORKED: widening the declaration regex from `const NAME = new Set(` to also accept
//   `, NAME = new Set(` raised the Map population from 167 to 202 and exposed `tabAdmissions`, the only real key mismatch in
//   the tree. The fix taught the tool to SEE MORE.
//
//   R591, R594 and R602 were also mechanical, and all three produced noise: 9 false candidates from "does this file reset a
//   set", 33 false Map keys from "do the two names match", 12 false pairs from "are these in the same function". Each taught the
//   tool to JUDGE MORE.
//
//   Both are cheap. Only one accumulates. The difference is not the effort spent or the pattern's cleverness; it is whether the
//   change moves a row from "not examined" into "examined", or moves a row from "examined" into "convicted".
//
// THE TWO CLASSES
//       widening    increases the POPULATION a tool examines. A false entry here is a row that gets looked at and dismissed.
//       narrowing   adds a VERDICT rule over an existing population. A false entry here is a row that gets reported as a defect.
//
//   A widening change is self-correcting: the extra rows enter the same reader loop as the rest, and the loop's cost is linear.
//   A narrowing change is not: its output is unordered by construction — every row looks equally like a finding — so a reader
//   either trusts it wholesale or re-reads everything, which defeats the tool.
//
// THE MEASURED RECORD IN THIS REPOSITORY
//       widening   R596 declaration regex    +35 maps, 1 real finding, 0 false
//       narrowing  R591 file-resets-a-set      9 candidates, 0 real
//       narrowing  R594 two-names-match       33 keys,      0 real
//       narrowing  R602 same-function         12 pairs,      0 real
//
//   Four mechanical changes. The one that widened found the only defect; the three that narrowed found nothing and cost a read
//   each. That is not proof about the world — it is 4 observations — but it is enough to order the NEXT attempt: try widening
//   first, because a widening change that fails costs a longer list, while a narrowing change that fails costs its own
//   credibility.
//
// WHAT THIS DOES NOT SAY
//   Not that narrowing is useless. R597's `callRelation` narrowed and was useful — it did not report "suspicious", it SPLIT six
//   rows into three named classes so a reader could skip two of them. That is narrowing used as a SORT, and a wrong sort is a
//   misplaced row, not a false accusation. The distinction is whether the output says "check this" or says "this is one of
//   three kinds".
//   Not that 1-in-4 is a rate. Four changes is an anecdote with a denominator.

/** Two classes of mechanical change, and what a false entry costs in each. */
const CLASSES = [
  {
    kind: 'widening',
    moves: 'not examined → examined',
    example: 'R596: `const NAME = new Set(` also accepts `, NAME = new Set(`',
    measured: { populationBefore: 167, populationAfter: 202, real: 1, false: 0 },
    failureMode: 'a longer list to read; the extra rows join the same loop',
    selfCorrecting: true,
  },
  {
    kind: 'narrowing',
    moves: 'examined → convicted',
    examples: [
      'R591: this file resets some set → these no-reset sets are candidates',
      'R594: the two key expressions differ → these Map keys may be mismatched',
      'R602: both comments are in one function → this denial contradicts that witness',
    ],
    measured: [
      { round: 'R591', candidates: 9, real: 0 },
      { round: 'R594', candidates: 33, real: 0 },
      { round: 'R602', candidates: 12, real: 0 },
    ],
    failureMode: 'reported rows look equally like findings, so a reader must either trust the tool or re-read everything',
    selfCorrecting: false,
  },
];

/** Narrowing used as a SORT rather than a verdict, which is the version that worked. */
const SORT_EXCEPTION = {
  round: 'R597',
  change: 'callRelation split six call-shaped rows into same-call / same-callee-different-args / different-callee',
  whyItWorked: 'the output names three kinds and lets a reader skip two; it never says "this row is suspicious"',
  criterion: 'ask whether the output says "check this" or "this is one of N kinds"',
};

module.exports = { CLASSES, SORT_EXCEPTION };
