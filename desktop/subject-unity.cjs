'use strict';
// R606 checked that R605's 21 rows are TRUE. This round checks whether they are ABOUT ONE VALUE — and 10 of 21 are not.
//
// WHAT R606 RELIED ON
//   R606 argued that a necessary predicate plus an output that "states only what the predicate established" reaches an emit/flag
//   ratio of 1.00, and cited R605 as the example: 21 rows, all true statements. Measured here:
//
//       every row's cited line exists and contains a `name = value` assignment   21 / 21
//       the internal and external sites share a function scope                   11 / 21
//
//   So the first half holds and the second does not. Ten of the twenty-one rows combine an assignment in one function with an
//   assignment in ANOTHER function, where the two `name`s are unrelated local variables that happen to be spelled alike.
//
// THE TEN, AND WHY THEY PASSED
//       background-check.cjs   r      visit()                 runBackgroundCheck()
//       bridge-services.cjs    cwd    HT()                    jD()
//       bridge-services.cjs    r      rh()                    mcpWidgetRefusal()
//       bridge-services.cjs    running ck()                   rh()
//       ccb-kernel.cjs         env    spawnProcess()          configureSession()
//       ccb-kernel.cjs         requestId sendControl()        handleFrame()
//       ccb-kernel.cjs         response (module scope)        handleFrame()
//       ccb-kernel.cjs         turn   rejectTurn()            acceptSteer()
//       git-status.cjs         pos    parseStatus()           fieldEnd()
//       native-git-diff-core.cjs a    ea()                    jv()
//
//   The tool's own filter is `hasInternal && hasExternal` over the sites of ONE NAME in one file. Nothing in it requires the sites
//   to be in one scope, so two unrelated `r` variables satisfy it. That is a definitional gap, not a coding slip: the pattern was
//   described as "one name, two provenances", and one name in two scopes is two names.
//
// WHAT THIS DOES TO R606'S ARGUMENT
//   R606's conclusion survives, but its example was weaker than claimed. "Necessary predicate + honest label" still reaches
//   ratio 1.00 — R595 demonstrates that — but R605 at 21 rows is really 11 rows plus 10 coincidences. The honest label was
//   accurate about what the PREDICATE established; the predicate itself was satisfied by a coincidence.
//
//   So the layered account gains a fourth requirement, and it is the one this round measures: the predicate must be evaluated
//   over ONE SUBJECT. `hasInternal && hasExternal` over a name is not a subject unless the name denotes one variable.
//
// THE FIX IS ONE LINE, AND THIS ROUND DOES NOT APPLY IT
//   Requiring `fnOf(internalSite) === fnOf(externalSite)` would cut 21 to 11. Applying it changes the tool's output and would make
//   R600's recorded 21 wrong, so the change belongs in a round that re-measures everything downstream. What this round records is
//   the measurement and the reason the number is 11.
//
// WHAT IS NOT CLAIMED
//   Not that the 11 shared-scope rows are defects: R600 read four and dismissed them (different types, different variables in one
//   handler). Sharing a scope makes a row ABOUT one value; it does not make the two provenances dangerous.
//   Not that `(module scope)` rows are fine: four of the eleven report module scope on both sides, which the same locator cannot
//   distinguish from a genuinely shared top-level variable.

/** The verification, split into the two questions. */
const VERIFICATION = {
  rowsExamined: 21,
  lineExistsAndAssigns: 21,
  sharedScope: 11,
  differentScope: 10,
  conclusion: 'every row is a true statement; ten of them are about two unrelated variables with one spelling',
};

/** The ten that combine two scopes, with both function names as the locator reports them. */
const CROSS_SCOPE = [
  { file: 'desktop/background-check.cjs', name: 'r', internalFn: 'visit', externalFn: 'runBackgroundCheck' },
  { file: 'desktop/bridge-services.cjs', name: 'cwd', internalFn: 'HT', externalFn: 'jD' },
  { file: 'desktop/bridge-services.cjs', name: 'r', internalFn: 'rh', externalFn: 'mcpWidgetRefusal' },
  { file: 'desktop/bridge-services.cjs', name: 'running', internalFn: 'ck', externalFn: 'rh' },
  { file: 'desktop/ccb-kernel.cjs', name: 'env', internalFn: 'spawnProcess', externalFn: 'configureSession' },
  { file: 'desktop/ccb-kernel.cjs', name: 'requestId', internalFn: 'sendControl', externalFn: 'handleFrame' },
  { file: 'desktop/ccb-kernel.cjs', name: 'response', internalFn: '(module scope)', externalFn: 'handleFrame' },
  { file: 'desktop/ccb-kernel.cjs', name: 'turn', internalFn: 'rejectTurn', externalFn: 'acceptSteer' },
  { file: 'desktop/git-status.cjs', name: 'pos', internalFn: 'parseStatus', externalFn: 'fieldEnd' },
  { file: 'desktop/native-git-diff-core.cjs', name: 'a', internalFn: 'ea', externalFn: 'jv' },
];

/** The fourth requirement this round adds to R605/R606's hierarchy. */
const FOURTH_REQUIREMENT = {
  requirement: 'the predicate must be evaluated over ONE SUBJECT',
  violatedBy: 'hasInternal && hasExternal over a NAME, because one name in two scopes is two names',
  measurement: '21 rows pass the predicate; 11 of them denote one variable',
  fix: 'require fnOf(internalSite) === fnOf(externalSite)',
  notApplied: 'it changes the tool output and would falsify R600\'s recorded 21 before a re-measurement round',
};

module.exports = { VERIFICATION, CROSS_SCOPE, FOURTH_REQUIREMENT };
