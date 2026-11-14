'use strict';
// The four tools with an emit/flag ratio of 1.00 differ in WHY they reach it: a condition about relationships, versus a
// condition about position. The first can be reasoned about; the second is luck with a good day.
//
// THE FOUR, AND THEIR GATES
//       R590  set-lifetimes        1 domain gate: `addOnly` (has+add, no delete, no clear)
//       R595  clear-asymmetry      3 gates: hasReset differs, fedIn equal, co-mentioned on a line
//       R600  source-divergence    3 gates: assignment shape, ≥2 sites, one internal AND one external
//       R602  denial-vs-witness    4 gates: has a function, same file, same function, not the same line
//
// WHICH GATES ARE STRUCTURAL AND WHICH ARE POSITIONAL
//       structural   a predicate over the DATA: `a.hasReset !== b.hasReset`, `hasInternal && hasExternal`
//       positional   a predicate over WHERE code sits: `w.fn === d.fn`, `coMentioned(...)`, `avgLine > 400`
//
//   R595 is the one-row tool and its two load-bearing gates are BOTH structural: one set has a reset and the other does not;
//   both are fed inside the same function. The third gate (`co-mentioned`) is positional, and it is what admits the pair at all —
//   but the POPULATION reduction comes from the first two.
//
//   R600's load-bearing gate is structural: a variable must have one internal assignment AND one external one. That is a fact
//   about each assignment's provenance, not about where it appears. Its 21 rows are 21 variables that genuinely have both.
//
//   R602's load-bearing gates are positional: same file, same function name, different line. Nothing about the comments' content
//   is compared. Its 14 pairs are 14 places where two comments happen to share a large function — which is why all 14 were noise.
//
// THE RULE THIS YIELDS
//   A ratio of 1.00 means every emitted row is the answer. That is achievable when the gate is a predicate over data, because
//   then "row emitted" and "condition true" are the same statement, and a false row would require the data to lie.
//
//   It is NOT achievable when the gate is positional, because position is a proxy: two comments in one function have no reason to
//   be about the same thing, and 14 of them were not.
//
// WHAT R595 ACTUALLY BOUGHT
//   One row, and it is R590's pair. The gate did not DISCOVER it; R590 had already found it by a different route. What R595
//   established is that the criterion has a second, sharper form — both keys omit the dimension AND only one side is cleared.
//   A one-row tool whose row was already known is not a wasted round, but it is not a discovery either, and saying so matters
//   for how much weight the criterion gets.
//
// WHAT IS NOT CLAIMED
//   Not that positional gates are useless: R602's file-level version found the 44 denials and 42 witnesses that made the
//   comparison possible at all. The gate that FILTERS is positional; the enumeration underneath it is not.
//   Not that structural gates are always right: R594's `agrees` gate was structural (compare the two key expressions) and it
//   still produced 55 false rows, because "the expressions differ" is structural but does not imply "the keys are wrong".

/** The four, with each gate classified. */
const TOOLS = [
  {
    round: 'R590',
    tool: 'set-lifetimes',
    emitted: 41,
    gates: [{ text: 'addOnly: has+add, no delete/clear', kind: 'structural' }],
    loadBearing: 'structural',
    note: 'the whole population is the answer, so no flag is needed',
  },
  {
    round: 'R595',
    tool: 'clear-asymmetry',
    emitted: 1,
    gates: [
      { text: 'a.hasReset !== b.hasReset', kind: 'structural' },
      { text: 'a.fedIn === b.fedIn', kind: 'structural' },
      { text: 'coMentioned(a, b) on one line', kind: 'positional' },
    ],
    loadBearing: 'structural',
    note: 'two load-bearing gates are structural; the positional one only admits the pair',
  },
  {
    round: 'R600',
    tool: 'source-divergence',
    emitted: 21,
    gates: [
      { text: 'one internal AND one external assignment', kind: 'structural' },
      { text: 'assignment shape matches `= rhs`', kind: 'positional' },
      { text: 'at least two assignment sites', kind: 'structural' },
    ],
    loadBearing: 'structural',
    note: 'provenance of each assignment is a data fact, not a placement fact',
  },
  {
    round: 'R602',
    tool: 'denial-vs-witness',
    emitted: 14,
    gates: [
      { text: 'w.file === d.file', kind: 'positional' },
      { text: 'w.fn === d.fn', kind: 'positional' },
      { text: 'w.line !== d.line', kind: 'positional' },
      { text: 'avgLine <= 400', kind: 'positional' },
    ],
    loadBearing: 'positional',
    note: 'nothing compares the two comments content, so all 14 pairs were noise',
  },
];

/** The rule, stated as a prediction rather than a law. */
const RULE = {
  claim: 'a ratio of 1.00 is reachable when the filtering gate is a predicate over data',
  why: 'then "row emitted" and "condition true" are the same statement, and a false row would need the data to lie',
  failsWhen: 'the gate is positional, because position is a proxy — two comments in one function need not concern one subject',
  evidence: 'R595 and R600 (structural) emit 1 and 21 true rows; R602 (positional) emits 14 and all 14 are noise',
};

module.exports = { TOOLS, RULE };
