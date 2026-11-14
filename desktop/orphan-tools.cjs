'use strict';
// The last visibility layer: is any tool in `tools/` orphaned — mentioned nowhere at all? Answer: no. All 189 are mentioned, and
// the split is 129 in a test plus 60 in evidence only.
//
// THE MEASUREMENT
//       tools                                       189
//       mentioned as a whole token outside tools/    189
//       mentioned in at least one TEST               129
//       NOT in any test                               60
//       … of those, appearing in evidence             60
//       … mentioned NOWHERE at all                     0
//
//   The 60 is a snapshot: the buckets trade members as rounds add tests, so what holds is the PARTITION, not either count.
//   Zero orphans. The substring check was run first and reported zero as well, and a stricter whole-token check agreed — so the
//   answer is not an artefact of loose matching.
//
// WHAT THE 60 ACTUALLY ARE
//   None of them is CLI-shaped in the guarded sense (`require.main` / `module.parent`), which is why R629's sweep could not reach
//   them: 28 are runnable-looking scripts (`fix-ion-dist`, `login-account`, `merge-changelog`, `official-diff`), 13 are named
//   `proof-*` one-shot evidence generators, 19 are analysis scripts (`admitted-gaps`, `bridge-gaps`, `called-gaps`, `field-mismatch`).
//
//   That shape is coherent with their being cited only in evidence: a `proof-r389-held-withdrawn.cjs` exists to produce one round's
//   evidence, is referenced by that round, and never needs a test. The record is their only consumer by design.
//
// WHY ZERO ORPHANS IS THE RIGHT ANSWER TO REPORT
//   Three rounds have been hunting broken or invisible instruments (R628 found one broken, R629 found six correct refusals and no
//   new defects). This round closes the question by showing there is no unreferenced corner left to hide in. That is a complete
//   negative result, and it is worth stating as such rather than as "nothing found".
//
// WHAT IS NOT CLAIMED
//   Not that every one of the 189 works: R628 found a broken one that WAS mentioned in evidence, so mention does not imply health.
//   What this round establishes is that no tool escapes both the tests and the record.
//   Not that the 60 need no test: a `proof-*` generator that silently stopped working would be noticed only by the round that needs
//   it, which is later than a test would.

/** The coverage split. */
const COVERAGE = {
  tools: 189,
  mentionedAnywhere: 189,
  inAtLeastOneTest: 129,
  onlyInEvidence: 60,
  orphans: 0,
  strictness: 'a whole-token check and a substring check agreed, so the zero is not an artifact of loose matching',
};

/** What the 60 are. */
const SHAPES = [
  { kind: 'runnable scripts', count: 28, examples: ['fix-ion-dist.cjs', 'login-account.cjs', 'merge-changelog.cjs', 'official-diff.cjs'] },
  { kind: 'proof-* one-shot generators', count: 13, examples: ['proof-r385-stop-park.cjs', 'proof-r389-held-withdrawn.cjs', 'proof-consent-hidden.cjs'] },
  { kind: 'analysis scripts', count: 19, examples: ['admitted-gaps.cjs', 'bridge-gaps.cjs', 'called-gaps.cjs', 'field-mismatch.cjs'] },
];

/** Why this shape is coherent. */
const COHERENT = {
  why: 'a `proof-r389-held-withdrawn.cjs` exists to produce one round\'s evidence; that round references it, and no test needs it',
  consumer: 'the record is their only consumer, by design',
};

module.exports = { COVERAGE, SHAPES, COHERENT };
