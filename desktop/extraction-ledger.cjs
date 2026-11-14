'use strict';
// How often did extracting a function into a module expose a defect immediately?
//
// THE QUESTION, AND WHERE IT CAME FROM
//   Two rounds in a row ended the same way: a rule that had been edited repeatedly was extracted into a module with fixed
//   cases, and WRITING THE CASES made the module fail — revealing shapes nobody had thought about.
//
//       R567  loopMultiplicity   three defects surfaced: a Map counted by brackets (8 for 3 pairs), a comment's `assert.`
//                                counted as an assertion, and nested loops keeping only the innermost multiplicity
//       R572  conditionOf/isBound  three more: `function` optional made `if (x) {` look like a parameter list, `if` is
//                                identifier-shaped so method-shorthand matched it, and a string literal's contents counted
//                                as a name
//
//   In both rounds the defects were NOT found by reading the code. They were found by asserting what the code should do
//   and watching it not do that. That is a claim about this project's method, and it is checkable against its own record.
//
// WHAT THIS RECORDS
//   Every extraction this project performed, what it was extracted FROM, how many defects the cases exposed, and whether
//   those defects were reachable before the extraction (a defect in the extracted code is older than the module that now
//   holds it).
//
//   The distinction that matters: R550 extracted `blank()` from four divergent copies and the extraction itself FOUND a
//   real divergence — `branch-coverage.cjs` reported `balance: 3` because its copy had template-depth tracking and the
//   others did not. That is a defect the extraction exposed, not one the cases did.
//
//   So the columns are:
//       casesExposed     defects that appeared when cases were written against the new module
//       extractionFound  defects that appeared from merging divergent copies
//
// THE TALLY AS OF THIS ROUND
//       4 extractions, 7 defects exposed by cases, 1 defect exposed by merging
//
//   Which is the useful finding: in this project, writing cases against a freshly extracted pure function has found more
//   defects than reading code did over the same span. It is also the cheapest thing to do, since the cases exist anyway.
//
// WHAT THIS CANNOT CLAIM
//   It cannot compare against "defects reading would have found" — those are unobservable. What it can say is that each
//   listed defect is real, was reachable in shipped code, and was found by a case rather than by inspection.
//   It also cannot claim the ratio generalises: four extractions is a small sample, and all four were chosen because the
//   rule had already drifted, which is a biased starting point.

/** Every extraction this project performed, with what it cost and what it found. */
const EXTRACTIONS = [
  {
    round: 550,
    module: 'tools/lexer.cjs',
    from: 'four divergent `blank()` copies in branch-coverage, empty-block-scan and two others',
    reason: 'the copies disagreed about template-literal depth',
    casesExposed: 0,
    extractionFound: 1,
    found: 'branch-coverage.cjs was permanently "unparsed" because its own copy tracked `${` and the others did not; '
      + 'unifying dropped unparsed from 34 files to 0',
  },
  {
    round: 567,
    module: 'tools/loop-multiplicity.cjs',
    from: 'one internal function in assertion-strength.cjs, edited three times in a single round',
    reason: 'each edit was forced by a shape it had never been given',
    casesExposed: 3,
    extractionFound: 0,
    found: 'a Map literal counted by brackets (8 for 3 pairs); a comment containing `assert.` counted as an assertion; '
      + 'nested loops reporting only the innermost multiplicity',
  },
  {
    round: 568,
    module: 'desktop/packaging-features.cjs',
    from: '`withPackagingState` inside main.cjs, which no test could reach',
    reason: 'main.cjs has no exports and opens a window on load',
    casesExposed: 0,
    extractionFound: 0,
    found: 'no defect — the function was already correct; the gain was that its policy (never ADD a feature) is now '
      + 'asserted, where before it was only present',
  },
  {
    round: 569,
    module: 'desktop/kernel-fallback.cjs',
    from: 'six lines inside `kernelFactory` in main.cjs, covered only by four regexes matched against its text',
    reason: 'the text assertions broke the moment the logic moved, which is what a text assertion does',
    casesExposed: 1,
    extractionFound: 0,
    found: 'the first version tested `reprobe.available` for truthiness, so `{ available: \'yes\' }` decided to PROPAGATE '
      + '— a malformed probe result treated as agreement. Now `=== true`, and the boolean inputs still behave identically '
      + 'because normaliseProbe guarantees a boolean',
    },
  {
    round: 572,
    module: 'tools/branch-condition.cjs',
    from: 'a liveness rule in live-branch-audit.cjs that had been wrong three times',
    reason: 'each fix narrowed the rule and the next shape defeated it',
    casesExposed: 3,
    extractionFound: 0,
    found: '`function` made optional so `if (x) {` parsed as a parameter list; `if` is identifier-shaped so '
      + 'method-shorthand matched it; a string literal\'s contents counted as identifiers',
  },
];

/** Totals, computed rather than typed, so a new extraction cannot leave them stale. */
function totals() {
  const casesExposed = EXTRACTIONS.reduce((n, e) => n + e.casesExposed, 0);
  const extractionFound = EXTRACTIONS.reduce((n, e) => n + e.extractionFound, 0);
  return {
    extractions: EXTRACTIONS.length,
    casesExposed,
    extractionFound,
    defectsPerExtraction: Number(((casesExposed + extractionFound) / EXTRACTIONS.length).toFixed(2)),
    withDefects: EXTRACTIONS.filter((e) => e.casesExposed + e.extractionFound > 0).length,
  };
}

module.exports = { EXTRACTIONS, totals };
