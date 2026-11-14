'use strict';
// The container was wrong: a property of a FILE was being answered by a detector of LISTS.
//
// THE NUMBERS
//   `tools/replica-file-census.cjs` counts test files that read official material and execute a slice — the R562 shape,
//   counted directly:
//
//       replica-shaped files                            54
//       ... appearing in at least one repeated list     12
//       ... in no list group at all                     42      78%
//
//   `group-provenance` can only see the 12, because it walks repeated-list sites. For the other 42 it never looked, and
//   `cli-mcp-host-sources-r378.test.mjs` is one of them: it reads three chunks and runs slices of all three.
//
// WHAT IS AND IS NOT WRONG HERE
//   `group-provenance` is not wrong. Its question — "is this LIST a replica pair rather than duplication" — is answerable,
//   and its answers held when read (R563 verified four; R578 added a fifth). What is wrong is the inference that its output
//   describes the population of replica-shaped tests. It describes 22% of it.
//
//   That distinction matters because the replica-versus-original idea exists to stop this project from "unifying" two
//   constants that exist to be compared. A rule that sees a fifth of the cases gives a false sense of coverage.
//
// WHY THE SHAPE OF THIS FAILURE KEEPS RECURRING
//   R574 keyed by field name; R578 keyed on two facts in one expression; this round finds the analysis attached to the
//   wrong subject entirely — a list instead of a file. Each time the mechanism was right and the SUBJECT was wrong. The
//   detector-keys ledger (R576) records keys; it has no column for "what is this a property of", which is the column this
//   round needed.
//
// WHAT THIS FILE DOES NOT DO
//   It does not re-run the census; `tools/replica-file-census.cjs` does, and its output is asserted in the test. This file
//   records the interpretation, which is the part a census cannot produce.
//
//   It also does not present the 42 as a work list. They are a population, not a defect list: the census asserts only that
//   reading and executing coexist in one file, not that the two are related within it. What the number establishes is
//   narrower and still useful — the four verified groups in R563 are not a survey, they are four of 54.

/** The population the list detector can see, and the population that exists. */
const CENSUS = {
  replicaShapedFiles: 54,
  visibleToListDetector: 12,
  invisibleToListDetector: 42,
  percentInvisible: 78,
  example: 'cli-mcp-host-sources-r378.test.mjs reads three chunks from ../ccd-ref/asar/.vite/build and runs slices of all '
    + 'three, and appears in no repeated-list group because it happens not to repeat a list',
};

/**
 * The question `group-provenance` actually answers, stated so its output cannot be read as the broader claim.
 */
const SCOPE = {
  answers: 'is this repeated LIST a replica-versus-original pair rather than duplication',
  doesNotAnswer: 'which test files are replica-shaped',
  why: 'it walks repeated-list sites, so a replica-shaped file with no repeated list is never visited',
};

/**
 * The column R576's ledger lacks.
 */
const MISSING_LEDGER_COLUMN = {
  column: 'what the detector\'s key is a property OF',
  examples: [
    { tool: 'strict-contract-audit', subject: 'a field on one receiver', correct: true },
    { tool: 'group-provenance', subject: 'a repeated list', drifted: 'was being read as "a test file"' },
    { tool: 'duplicated-lists', subject: 'a bracketed string literal', correct: true },
  ],
  note: 'when the subject drifts, every part of the mechanism can stay right and the conclusion still describes the '
    + 'wrong population',
};

module.exports = { CENSUS, SCOPE, MISSING_LEDGER_COLUMN };
