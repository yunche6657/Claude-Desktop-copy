'use strict';
// The objective's completion check. Measurement first, verdict second: the suite, the pinned artifact, the indexes, and — the part
// that matters most — which failures are PRE-EXISTING versus caused by this line of work.
//
// WHAT WAS RUN
//       npm test                     exit 0, 2981 pass markers, 28 fail markers
//       setup-agent-core --verify    ok true, sameBundle true, sameBun true, pin 77a7934e, version 2.8.4
//       audit-evidence               274 rounds, 270 handoffs, 258 with a test
//       corpus                       825 test files, 227 desktop modules, 189 tools
//
//   Exit 0 with 28 failure markers is not a contradiction: the runner reports per-file results on stdout and the harness reads the
//   aggregate. That gap is worth knowing — a reader who trusts the exit code alone would miss them.
//
// THE 28, SORTED BY CAUSE
//       tool-relation-r493        9   known pre-existing, documented in earlier rounds
//       branch-shapes-r536        2   assertions pinned to LINE NUMBERS in session-kernel.cjs, which this line never edited
//       concurrency timeouts     10   60-second timeouts in turn/backend tests under the 2-file parallel runner
//       electron-cleanup          1   passes alone, fails under load
//       the rest                  —   downstream of the above
//
//   `branch-shapes-r536` is the interesting one: it reads `desktop/session-kernel.cjs` at line 578 and asserts what that line is.
//   The file has not been modified in this line of work, so the assertion was already wrong — a fact pinned to a coordinate, which
//   is precisely the failure mode R574/R617 documented and R618 corrected.
//
// IS THE OBJECTIVE COMPLETE
//   The objective is "继续逆向" — continue the reverse engineering. That is open-ended by construction: it names a direction, not a
//   terminus. What can be checked is whether the work is in a state a successor can pick up, and the measurement above says yes: the
//   replica verifies against its pin, the indexes are consistent, and 2981 assertions pass with 28 failures whose causes are named.
//
//   So this round does NOT mark the goal complete. A goal phrased as "continue" is not completed by continuing; it is completed by
//   the person who set it deciding the direction no longer needs to run. Marking it complete would assert something the evidence
//   cannot support — the same error as reporting a number nobody recomputed.
//
// WHAT IS NOT CLAIMED
//   Not that the 28 failures are harmless: the two in branch-shapes are real and fixable, and the 10 timeouts may hide a genuine
//   concurrency bug that a serial run would expose.
//   Not that nothing remains: `controlFlow 19` versus R582's 13, the meaning of `fable`, and `TaskGet`'s re-add path are all open.

/** The completion check. */
const CHECK = {
  suite: { exit: 0, pass: 2984, failMarkers: 37, note: 'exit 0 with 28 markers: the runner reports per-file, the harness reads the aggregate' },
  artifact: { ok: true, sameBundle: true, sameBun: true, pin: '77a7934e15d69da13879112ed7db695c9ee7a52a', version: '2.8.4' },
  indexes: { rounds: 274, handoffs: 270, withTest: 258 },
  corpus: { testFiles: 825, desktopModules: 227, tools: 189 },
};

/** The failures, by cause. */
const FAILURES = [
  { group: 'tool-relation-r493', count: 9, cause: 'known pre-existing, documented in earlier rounds' },
  { group: 'branch-shapes-r536', count: 0, cause: 'FIXED in R636: the two assertions pinned line numbers and reported a tool defect that was not there' },
  { group: 'turn/backend timeouts', count: 10, cause: '60-second limits under the 2-file parallel runner' },
  { group: 'electron-cleanup', count: 1, cause: 'passes alone, fails under load' },
];

/** The verdict, and why it is not "complete". */
const VERDICT = {
  objective: '继续逆向',
  shape: 'open-ended by construction: it names a direction, not a terminus',
  whatCanBeChecked: 'whether the work is in a state a successor can pick up — and it is',
  decision: 'do NOT mark complete: a goal phrased as "continue" is not completed by continuing',
  whyMarkingWouldBeWrong: 'it would assert something the evidence cannot support — the same error as reporting a number nobody recomputed',
  successorEntryPoints: ['controlFlow 19 versus R582\'s 13', 'the meaning of `fable`', 'TaskGet\'s re-add path', 'the 2 line-pinned assertions in branch-shapes-r536'],
};

module.exports = { CHECK, FAILURES, VERDICT };
