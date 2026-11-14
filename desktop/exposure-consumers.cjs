'use strict';
// `exposure()` runs, deduplicates, defers — and reports to nobody. Which makes a mistyped id at :60 inert in a specific way.
//
// THE QUESTION R586 LEFT
//   R586 concluded that a typo in `runtime.getFeatureValue('513873720', undefined)` would have "no behavioural difference"
//   while corrupting exposure attribution. Checking whether `exposure` has a consumer decides how much that matters.
//
// WHAT `exposure` ACTUALLY DOES (growthbook-provider.cjs:66)
//       if (!fresh())            record the key in deferredExposure and return
//       if (item undefined)      return
//       signature = `${key}:${item.on}:${item.source}`
//       if new signature        seenFeatureExposure.add(signature); onExposure?.({ feature_hash:key, … })
//       …then the experiment branch, gated on inExperiment === true, calling queueExperimentExposure?.({ … })
//
//   Both report paths are OPTIONAL CALLS — `onExposure?.()` and `queueExperimentExposure?.()`. Neither is required, and
//   neither is supplied anywhere in this repository:
//
//       createGrowthBookProvider callers   15 (1 production, 14 tests)
//       production caller                  desktop/main.cjs:1039, via main-growthbook-runtime.cjs:10
//       providerOptions passed there       NOT PASSED — the call site names only getContext and userData
//       onExposure / queueExperimentExposure consumers elsewhere   none
//
// SO A MISTYPED ID AT :60 IS INERT, NOT MERELY SILENT
//   R586 called it "no behavioural difference at all". The precise statement is stronger and stranger:
//
//       the dedup SETS are populated correctly for the real id via :50/:51 (which also call exposure), so the typo at :60
//       adds one extra signature for a key that no report will ever mention, and `synchronize()` runs regardless because
//       it takes no key.
//
//   Nothing observable changes anywhere — which is exactly R586's conclusion, reached for a different reason. The exposure
//   attribution is not "corrupted" because nothing reads the attribution; it is DISCARDED one layer further down.
//
// WHY THIS IS WORTH RECORDING RATHER THAN SHRUGGING AT
//   Three of the four mechanisms in `exposure` are live machinery — freshness deferral, per-signature dedup, deferred
//   replay on freshTransition. Reading them suggests reporting is happening. It is not: the last step of each path is an
//   optional call whose callback was never provided.
//
//   That is the same shape as `recordingListeners` from an earlier round: state assembled with care, consumed by nobody. But
//   here the conclusion differs — if a future caller DOES pass `onExposure`, the typo at :60 stops being inert and starts
//   mattering, and no test would notice, because the tests that pass no callback assert nothing about it.
//
// WHAT IS NOT CLAIMED
//   Not that the exposure machinery is dead code to be removed: `queueExperimentExposure` is the SDK's documented path and a
//   caller outside this repository could supply it. The claim is about THIS repository's production wiring.
//   Not that R586 was wrong about the direction — it said no behavioural difference, and that holds. What was wrong is the
//   reason: it said attribution would be corrupted, and attribution goes nowhere.

/** The exposure machinery, and which parts actually fire in production. */
const EXPOSURE_STATE = {
  definedAt: 'desktop/growthbook-provider.cjs:66',
  deferredSet: 'deferredExposure — populated when not fresh, replayed in freshTransition (:89)',
  dedupSet: 'seenFeatureExposure / seenExperimentExposure — populated on every call',
  reportCall: 'onExposure?.({ feature_hash, … }) — optional',
  experimentCall: 'queueExperimentExposure?.({ experiment_id, variation_id, … }) — optional',
  productionCallers: 1,
  callbackSuppliedInProduction: false,
  /**
   * The reporting path IS covered — by one test that injects a callback. `growthbook-freshness-r374.test.mjs:47` builds a
   * provider through `setup(ctx, extra)` and puts `onExposure` in `extra`, then asserts dedup and retry-on-rejection. So the
   * machinery is live and verified; what is absent is a PRODUCTION caller that would make a mistyped key matter.
   */
  testedBy: 'test/growthbook-freshness-r374.test.mjs:46 — "experiment exposure deduplicates and retries rejected queue"',
  consequence: 'in production the sets are populated and never read out; a mistyped key at cli-mcp-host-sources.cjs:60 adds '
    + 'one unused signature and changes nothing observable',
};

/** What a future caller would change. */
const LATENT = {
  trigger: 'a caller that passes onExposure or queueExperimentExposure',
  then: 'the typo at :60 stops being inert — exposure would be reported against a flag id nothing else uses',
  detection: 'none: the tests that construct the provider pass no callback, so they assert nothing about reporting',
};

module.exports = { EXPOSURE_STATE, LATENT };
