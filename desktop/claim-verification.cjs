'use strict';
// 807 of 1130 quantified COUNT claims in evidence/ are not recomputed by any test in their own round. That is the largest
// verification gap this line of work has measured, and it is about its own record rather than the code.
//
// THE MEASUREMENT
//       evidence files with a countable claim      222
//       (file, number) count pairs                1130
//       recomputed by that round's test            323   = 29%
//       not recomputed                             807
//       round numbers excluded first, so `第407轮` and `R407` cannot be mistaken for a measurement
//       coordinates excluded too: a number preceded by 行/字符/偏移/第 is a position, not a count (only 9 of 2698)
//
// WHAT 29% DOES AND DOES NOT MEAN
//   It does not mean 807 numbers are wrong. Many are line counts, file counts, or tool outputs a later round re-measured — R617
//   through R622 are six consecutive rounds of exactly that re-measuring. A claim can be verified by a later test rather than by
//   its own.
//
//   It does mean that for 807 claims, the only evidence they are right is that I wrote them down. And two rounds running (R621,
//   R622) produced numbers from pattern-matching probes that turned out to be MY misreading — both caught before publication, both
//   in a round that was explicitly checking a number. The ones nobody checked are the ones worth worrying about.
//
// THE THREE FAILURE MODES SEEN SO FAR
//       R574    a recorded line number off by 19
//       R617    two character offsets written as line numbers
//       R621/22 two DRIFTs and ten "evidence-derived" rows that were regex misfires
//
//   All four are in the 807 class: a number stated in prose and not recomputed.
//
// WHAT WOULD SHRINK THE GAP, AND WHY IT IS NOT DONE HERE
//   A checker could re-run every tool and compare against every number, but the numbers live in Chinese prose — deciding which
//   tool and which field a given "21 处" refers to is the same sentence-grammar problem R620 hit. The 29% is therefore a standing
//   property, not a to-do: it will rise only as new rounds are written with their numbers recomputed in their own tests, which is
//   what R616 onward have been doing.
//
// WHAT IS NOT CLAIMED
//   Not that the unverified numbers are right: 29% verified is the point.
//   Not that verification by a later round counts less: R617's re-measurement corrected R600's population from 21 to 2, which is a
//   better check than any same-round test.

/** The gap. */
const GAP = {
  filesWithClaims: 222,
  countPairs: 1130,
  recomputed: 323,
  unverified: 807,
  rate: 0.29,
  excludedRoundNumbers: true,
  excludedCoordinates: 9,
  coordinatesNote: 'a number preceded by 行/字符/偏移/第 is a position, not a count',
};

/** The four failures that all sit in the unverified class. */
const FAILURES = [
  { round: 'R574', what: 'a recorded line number off by 19' },
  { round: 'R617', what: 'two character offsets written as line numbers' },
  { round: 'R621', what: 'two DRIFT reports from misread field names' },
  { round: 'R622', what: 'ten "evidence-derived" rows from a regex that crossed a semicolon' },
];

/** Why the gap is a standing property rather than a task list. */
const STANDING = {
  why: 'the numbers live in Chinese prose; deciding which tool and field a given "21 处" refers to is the sentence-grammar problem '
    + 'R620 hit',
  howItShrinks: 'only by writing new rounds with their numbers recomputed in their own tests — what R616 onward have been doing',
  laterStillCounts: 'R617 re-measured R600 populations from 21 to 2, a better check than any same-round test',
};

module.exports = { GAP, FAILURES, STANDING };
