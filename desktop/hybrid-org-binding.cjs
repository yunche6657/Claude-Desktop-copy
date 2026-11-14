'use strict';
const PROFILE_TIMEOUT_MS = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class HybridOrgBindingError extends Error {
  constructor(kind) {
    super(kind === 'unverified' ? "Claude couldn't confirm which organization you signed in to. Try signing in again." :
      'You signed in to a different organization than the one that manages this desktop. Sign in again and choose that organization.');
    this.kind = kind; this.name = 'HybridOrgBindingError';
  }
}
const validUuid = value => typeof value === 'string' && UUID.test(value);

// Native yQn: transport/HTTP/JSON failures are unverified; a readable profile
// with a missing or invalid organization is instead bound:null (mismatch).
async function lookupHybridTokenProfile(oidc, bearer, { fetch, signal } = {}) {
  try {
    const authorization = `Bearer ${bearer}`;
    const response = await fetch(`${oidc.apiOrigin}/api/oauth/profile`, {
      headers: { Authorization: authorization, ...(oidc.xAuthorization ? { 'X-Authorization': authorization } : {}) },
      redirect: 'error', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PROFILE_TIMEOUT_MS)]) : AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (!response.ok) return { unverified: true };
    const profile = await response.json();
    const org = profile?.organization?.uuid, account = profile?.account?.uuid;
    return { bound: validUuid(org) ? org.toLowerCase() : null, accountUuid: validUuid(account) ? account.toLowerCase() : undefined };
  } catch { return { unverified: true }; }
}
async function assertTokenBoundToHybridOrg(oidc, bearer, options) {
  if (!oidc.orgUuid) return {};
  const result = await lookupHybridTokenProfile(oidc, bearer, options);
  if ('unverified' in result) throw new HybridOrgBindingError('unverified');
  // Native oidc derivation normalizes orgUuid before this comparison.
  if (result.bound !== oidc.orgUuid) throw new HybridOrgBindingError('mismatch');
  return { accountUuid: result.accountUuid };
}
async function bindAndPersistHybridGrant(oidc, grant, { fetch, signal, persist }) {
  if (typeof persist !== 'function') throw new TypeError('persist callback required');
  const binding = await assertTokenBoundToHybridOrg(oidc, grant.accessToken, { fetch, signal });
  await persist(grant, binding);
  return binding;
}
module.exports = { PROFILE_TIMEOUT_MS, HybridOrgBindingError, lookupHybridTokenProfile, assertTokenBoundToHybridOrg, bindAndPersistHybridGrant };
