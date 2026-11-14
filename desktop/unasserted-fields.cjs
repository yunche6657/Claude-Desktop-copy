'use strict';
// Ten fields across eight tools are computed and never asserted. One of them looked like a contradiction for a minute; the
// definitions hold, and the absence of the assertion is what made that minute necessary.
//
// THE METHOD
//   For each tool, take the field names of its `--json` rows and subtract the names its test files mention. The remainder is
//   what the tool computes that nothing checks. Measured across eight tools:
//
//       R590  set-lifetimes        declaredAt
//       R591  set-reset-reach      declaredAt
//       R593  set-key-symmetry     declaredAt, adds
//       R594  map-key-reach        declaredAt, setShape, readOp, readShape, and top-level unstableDisagree
//       R595  clear-asymmetry      coMentionLine
//       R601  stale-comment        line, and top-level total
//       R600  source-divergence    (none)
//       R602  denial-vs-witness    (none)
//
//   `declaredAt` dominates because it is display data: a line number a reader uses, never a claim. That is the benign class.
//
// THE ONE THAT LOOKED WRONG
//   `map-key-reach` reports `unstableDisagree: 6` while 7 rows carry `unstableSet: true`. Two numbers a reader would expect to
//   match, and they do not — because they are different quantities:
//
//       unstableSet === true            7   the SET key's shape is a call, computed, or constructed
//       unstableDisagree                6   of those, the ones where the read key also differs (`agrees === false`)
//
//   The seventh is `pending`, whose set and read keys are textually identical (`key(id,origin)` both sides). Its shape is a
//   call so the instability flag fires, and its keys agree so the disagreement filter excludes it. Both numbers are right.
//
// WHY THIS IS STILL WORTH RECORDING
//   The relationship `unstableDisagree === count(unstableSet && !agrees)` is a derived fact, and a derived fact that no test
//   states can drift silently: any refactor of `disagrees` or `unstableSet` would change one number and not the other, and a
//   reader comparing them would conclude the tool is broken rather than reading the definition. R596's comma-declaration bug and
//   R609's mask regression were both found because a number moved — the value of a field being pinned is that its movement is
//   noticed.
//
// THE OTHER UNASSERTED FIELDS, CHECKED
//       setShape / readShape      verified equal to keyShape() on the recorded text for every row — 0 mismatches
//       readOp                    verified against the file: 'get' where a .get( exists, 'delete' otherwise — 0 inconsistent
//       adds                      the count of `NAME.add(` calls; display data like declaredAt
//       coMentionLine             a line number
//       line / total              line numbers and a sum
//
//   So nine of the ten are display or derivable, and one (the unstable pair) is a definition that works. Nothing here is a defect;
//   what is missing is the assertion that would say so on the next change.
//
// WHAT IS NOT CLAIMED
//   Not that a name appearing in a test file means the field is asserted: the check is textual, so a field mentioned only in a
//   comment counts as covered. That inflates coverage, which is the safe direction for this measurement.
//   Not that these ten are the whole gap: implicit fields (a row's absence, the ORDER of rows) are not named anywhere and cannot
//   be found this way. R594's sort is exactly such a property.

/** Every field the tools compute that no test names. */
const UNASSERTED = [
  { round: 'R590', tool: 'set-lifetimes', fields: ['declaredAt'], kind: 'display' },
  { round: 'R591', tool: 'set-reset-reach', fields: ['declaredAt'], kind: 'display' },
  { round: 'R593', tool: 'set-key-symmetry', fields: ['declaredAt', 'adds'], kind: 'display' },
  { round: 'R594', tool: 'map-key-reach', fields: ['declaredAt', 'setShape', 'readOp', 'readShape'], kind: 'display+derived' },
  { round: 'R594', tool: 'map-key-reach', fields: ['unstableDisagree'], kind: 'derived', top: true },
  { round: 'R595', tool: 'clear-asymmetry', fields: ['coMentionLine'], kind: 'display' },
  { round: 'R601', tool: 'stale-comment', fields: ['line'], kind: 'display' },
  { round: 'R601', tool: 'stale-comment', fields: ['total'], kind: 'derived', top: true },
];

/** The pair that looked contradictory and is not. */
const DERIVED_PAIR = {
  detailed: 'unstableSet === true',
  counts: 7,
  summary: 'unstableDisagree',
  counts2: 6,
  relation: 'unstableDisagree === count(unstableSet && !agrees)',
  theSeventh: 'pending — set and read are both `key(id,origin)`, so its shape is a call but its keys agree',
  bothCorrect: true,
  riskIfUnpinned: 'a refactor of either filter changes one number and not the other, and a reader comparing them would call the '
    + 'tool broken',
};

module.exports = { UNASSERTED, DERIVED_PAIR };
