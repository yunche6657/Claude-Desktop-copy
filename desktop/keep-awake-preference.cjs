'use strict';

// Fixed 2.42304 xCr/SCr: the global user preference owns one shared claim.
// Managed configuration is applied inside claims.isAllowed; this binding must
// be notified on every effective policy change, including fail-closed updates.
function bindKeepAwakePreference({ preferences, claims, subscribePolicy }) {
  if (!preferences || typeof preferences.get !== 'function' || typeof preferences.on !== 'function' ||
      typeof preferences.off !== 'function' || typeof subscribePolicy !== 'function' ||
      !claims || typeof claims.claim !== 'function' || typeof claims.release !== 'function' || typeof claims.reconcile !== 'function') {
    throw new TypeError('keep-awake preference, policy subscription and shared claims required');
  }
  const sync = () => preferences.get('keepAwakeEnabled') === true
    ? claims.claim('keepAwakeEnabled') : claims.release('keepAwakeEnabled');
  const policyChanged = () => claims.reconcile();
  preferences.on('keepAwakeEnabled', sync);
  let unsubscribe;
  try {
    unsubscribe = subscribePolicy(policyChanged);
    if (typeof unsubscribe !== 'function') throw new TypeError('policy subscription must return an unsubscribe function');
    sync();
  } catch (error) {
    preferences.off('keepAwakeEnabled', sync);
    if (typeof unsubscribe === 'function') unsubscribe();
    throw error;
  }
  let disposed = false;
  return { dispose() {
    if (disposed) return;
    disposed = true;
    preferences.off('keepAwakeEnabled', sync);
    unsubscribe();
    claims.release('keepAwakeEnabled');
  } };
}
module.exports = { bindKeepAwakePreference };
