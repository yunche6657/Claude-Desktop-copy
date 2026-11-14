'use strict';
// The hunt for snapshot assertions ended with a different finding: the records are all consistent right now, and the two
// "DRIFT" reports this round produced were both my own pattern-matching errors.
//
// WHAT WAS LOOKED FOR
//   R620 closed by proposing to find `assert.equal(<computed>, <literal>)` sites whose literal should have been a relation. Measured:
//   447 such sites, and the four that count files all use SYNTHETIC data (`diff.files.length === 400` on a fabricated diff), so
//   none of them moves with the repository. The proposed class of defect does not exist at scale.
//
// WHAT WAS FOUND INSTEAD — TWICE
//   Turning to record-versus-tool drift, the first probe reported:
//
//       set-lifetimes population   tool=41   record=null   **DRIFT**
//       map-key-reach maps         tool=202  record=6      **DRIFT**
//
//   Both were the pattern, not the data. `exposure-set-lifetimes.SETS` is an array of THREE sets — the 41 belongs to
//   `set-lifetimes.cjs`, a different object. And `unasserted-fields.counts2` is `unstableDisagree` (6), not the map count (202).
//   Read correctly:
//
//       unasserted-fields.counts2 = 6    tool unstableDisagree  = 6    MATCH
//       unasserted-fields.counts  = 7    tool unstableSet rows  = 7    MATCH
//       rescan-after-mask.after   = 2    tool candidates        = 2    MATCH
//       sort-census map ties      = 31   measured ties          = 31   MATCH
//
// WHY THIS IS THE ROUND'S REAL RESULT
//   A pattern-matching probe is a hypothesis generator, and a wrong hypothesis that reaches a written conclusion is exactly the
//   failure class this line of work keeps meeting — R574's offset, R617's offsets, R618's corrected citations. The instruments in
//   this repo are right; what was wrong was my reading of two field names.
//
//   So the snapshot-assertion programme is closed as NOT A PROBLEM, on evidence: 447 numeric assertions, zero that move with the
//   tree, and four record-versus-tool pairs that all currently agree.
//
// WHAT IS NOT CLAIMED
//   Not that no snapshot assertion can go stale: R617's counters DID go stale, three rounds running, which is why R620 rewrote them
//   as relations. That was a real instance and it is fixed. What this round shows is that it is not a widespread class.
//   Not that the four matched pairs will keep matching: each is a record recomputed by a test, so a tool change will break the
//   record, and that is the intended behaviour — the failure is the signal.

/** The assertion census. */
const ASSERTIONS = {
  sites: 447,
  countingFiles: 4,
  allSynthetic: true,
  note: 'the four `diff.files.length === N` sites use fabricated diffs, so they do not move with the repository',
  verdict: 'the proposed class of defect does not exist at scale',
};

/** The two false alarms, and what was really there. */
const FALSE_ALARMS = [
  {
    firstRead: 'exposure-set-lifetimes.SETS versus the tool\'s 41',
    reported: 'DRIFT',
    actual: 'SETS is an array of 3; the 41 belongs to set-lifetimes.cjs, a different object',
  },
  {
    firstRead: 'unasserted-fields.counts2 versus the tool\'s 202 maps',
    reported: 'DRIFT',
    actual: 'counts2 is unstableDisagree (6), not the map count',
  },
];

/** The pairs that DO agree, checked by running the tools. */
const AGREEMENTS = [
  { record: 'unasserted-fields.counts2', value: 6, tool: 'map-key-reach.unstableDisagree', toolValue: 6 },
  { record: 'unasserted-fields.counts', value: 7, tool: 'map-key-reach unstableSet rows', toolValue: 7 },
  { record: 'rescan-after-mask.after', value: 2, tool: 'source-divergence.candidates', toolValue: 2 },
  { record: 'sort-census map ties', value: 31, tool: 'map-key-reach tied groups', toolValue: 31 },
];

module.exports = { ASSERTIONS, FALSE_ALARMS, AGREEMENTS };
