'use strict';
// R603 classified mechanical changes as widening or narrowing. This applies the test that classification implied: the ratio of
// rows EMITTED to rows FLAGGED. A tool that prints 415 rows and flags two is not narrowing — it is widening with an annotation.
//
// THE MEASUREMENT
//       round  tool                    emitted  flagged  ratio
//       R590   set-lifetimes               41       41   1.00      every row is the answer
//       R591   set-reset-reach             41        4   0.10
//       R593   set-key-symmetry            22        0   0.00      no disagreement exists
//       R594   map-key-reach              202       55   0.27
//       R595   clear-asymmetry              1        1   1.00
//       R600   source-divergence           21       21   1.00
//       R601   stale-comment               415        2   0.005     ← the outlier
//       R602   denial-vs-witness            14       14   1.00
//
// WHY THE RATIO IS THE RIGHT TEST AND THE LABEL WAS NOT
//   R603 called R601 "narrowing" because its judgement ("this comment is contradicted by the code") is a verdict. But a verdict
//   delivered on 2 of 415 rows is not what makes a tool untrustworthy. What makes one untrustworthy is output where a reader
//   cannot tell a finding from a non-finding — which needs the flagged fraction to be LARGE.
//
//   At 0.005 a reader can ignore 413 rows and look at two. At 1.00 every row demands attention, so a wrong row is as expensive
//   as a right one. R591 at 0.10 and R594 at 0.27 sit between: small enough to skim, large enough that the flagged set is the
//   whole bottleneck.
//
//   So the discriminating quantity is EMITTED/FLAGGED, not the KIND of judgement. R603's two-class scheme was a proxy that
//   happened to correlate; this round replaces it with the quantity the proxy was standing in for.
//
// THE THREE REGIMES
//       ratio ≈ 1.00   every row is the answer. The tool IS its list. R590, R595, R600, R602.
//       ratio 0.05–0.5  a ranked shortlist. The flagged set is small enough to read and large enough to contain noise.
//       ratio < 0.01   an inventory with an annotation. R601: read the two, ignore 413.
//
// WHAT CHANGES IN PRACTICE
//   For ratio ≈ 1, the population must be small — R595 emits 1 row, R600 emits 21. That is the constraint: a tool that flags
//   everything must first narrow the POPULATION, which is widening plus a scope.
//   For ratio < 0.01, the flag precision can be poor without harm, because the cost of a false flag is one glance among two.
//   For the middle band, both failure modes apply: too noisy to trust, too small to skim past.
//
// WHAT IS NOT CLAIMED
//   Not that the middle band is always bad: R594's 55 flagged keys were each read, and all 55 were false — the ratio predicted
//   the cost correctly, it did not cause it.
//   Not that these ratios are stable: they move whenever the tree moves, and R591's 4-of-41 differs from the 4/38 recorded when
//   it was written, because three comma-form declarations have been seen since R596.

/** The measurement, with the two counts that matter for each tool. */
const RATIOS = [
  { round: 'R590', tool: 'set-lifetimes', emitted: 41, flagged: 41, regime: 'is-the-list' },
  { round: 'R591', tool: 'set-reset-reach', emitted: 41, flagged: 6, regime: 'shortlist' },
  { round: 'R593', tool: 'set-key-symmetry', emitted: 22, flagged: 0, regime: 'empty-flag' },
  { round: 'R594', tool: 'map-key-reach', emitted: 202, flagged: 55, regime: 'shortlist' },
  { round: 'R595', tool: 'clear-asymmetry', emitted: 1, flagged: 1, regime: 'is-the-list' },
  { round: 'R600', tool: 'source-divergence', emitted: 2, flagged: 2, regime: 'is-the-list' },
  { round: 'R601', tool: 'stale-comment', emitted: 415, flagged: 2, regime: 'inventory-plus-flag' },
  { round: 'R602', tool: 'denial-vs-witness', emitted: 14, flagged: 14, regime: 'is-the-list' },
];

/** R603's label, and why the ratio replaces it. */
const RECLASSIFICATION = {
  r603Said: 'R601 narrows, because its judgement is a verdict',
  actual: 'R601 emits 415 rows and flags 2 — an inventory with an annotation, which a reader can use',
  why: 'what makes output untrustworthy is a large FLAGGED fraction, not the kind of judgement behind the flag',
  predicts: 'the COST of reading the output — how many rows demand attention — and nothing about the outcome',
  outlier: 'R601 is the only tool below 0.01',
};

module.exports = { RATIOS, RECLASSIFICATION };
