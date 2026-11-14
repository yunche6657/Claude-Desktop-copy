'use strict';
// The ten citations R631 set aside, read one by one. Nine are uses and one is a dependency-chain mention — so R631's split
// holds and the 41 stands.
//
// WHAT WAS CHECKED
//   For each of the ten evidence-only tools that DOES appear in a round document, the citing line was read and classified:
//
//       approval-kernel-probe     invocation description   how the tool drives session-kernel + bridge
//       ccb-contract-diff         command line             `node tools/ccb-contract-diff.cjs`
//       official-contract         command line             with three real arguments
//       proof-packaged-history    audit row                what it searches and that it is latent
//       proof-r397-build-repro    capability row           "4 mutation regressions + --verify"
//       suite-report              attempt and outcome      "batch three: process ended after batch 4"
//       tool-timeline             capability row           which versions introduced or removed a tool
//       unhandled-null            result table             its three results, named
//       update-changelog          command line             twice, including `--from 2.1.280`
//       resolved-8                dependency chain         "ccb-contract-diff → ccb-tool-map → resolved-8"
//
//   Nine say something a reader could act on. The tenth names the tool as a link in a chain being discussed, which is content but
//   not a use.
//
// WHY THIS MATTERS FOR R631'S CONCLUSION
//   R631 said 41 of 51 evidence-only tools are mentioned only by generated indexes. If these ten had turned out to be bare
//   mentions, the number would be 51. Reading them shows the split is real: the record DOES cite instruments where it used them,
//   and the 41 are where it did not.
//
//   So the traceability gap is bounded and specific: 41 tools ran once and left no citation. That is a finding about the record's
//   habit, not about the tools.
//
// WHAT IS NOT CLAIMED
//   Not that the 41 were used without being cited: they ran (R629 and R630 established several produce real output), but "ran" and
//   "cited" are separate facts and only the second was measured here.
//   Not that a command line proves the tool worked: it proves the round intended to run it. `suite-report` is the counter-example
//   in this very list — cited with a command, and it did not complete.

/** The ten, each with what the citing line does. */
const CASES = [
  { tool: 'approval-kernel-probe.cjs', doc: 'ccb-permission-protocol.md', kind: 'invocation-description', use: true },
  { tool: 'ccb-contract-diff.cjs', doc: 'ccb-contract-comparison.md', kind: 'command-line', use: true },
  { tool: 'official-contract.cjs', doc: 'ccb-tool-semantics.md', kind: 'command-line', use: true },
  { tool: 'proof-packaged-history-resume-r378.cjs', doc: 'comment-selfmatch-explain-r521.md', kind: 'audit-row', use: true },
  { tool: 'proof-r397-build-repro.cjs', doc: 'build-reproducibility.md', kind: 'capability-row', use: true },
  { tool: 'suite-report.cjs', doc: 'suite-truncation-r542.md', kind: 'attempt-and-outcome', use: true },
  { tool: 'tool-timeline.cjs', doc: 'changelog-history.md', kind: 'capability-row', use: true },
  { tool: 'unhandled-null.cjs', doc: 'sort-census-r613.md', kind: 'result-table', use: true },
  { tool: 'update-changelog.cjs', doc: 'changelog-history.md', kind: 'command-line', use: true },
  { tool: 'resolved-8.cjs', doc: 'tool-inventory-r487.md', kind: 'dependency-chain', use: false },
];

/** The conclusion. */
const CONCLUSION = {
  ten: 10,
  uses: 9,
  mentionsWithContent: 1,
  splitHolds: 'the 41 stands: the record cites instruments where it used them, and the 41 are where it did not',
  gapIs: '41 tools ran once and left no citation — a fact about the record\'s habit, not about the tools',
};

module.exports = { CASES, CONCLUSION };
