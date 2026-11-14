'use strict';
// The 12-fact list: a legitimate shared constant, with an asymmetry that makes its ORDER load-bearing on one side only.
//
// WHAT R577 CHECKED, AND WHY THE KEY HELD
//   R576's ledger listed `duplicated-lists` as `sound` but noted its key had never been challenged since R553. R577 took
//   the largest group — 12 members, 2 sites — and read both:
//
//       desktop/keep-awake-activity.cjs:6    const REQUIRED = ['remoteClient', 'violinBow', …];
//       test/keep-awake-activity-r378:17     const keys = ['remoteClient', 'violinBow', …];
//
//   The test needs the same twelve fact names to enumerate all 4096 boolean combinations and to build a base object of
//   falses. That is a legitimate shared list: the test asserts that `activityKind` agrees with the original bundle's
//   `sessionActivityKind` across every combination, and it cannot do that without naming every fact. The key held.
//
// THE ASYMMETRY THE READING TURNED UP
//   The two sides use the list differently, and only one side's order matters:
//
//       production   REQUIRED.some(key => typeof facts[key] !== 'boolean')
//                    ORDER DOES NOT MATTER — a completeness check
//
//       test         keys.map((key, index) => [key, Boolean(mask & (1 << index))])
//                    ORDER MATTERS — the index IS the bit
//
//   So the test's copy must match the production order exactly. If a reorder ever happened on the production side, the test
//   would enumerate the same 4096 bit patterns assigned to DIFFERENT facts — and still pass, because it compares against
//   the same permutation it built. That is the hazard: a silently different test, not a failing one.
//
//   Both copies are in the same order today. Neither side records that the order is load-bearing, which is what this file
//   does.
//
// THE DETECTOR, AND ITS OWN LIMIT
//   `tools/index-order-lists.cjs` looks for repeated lists where one site walks the list by index and another does not.
//   First version asked whether the FILE contained any `.map((x, i)` — true of almost every file here — and reported 37 of
//   102 groups. Scoped to the twelve lines after each site: 3 groups. The third of those is a false positive: both
//   `script-index.cjs` sites are `for (const key of [...])`, and the window caught an unrelated `.entries()` twelve lines
//   below. Recorded rather than patched further, for the reason R571 established — a rule patched a third time starts
//   inventing shapes.
//
// WHAT IS NOT CLAIMED
//   Not that the other 11 test keys are correct in the way this one is: the detector only finds asymmetry, and the two
//   remaining hits are (a) a deletion list where order cannot matter and (b) the false positive above.
//   Not that the test would catch a production reorder. It would not — it builds its expectation from the same permuted
//   list. What would catch it is a reorder of the PRODUCTION list changing the classification while the test still passes,
//   which nothing observes.

/** The shared list, both sites, and which side's order is load-bearing. */
const KEEP_AWAKE_FACTS = {
  members: ['remoteClient', 'violinBow', 'hasQuery', 'lanyardConnected', 'turnRunning', 'unattended', 'waitingOnUser',
    'hasHeldInput', 'heldInputSurvives', 'losableBackground', 'liveCron', 'liveLoop'],
  production: {
    file: 'desktop/keep-awake-activity.cjs',
    line: 6,
    use: 'REQUIRED.some(key => typeof facts[key] !== \'boolean\')',
    orderMatters: false,
  },
  test: {
    file: 'test/keep-awake-activity-r378.test.mjs',
    line: 17,
    use: 'keys.map((key, index) => [key, Boolean(mask & (1 << index))])',
    orderMatters: true,
  },
  combinations: 2 ** 12,
  hazard: 'a production reorder changes which fact each bit means; the test builds its expectation from the same permuted '
    + 'list, so it would still pass while testing a different mapping',
};

module.exports = { KEEP_AWAKE_FACTS };
