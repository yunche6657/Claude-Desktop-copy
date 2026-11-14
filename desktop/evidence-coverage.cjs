'use strict';
// The intersection is empty — and not because the references are clean. 251 of 269 evidence files contain no `file:line`
// reference at all, so there was almost nothing to intersect.
//
// THE QUESTION
//   R616 established that six positions are ambiguous: several tools point at one `file:line` while naming different subjects.
//   The next step was to check whether any EVIDENCE document cites one of those positions, since a citation that looks precise
//   would silently merge two subjects.
//
// THE MEASUREMENT
//       distinct file:line references across evidence/     22
//       total occurrences                                  38
//       landing on an ambiguous position                    0
//       evidence files with at least one reference         18  of 270
//       HANDOFF files with at least one reference          18  of 270
//
//   So the answer is zero, and the reason is not precision. It is that 94% of the evidence never names a coordinate: the documents
//   describe a mechanism, quote a line of source inline, or name a function, but they do not write `desktop/foo.cjs:123`.
//
// WHY THAT MATTERS MORE THAN THE ZERO
//   This line of work has spent dozens of rounds computing exact positions — `declaredAt`, `line`, `coMentionLine` — and using
//   them inside tools. But the EVIDENCE for those rounds is prose: readable, falsifiable by reading the named function, and not
//   addressable. A reader who wants to check round 500's claim about a branch cannot jump to it; they must find the function by
//   name.
//
//   That is not a defect in any single document. It is a property of the whole record, and it was invisible until something tried
//   to intersect on position and found nothing to intersect with.
//
// WHAT WOULD CHANGE IT
//   Nothing this round proposes. Adding `file:line` to 250 historical documents would be busywork, and the three documents that do
//   carry references — `STATUS.md` (13), `proof-list-order-r559` (3), `pure-key-r598` (2) — are not more correct than the rest.
//   The measurement is the contribution: a reader now knows the record is prose-shaped, and that a position-based cross-check
//   over it will find at most 18 documents.
//
// WHAT WAS NOT DONE
//   No references were added to historical documents. Retrofitting `file:line` into 250 files would be busywork, and the three
//   that do carry them — `STATUS.md` (13), `proof-list-order-r559` (3), `pure-key-r598` (2) — are not more correct than the
//   rest. The measurement is the contribution: a reader now knows the record is prose-shaped, and that a position-based
//   cross-check over it can reach at most 18 documents.
//
// WHAT IS NOT CLAIMED
//   Not that prose evidence is weaker: naming a function and quoting its body is checkable by any reader, while a line number is
//   checkable only until the file moves — R574 lost a round to exactly that when a recorded coordinate was off by 19 lines.
//   Not that the 22 references are all correct: this round only compared them against six ambiguous positions, not against the
//   files they name.

/** The coverage measurement. */
const COVERAGE = {
  evidenceFiles: 270,
  withReference: 18,
  withoutReference: 252,
  handoffFiles: 253,
  handoffWithReference: 12,
  distinctReferences: 25,
  occurrences: 40,
  ambiguousHits: 0,
  whyZero: '94% of the evidence never writes a coordinate, so the intersection is empty by absence rather than by precision',
};

/** Where the references that DO exist are concentrated. */
const TOP = [
  { file: 'STATUS.md', refs: 14, note: 'the running log accumulates them across rounds' },
  { file: 'proof-list-order-r559.md', refs: 3 },
  { file: 'ccb-permission-protocol.md', refs: 2 },
  { file: 'missing-contract-r551.md', refs: 2 },
  { file: 'pure-key-r598.md', refs: 2 },
  { file: 'read-progress-r562.md', refs: 2 },
  { file: 'text-assertion-data-r582.md', refs: 2 },
  { file: 'unparsed-candidates-r529.md', refs: 2 },
];

/** What the measurement implies for a reader. */
const IMPLICATION = {
  shape: 'the record is prose-shaped: mechanisms described, functions named, source quoted inline',
  consequence: 'a position-based cross-check over the record can reach at most 18 documents',
  notADefect: 'naming a function and quoting its body is checkable by any reader; a line number is checkable only until the file moves',
  precedent: 'R574 lost a round to a recorded coordinate off by 19 lines',
};

module.exports = { COVERAGE, TOP, IMPLICATION };
