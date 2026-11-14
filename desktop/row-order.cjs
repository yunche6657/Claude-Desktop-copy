'use strict';
// The two tools that never sort do produce a decidable order: rows inside one file follow declaration order, and the file order
// happens to be alphabetical. The first is a property of the scan; the second is a property of the filesystem.
//
// WHAT WAS CHECKED
//       stale-comment       67 files, 0 line-order violations — every file's rows are in increasing `line`
//       source-divergence   2 files, 0 violations by first-site line
//       stale-comment       the emitted FILE order equals the alphabetical sort of the same list
//
// THE TWO FACTS ARE NOT OF THE SAME KIND
//   In-file order is a CONSEQUENCE OF THE SCAN: `sources()` reads a file once and iterates its lines top to bottom, pushing rows as
//   it goes. No sort is involved, and no filesystem behaviour can change it. That makes it assertable.
//
//   File order is a CONSEQUENCE OF `readdirSync`. It is alphabetical here because NTFS returns directory entries in name order for
//   this tree. On a filesystem that does not — or after enough insertions and deletions — the same code returns a different order.
//   R611 measured this for the sorted tools; here it applies without even a comparator in the way.
//
// WHY THE DISTINCTION MATTERS FOR ASSERTIONS
//   An assertion on in-file order is a test of the tool: if a future change sorts rows or buffers them, the test fails and names the
//   file. An assertion on file order would be a test of the CHECKOUT: it passes on this machine and fails on a fresh clone whose
//   directory entries happen to differ. Writing the first and not the second is the whole point of separating them.
//
// WHAT WAS ADDED
//   `test/row-order-r612.test.mjs` asserts the in-file property for both tools and records — without asserting — that file order is
//   currently alphabetical. That gives the missing order assertion at the level where it is a property of the code.
//
// WHAT IS NOT CLAIMED
//   Not that alphabetical file order is guaranteed anywhere: it is measured once, on this tree, and no code enforces it.
//   Not that in-file order holds for every tool: these two build rows by scanning lines, and so does `set-key-symmetry`; the sorted
//   tools override it deliberately. A tool that gathered rows in a Map before emitting would violate it, and would be caught.

/** The two properties, measured, with their provenance. */
const ORDER = {
  inFile: {
    property: 'rows within one file are in increasing line order',
    measured: { 'stale-comment': { files: 67, violations: 0 }, 'source-divergence': { files: 2, violations: 0 } },
    why: 'sources() reads a file once and iterates its lines top to bottom, pushing rows as it goes — no sort involved',
    assertable: true,
    failsIf: 'a future change sorts rows or buffers them before emitting',
  },
  fileOrder: {
    property: 'files are emitted in alphabetical order',
    measured: 'true on this tree, for both tools',
    why: 'readdirSync returns directory entries in name order here (NTFS)',
    assertable: false,
    failsIf: 'the filesystem returns a different enumeration — a fresh clone, a network volume, enough insertions',
  },
};

/** Why only one of the two was turned into an assertion. */
const ASSERTION_CHOICE = {
  written: 'test/row-order-r612.test.mjs — asserts in-file order for both tools',
  notWritten: 'an assertion on alphabetical file order',
  why: 'in-file order is a property of the tool; file order is a property of the checkout. Asserting the second produces a test '
    + 'that passes here and fails elsewhere for reasons the tool cannot control.',
  recordedInstead: 'the measurement is in this file so a later reader knows the current answer without re-deriving it',
};

module.exports = { ORDER, ASSERTION_CHOICE };
