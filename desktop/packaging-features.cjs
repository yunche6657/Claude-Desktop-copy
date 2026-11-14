'use strict';
// Which features a packaged build is allowed to enable.
//
// WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE main.cjs
//   R568 measured which of main.cjs's top-level functions any test names, and this one was named by NONE. That mattered
//   more than the other gap (`chooseKernel`) because this function DECIDES FEATURE VISIBILITY: if it is wrong, a packaged
//   build offers features it cannot run, or a portable build loses features it should have. That is not a debugging
//   surface; it is user-facing behaviour chosen by a boolean.
//
//   main.cjs cannot be imported — it has no `module.exports` and opens an Electron window on load — so the only test that
//   could reach this function was a string search for its name. Extracting it changes nothing about when it runs and
//   everything about whether its behaviour can be pinned.
//
// THE RULE, AS IT WAS AND STILL IS
//   The four features below are the ones the shipped MSIX build advertises. `bridgeMap.__desktopBootFeatures` may list
//   them with a status; when the process is NOT a declared MSIX package, the list is passed through UNCHANGED — the
//   features keep whatever status the bridge map gave them, which for a portable build is how they end up hidden.
//
// WHAT IS DELIBERATELY NOT CHANGED
//   Only features already TRUTHY in the map are rewritten. An absent feature is not added, because adding it would grant
//   a capability the bridge map never offered. The `if (out[key])` guard is the whole of that policy and it is easy to
//   drop while "simplifying", so it is asserted.

/** The features the MSIX build advertises. Order is irrelevant to behaviour; kept as written. */
const PACKAGED_FEATURES = ['yukonSilver', 'yukonSilverGems', 'yukonSilverGemsCache', 'coworkBrowser'];

/**
 * The Cowork family, declared supported by a packaged build.
 *
 * R653: the captured feature map records these as `unavailable` / `msix_required`, because it was captured on a
 * machine where Cowork could not run. The renderer turns any non-supported status into a disabled pill or the
 * "{featureName} requires a newer installation" tooltip, so while these stayed captured the surface stayed hidden
 * — regardless of the handlers existing (R652).
 *
 * Matched by prefix so a row added to the capture is covered without editing this list.
 */
const COWORK_FEATURE_PREFIXES = ['cowork', 'selfHostedCowork'];

const isCoworkFeature = (key) => COWORK_FEATURE_PREFIXES.some((p) => key.startsWith(p));

/**
 * Pass `features` through, unless the current process is a declared MSIX package.
 *
 * @param {object} features           the bridge map's declared features
 * @param {{isMsix?: boolean}} state  the packaging state, passed in so this stays pure
 * @returns {object} either the same object or a copy with the packaged features marked supported
 */
function applyPackagingState(features, state) {
  const declared = state || {};
  if (!declared.isMsix) return features;
  const out = { ...features };
  for (const key of PACKAGED_FEATURES) {
    // Truthy check, not `key in out`: an ABSENT feature must stay absent. Granting a capability the bridge map never
    // offered is the one outcome this function must not produce.
    if (out[key]) out[key] = { status: 'supported' };
  }
  // R653: same rule, applied to the Cowork family the capture recorded as unavailable.
  for (const key of Object.keys(out)) {
    if (!isCoworkFeature(key)) continue;
    if (out[key] && typeof out[key] === 'object' && out[key].status !== 'supported') {
      out[key] = { status: 'supported' };
    }
  }
  return out;
}

module.exports = { PACKAGED_FEATURES, COWORK_FEATURE_PREFIXES, isCoworkFeature, applyPackagingState };
