'use strict';
// The checklist R633 hung on `AGENTS.md` is reachable by a human reader and by nothing else. That is the honest limit of the
// artefact, and it is worth recording rather than implying the link is enforced.
//
// WHAT WAS CHECKED
//       files in tools/ test/ desktop/ that mention AGENTS.md        1
//       … of those, that actually READ it                             0   (the one is a comment in a test)
//       package.json scripts mentioning AGENTS.md                     0
//       tests linking AGENTS.md to MEASUREMENT-CHECKLIST.md           0
//
//   So no code path loads `AGENTS.md`. An agent reading it at session start is a convention of the harness, not something this
//   repository enforces, and no test would fail if the section were deleted.
//
// WHY THAT MATTERS AND WHY IT IS STILL WORTH HAVING
//   A checklist nobody executes is a document, not a constraint. But this repository's own history shows why the document still
//   earns its place: R621–R626 are five rounds of the same misreading, and the only mechanism that stopped it was not a rule but a
//   test that recomputed the number (R616 onward). The checklist is what a reader consults BEFORE writing a number; the tests are
//   what catch them after.
//
//   So the honest statement is: the checklist is advisory, and the enforcement is elsewhere — in `assert` statements that re-derive
//   values with the tools rather than trusting a prose count.
//
// WHAT WOULD MAKE IT ENFORCED, AND WHY IT IS NOT DONE
//   A test could read `AGENTS.md`, extract the checklist path, and assert the file exists and stays non-empty. That would catch a
//   broken link, which is the one failure mode this arrangement actually has. It is not done here because R633 already tested that
//   every rule's rounds appear in the document, and adding a second guard over the same artefact would assert the link twice.
//
// THE MEASUREMENT CHANGES THE MEASURED
//   R634's own test reads `AGENTS.md` to check that the section still points at the checklist, which makes it the first reader in
//   the repository. The count in REACH excludes that file: a measurement of "how many code paths load this" that adds a loading
//   path while running is measuring itself. What remains true is that no tool, no suite entry point, and no package script
//   reads the file — only a test asserting the link.
//
// WHAT IS NOT CLAIMED
//   Not that no future automation will read it: the harness may add instruction loading. This measures the repository as it stands.
//   Not that the checklist is unenforced in spirit: R633's test does assert the document matches the data, so the CONTENT cannot
//   drift even though the LINK is not checked.

/** The reach measurement. */
const REACH = {
  filesMentioning: 1,
  filesReading: 0,
  theOneIs: 'a comment in test/selfmatch-baseline-r523.test.mjs, not a read',
  packageJsonScripts: 0,
  testsLinkingAgentsToChecklist: 0,
  conclusion: 'no code path loads AGENTS.md; the section is advisory',
};

/** What is actually enforced. */
const ENFORCEMENT = {
  advisory: 'the checklist is what a reader consults before writing a number',
  enforced: 'the tests that recompute values with the tools, which is what actually stopped the R621–R626 misreadings',
  contentGuard: 'R633 asserts every rule\'s rounds appear in the document, so the CONTENT cannot drift even though the LINK is unchecked',
  honestStatement: 'the checklist is advisory and the enforcement is elsewhere',
};

module.exports = { REACH, ENFORCEMENT };
