'use strict';
// In the stale window, `state()` records a DEFERRED exposure and then returns "incomplete" — both, in that order.
//
// THE QUESTION R588 LEFT
//   `state()` (cli-mcp-host-sources.cjs:55-63) runs
//
//       :60   runtime.getFeatureValue('513873720', undefined);     ← records exposure
//       :61   if (invalidated || … || !runtime.isSecurityFreshForCurrentSource()) return { complete: false };
//
//   R588 asked which comes first and whether the exposure is "real". Both parts are answerable from the ordering plus what
//   `synchronize()` does on the second call.
//
// THE SEQUENCE, STEP BY STEP
//   Identity has just changed (account switch). Nothing has applied the new map yet, so `staleAccount` is still false and
//   `state` is still the old settled value.
//
//       :60   getFeatureValue → synchronize()
//                 identity !== key → the CHANGE branch runs:
//                     staleAccount = true            (guard: markStale && identity !== undefined && kind === 'remote')
//                     securityIdentity = undefined
//                     securityEpoch++ ; identity = key ; generation++
//                 then exposure(key, item)
//                     fresh() = (state settled) && !staleAccount  →  FALSE, because staleAccount was just set
//                     → deferredExposure.add(key) and return        ← THE EXPOSURE IS DEFERRED, NOT DROPPED
//
//       :61   isSecurityFreshForCurrentSource() → synchronize() again
//                 identity === key now → the branch does NOT run, so nothing is reset and staleAccount STAYS true
//                 securityFresh() = … && securityIdentity !== undefined && …  →  FALSE (it was set to undefined above)
//                 → return { complete: false }
//
//   So the two facts hold together: the exposure is recorded for later replay, and the gate answers "incomplete". The
//   second is not a reason to think the first was wasted — `freshTransition` replays every deferred key when the account
//   becomes fresh again, which is exactly the account-switch window this path exists for.
//
// WHY R588'S GUESS WAS HALF WRONG
//   R588 wrote that the question was whether `:60` "records a real exposure or records one for an answer that will be
//   discarded". Those are not the alternatives. The answer IS discarded — `complete: false` means the consumer ignores
//   `featureEnabled` — and the exposure is still real, because deferral decouples it from that answer. The mechanism is
//   designed for precisely this asymmetry.
//
// WHAT IS NOT CLAIMED
//   Not that the gate is correct to answer "incomplete" during the switch — R586's three-site analysis covers what the gate
//   reports, not whether reporting it is the right policy.
//   Not that the deferred exposure is useful in this repository — R587 established that no production caller supplies
//   `onExposure`, so the replay currently feeds a set nothing reads. Both facts are true at once: the path is live, and its
//   output goes nowhere yet.

/** The ordered facts, each tied to a line. */
const SEQUENCE = [
  {
    step: 1,
    site: 'cli-mcp-host-sources.cjs:60',
    call: 'runtime.getFeatureValue(id, undefined)',
    effect: 'synchronize() sees identity !== key and runs the change branch: staleAccount = true, securityIdentity = '
      + 'undefined, epoch++, identity = key',
  },
  {
    step: 2,
    site: 'growthbook-provider.cjs:285',
    call: 'exposure(key, item)',
    effect: 'fresh() is false because staleAccount was just set, so the key goes into deferredExposure and the function '
      + 'returns — DEFERRED, not dropped',
  },
  {
    step: 3,
    site: 'cli-mcp-host-sources.cjs:61',
    call: 'isSecurityFreshForCurrentSource()',
    effect: 'synchronize() again, but identity === key now, so the branch does not run and nothing is reset; '
      + 'securityFresh() is false because securityIdentity is undefined',
  },
  {
    step: 4,
    site: 'cli-mcp-host-sources.cjs:61',
    call: 'return { complete: false }',
    effect: 'the gate reports incomplete, so the consumer ignores featureEnabled — while the exposure from step 2 is still '
      + 'queued for replay',
  },
];

/** The half-correction to R588. */
const CORRECTION = {
  r588Said: 'the question was whether :60 records a real exposure or one for an answer that will be discarded',
  actual: 'both happen: the answer IS discarded (complete: false) and the exposure IS real, because deferral decouples it '
    + 'from that answer',
  why: 'the mechanism exists for exactly this asymmetry — record while stale, replay when fresh',
};

module.exports = { SEQUENCE, CORRECTION };
