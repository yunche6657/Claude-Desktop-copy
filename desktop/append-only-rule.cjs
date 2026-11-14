'use strict';
// The classification R621 proposed is not mechanisable, and the reason is worth more than the classification would have been:
// in 727 size-pinning assertions, the collection being sized is almost always a FIXTURE the test built, not a live artifact.
//
// WHAT WAS ATTEMPTED
//   R621 proposed splitting `assert.equal(<.length>, <n>)` into "evidence-derived, so use >=" and "source-derived, so use ===".
//   Measured: 727 such assertions. Classifying them by the text of the left-hand side put 717 in `fixture` and produced 10
//   "evidence-derived" rows that were all misreads of my own regex — it matched across a `;` and swallowed the neighbouring
//   assertion, so `assert.equal(coverage.branches.length === 26` is a fragment of `assert.equal(coverage.branches.length, 26)`.
//
//   The instrument was wrong, not the code under it. That is the second time in two rounds: R621 caught itself reporting two
//   false DRIFTs from a pattern.
//
// WHAT A DIRECT SEARCH FOUND
//   Tests that read an append-only artifact (anything under `evidence/`): 37 files. Of those, the ones that ALSO pin a size are
//   mostly pinning fixtures — `interrupts.length === 1`, `asked.length === 1`, `transcript.length === 4`, `launches.length === 2`.
//   Those collections are built inside the test, so they do not grow with the repository, and `===` is exactly right for them.
//
//   The genuine append-only pins were the three R620 already rewrote as relations (evidence-coverage, citation-census,
//   drift-model) plus the survey in this round. Nothing else was left to convert.
//
// WHY THE RULE STILL HOLDS AND STILL MATTERS
//   "Append-only data gets `>=`; fixed source gets `===`" is correct as a RULE. What this round establishes is that the rule has
//   almost no instances here — because this repo's tests nearly always assert on data they constructed. The rule was worth stating
//   and is not worth a sweep.
//
// WHAT IS NOT CLAIMED
//   Not that no other append-only pin exists: the search looked for tests that READ `evidence/`. A test that imported a census
//   module without naming the directory would be missed — and the census modules all live in `desktop/`, imported by name.
//   Not that 727 is the true count of size pins: the regex requires a numeric literal second argument, so an assertion against a
//   named constant is not counted.

/** What the sweep found. */
const SWEEP = {
  sizePins: 727,
  classifiedAsFixture: 717,
  falselyClassifiedAsEvidence: 10,
  whyFalse: 'the regex matched across a `;` and swallowed the neighbouring assertion',
  testsReadingEvidence: 37,
  genuineAppendOnlyPins: 3,
  alreadyFixedBy: 'R620 — rewritten as relations',
};

/** The rule, kept — with its scope narrowed by measurement. */
const RULE = {
  statement: 'append-only data gets `>=`; fixed source gets `===`',
  instancesHere: 3,
  verdict: 'correct and worth stating, not worth a sweep: this repo almost always asserts on data it constructed',
  whyItStillMatters: 'the three instances HAD gone stale three rounds running before R620 fixed them',
};

module.exports = { SWEEP, RULE };
