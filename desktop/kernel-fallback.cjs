'use strict';
// When CCB construction throws, may the app fall back to the local loop?
//
// THE RULE, EXTRACTED FROM main.cjs (R569)
//   `main.cjs` builds a CCB backend when `chooseKernel()` says CCB. If the constructor throws, three things happen:
//
//       const unavailable = probeCcb({ env, root });
//       if (unavailable.available) throw error;      // the files are there: this is a REAL failure, not a fallback
//       kernelSelection = selectKernel({ … });       // the runtime vanished: re-decide, and say so
//       backend = null;                              // and build the local loop
//
//   The distinction is the whole point: a missing runtime is expected on a machine without the bundle, while a throw
//   with the runtime PRESENT means something is broken and must not be papered over. R568 measured that no test names
//   `chooseKernel`, and the fallback inside `kernelFactory` was covered by `kernel-wiring.test.mjs:35`, which matches
//   four regular expressions against main.cjs's TEXT — it proves the lines exist, not that they decide correctly.
//
//   This module is that decision, as a function of the re-probe result.
//
// WHY THIS ONE IS WORTH EXTRACTING AND `chooseKernel` WAS NOT
//   R569 checked: `selectKernel`, `probeCcb` and `probeLocal` all live in `kernel-select.cjs`, which has its own test file
//   with 13 tests and 38 assertions — including "probeCcb reports the exact missing file" and "an explicit CCB_DISABLE
//   switch is honoured". So `chooseKernel` is genuinely just assembly over a tested pure function, and its having no test
//   is fine. The fallback is different: `selectKernel` is tested, but the POLICY around it — throw versus fall back — is
//   only ever asserted as text.
//
// WHAT THIS DOES NOT DECIDE
//   It does not re-probe, construct anything, or log. The caller supplies the probe result and does the effects; this
//   answers only "propagate or fall back".

/**
 * @param {{ available: boolean }} reprobe   the result of probing for the CCB runtime again
 * @returns {'propagate' | 'fallback'}
 */
function fallbackDecision(reprobe) {
  // A probe that is missing or malformed is treated as "not available": the conservative reading, because the cost of
  // falling back when the runtime was fine is a slower turn with a stated reason, while the cost of propagating when the
  // runtime was absent is a failed boot.
  //
  // `=== true`, not truthiness: `{ available: 'yes' }` is a probe that does not answer the question, and treating a
  // string as agreement is how a malformed result becomes a decision. The first version used `reprobe.available` and
  // propagated on `'yes'` — the test written against it caught that immediately.
  if (!reprobe || typeof reprobe !== 'object') return 'fallback';
  return reprobe.available === true ? 'propagate' : 'fallback';
}

/**
 * The message the fallback logs. Kept here so a test can pin it: the log line exists to make the fallback VISIBLE, and
 * `main.cjs` carries a comment about an earlier draft that logged one backend while building another.
 */
const FALLBACK_LOG = 'ccb construction failed, using local';

module.exports = { fallbackDecision, FALLBACK_LOG };
