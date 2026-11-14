'use strict';
// Is `deferredExposure` reachable in production? Traced through the ordering, and the answer is yes — by ONE route.
//
// THE HYPOTHESIS, AND WHY IT LOOKED RIGHT
//   `deferredExposure` exists so a key can be recorded while features are not fresh and replayed afterwards. R587 closed by
//   asking whether anything in production ever fills it, since the gate's listeners fire on feature CHANGE — a moment when
//   features are, by construction, already fresh.
//
//   Reading `apply` (`growthbook-provider.cjs:95-108`) supports that:
//
//       :98    state = kind;                       ← state is updated FIRST
//       :101   exposure(key, value)                ← then the change listeners are notified
//
//   So the `exposure` at :101 runs with `state` already `network`/`map-final`, and `fresh()` returns true. Similarly the
//   immediate call in `onFeatureChange` (:301) is gated on `state !== 'none'`. Neither route defers.
//
// WHAT ACTUALLY MAKES `fresh()` FALSE
//       :49   const fresh = () => (state === 'network' || state === 'map-final') && !staleAccount;
//
//   Two ways to fail, and the first is unreachable at notify time:
//
//       state not yet network/map-final    blocked by :98 ordering, and by :301's `state !== 'none'` guard
//       staleAccount === true              SET at :121, only when the identity key changes on a REMOTE source
//
//   So the one live route is an identity change on a remote source: the account switches, `staleAccount` goes true, and any
//   exposure recorded before the next apply is deferred and replayed by `freshTransition`.
//
// IS THAT ROUTE LIVE IN THIS APP?
//   Yes. `desktop/growthbook-mode-backend.cjs` builds a remote source at :34 and :42, and `desktop/growthbook-source.cjs:40`
//   uses `identity ?? origin`. A static-only provider would make `deferredExposure.add` unreachable — verified: a static
//   provider survives `sourceChanged()` and keeps `complete: true, featureEnabled` tracked, without ever deferring. The
//   production backend is not static-only.
//
// WHAT THIS SETTLES, AND WHAT IT DOES NOT
//   Settles: `deferredExposure` is not leftover machinery. It has exactly one production route — account identity change on a
//   remote source — and that route is the one this app actually uses.
//   Does not settle: how OFTEN. An account switch is rare, so the deferred path is exercised rarely. The repository's tests
//   cover it deterministically (`growthbook-freshness-r374.test.mjs` "fresh transition reports deferred exposure once"), which
//   is the right way to cover a rare branch — but it means production frequency is unknown and unmeasured here.
//
// WHY THE HYPOTHESIS WAS WORTH TESTING RATHER THAN ASSUMING EITHER WAY
//   "Unreachable machinery" and "rarely-reached machinery" look identical from the code and have opposite consequences: the
//   first is dead weight, the second is a path that fails only in the situation nobody tests manually. Distinguishing them
//   required reading the ordering, not the function names.

/** Every route to `deferredExposure`, and whether it can fire. */
const ROUTES = [
  {
    site: ':101 exposure(key, value) inside apply',
    precondition: 'fresh() false',
    reachable: false,
    why: ':98 sets `state = kind` before :101 runs, so at notify time state is already network/map-final',
  },
  {
    site: ':301 exposure(key, features[key]) inside onFeatureChange',
    precondition: 'state !== \'none\' AND fresh() false',
    reachable: false,
    why: 'the guard already excludes the only state in which it could be non-fresh, and staleAccount is not consulted there',
  },
  {
    site: ':285 / :289 inside getFeatureValue and getFeatureOn',
    precondition: 'fresh() false',
    reachable: true,
    why: 'these are called from arbitrary code at arbitrary times, including while an identity change has marked the account '
      + 'stale — the gate\'s own :60 calls getFeatureValue while `state()` is deciding completeness',
  },
];

/** The single condition that makes the reachable route fire. */
const TRIGGER = {
  condition: 'staleAccount === true, which :121 sets only when the identity key changes on a REMOTE source',
  liveInThisApp: true,
  evidence: 'desktop/growthbook-mode-backend.cjs:34 and :42 build remote sources; desktop/growthbook-source.cjs:40 uses '
    + 'identity ?? origin',
  staticCounterfactual: 'a static-only provider never sets staleAccount, so deferredExposure.add is unreachable there — '
    + 'verified by running a static provider through init, read and sourceChanged without a deferral',
  frequency: 'unknown and unmeasured: an account switch is rare, and the repository covers the path with a deterministic '
    + 'test rather than a probability estimate',
};

module.exports = { ROUTES, TRIGGER };
