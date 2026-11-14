'use strict';

const CONTROL_PARTITION = 'custom3p-probe';
const CONTROL_TIMEOUT_MS = 30000;

// The caller owns OIDC derivation and bearer lifecycle. Neither this module nor
// its isolated session reads credentials from inference or consumer sources.
function createHybridControlFetch({ electronSession, oidcFor, resolveBearer, overlayApplied = async () => {}, prepareSession = async () => {} }) {
  if (typeof electronSession?.fromPartition !== 'function' || typeof oidcFor !== 'function' ||
      typeof resolveBearer !== 'function' || typeof overlayApplied !== 'function' || typeof prepareSession !== 'function') {
    throw new TypeError('hybrid control fetch dependencies are required');
  }
  return async (bootstrapUrl, featureUrl, headers) => {
    const bootstrap = new URL(bootstrapUrl), destination = new URL(featureUrl);
    // The native GrowthBook caller creates featureUrl from bootstrap origin;
    // enforce that invariant before obtaining or transmitting a bearer.
    if (!['http:', 'https:'].includes(bootstrap.protocol) || bootstrap.username || bootstrap.password ||
        destination.username || destination.password || destination.origin !== bootstrap.origin) {
      throw new Error('hybrid feature destination does not match bootstrap origin');
    }
    await overlayApplied();
    const oidc = await oidcFor(bootstrapUrl);
    const result = await resolveBearer(oidc);
    if (!result?.ok) {
      if (result?.kind === 'unreachable') throw new Error('hybrid control-plane token refresh failed; will retry');
      return null;
    }
    if (typeof result.bearer !== 'string' || !result.bearer) throw new TypeError('invalid hybrid bearer');
    const auth = `Bearer ${result.bearer}`;
    // Native cKt normalizes header names and serializes to a plain object.
    const normalized = new Headers(headers);
    normalized.set('Authorization', auth);
    if (oidc.xAuthorization) normalized.set('X-Authorization', auth);
    const serialized = {}; normalized.forEach((value, key) => { serialized[key] = value; });
    const signal = AbortSignal.timeout(CONTROL_TIMEOUT_MS);
    const session = electronSession.fromPartition(CONTROL_PARTITION);
    if (typeof session?.fetch !== 'function') throw new TypeError('isolated session fetch unavailable');
    await prepareSession(CONTROL_PARTITION, session);
    return session.fetch(destination.toString(), {
      headers: serialized, credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal,
    });
  };
}
module.exports = { createHybridControlFetch, CONTROL_PARTITION, CONTROL_TIMEOUT_MS };
