'use strict';
// Three call sites, three different failure modes — and only two of them are ever asserted.
//
// THE THREE SITES (desktop/cli-mcp-host-sources.cjs)
//       :50   disposers.push(next.onFeatureChange('513873720', observe));
//       :51   disposers.push(next.observeFeatureGate('513873720', observe));
//       :60   runtime.getFeatureValue('513873720', undefined);
//
//   They are not redundant. Reading the provider (desktop/growthbook-provider.cjs):
//
//       onFeatureChange    (:299)   subscribes to `changeListeners` AND fires immediately with the current value
//       observeFeatureGate (:298)   subscribes to `gateListeners` only — no immediate call
//       getFeatureValue    (:283)   calls synchronize(), reads `features[key]`, calls exposure(key,item), returns item.value
//                                   — the RETURN IS DISCARDED here, so only the synchronise and exposure effects matter
//
// WHAT EACH TYPO WOULD DO
//       :50 mistyped   the change subscription watches a key nothing writes. The gate stops updating when the feature
//                      changes, but still receives an initial value from :51 once features load. A STALE gate: enabled
//                      stays enabled, or dark stays dark, through every subsequent change.
//
//       :51 mistyped   the gate subscription watches a dead key. The initial value still arrives, because
//                      onFeatureChange fires immediately — but a change that arrives through the gate channel is never
//                      delivered. Same visible symptom as :50, different mechanism.
//
//       :60 mistyped   synchronize() takes no key, so the account/source synchronisation still happens; what changes is
//                      exposure(key,item), which records an experiment exposure against the wrong flag. No functional
//                      difference at all, and no assertion anywhere would notice.
//
//   The third one is the interesting case and it is the one this round was checking: a typo there is INVISIBLE in behaviour
//   and invisible in any test, while still corrupting exposure attribution. It is the purest instance of the shape R585
//   described — a duplicate whose failure is a missing fact rather than a wrong one.
//
// ARE THE TWO SUBSCRIPTION PATHS SEPARATELY ASSERTED?
//   `test/cli-mcp-host-sources-r378.test.mjs` exercises the gate through ONE provider instance and asserts `subscribe`
//   notices and `read()` freshness after `sourceChanged()`. Both subscription paths are live simultaneously, so a typo in
//   either would be caught only if that path were the one carrying the change being observed.
//
//   Reading the test: the change it relies on is `runtime.sourceChanged()`, which re-projects and notifies through BOTH
//   maps. A typo in :50 leaves :51 live, and :51 alone delivers the re-projected value — so the test would still pass. A typo
//   in :51 likewise leaves :50 live, and :50's immediate call covers the initial value. So the test CANNOT distinguish them,
//   which is a fact about the test rather than a defect in it: the two paths are redundant BY DESIGN for delivering a change,
//   and only one is needed for the assertion to hold.
//
// WHAT THIS ROUND DOES NOT DO
//   It does not add an assertion that would catch a mistyped id. The only test that could is one that checks the exact
//   string, which is the text-assertion class R570 listed as fragile — an assertion that fails when the line moves, for a
//   behaviour that has not changed.
//
//   What is worth having is the note: the id appears three times, the three consequences differ, and the third is silent.
//   A reader editing this function now knows which of the three to check.

/** The three sites, what each drives, and what a typo would do. */
const SITES = [
  {
    line: 50,
    call: "next.onFeatureChange('513873720', observe)",
    drives: 'changeListeners on the provider, plus an immediate call with the current value',
    ifMistyped: 'the gate stops updating on feature CHANGE; the initial value still arrives from :51, so the visible '
      + 'symptom is a gate frozen at whatever it read when features first loaded',
  },
  {
    line: 51,
    call: "next.observeFeatureGate('513873720', observe)",
    drives: 'gateListeners on the provider, with no immediate call',
    ifMistyped: 'the initial value still arrives from :50\'s immediate call, but a change delivered through the gate '
      + 'channel is never seen — the same frozen-gate symptom by a different mechanism',
  },
  {
    line: 60,
    call: "runtime.getFeatureValue('513873720', undefined)",
    drives: 'synchronize() (which takes no key) and exposure(key,item); the return value is discarded',
    ifMistyped: 'no behavioural difference at all — synchronise still runs — but exposure is recorded against the wrong '
      + 'flag. Silent to every assertion and to every user',
  },
];

/** What the existing test can and cannot distinguish. */
const TEST_COVERAGE = {  file: 'test/cli-mcp-host-sources-r378.test.mjs',
  canDistinguish: false,
  why: 'the change it relies on is sourceChanged(), which re-projects and notifies through BOTH listener maps; either path '
    + 'alone delivers it, so a typo in the other survives',
  note: 'this is a property of the design (two channels carrying one fact) rather than a gap in the test',
};

module.exports = { SITES, TEST_COVERAGE };

// WHAT IS NOT CLAIMED
//   Not that any id is mistyped today: this round compared the literal strings at all three coordinates and found them
//   equal. What it establishes is that the three consequences differ, and that the third has no observable signature.
//   Not that the two subscription channels are redundant: they differ in whether the listener fires immediately, and the
//   initial value depends on that difference. They are redundant only for DELIVERING A LATER CHANGE.
