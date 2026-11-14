'use strict';
// Experimental 1p profile-bound policy read. A host must supply an actual
// deployment-mode lease; this module neither authenticates local mode claims nor
// performs staging writes. No tokens or response bodies leave the result.
const HOST = 'https://api.anthropic.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function readIdentityBoundPolicy({accountStore, modeLease, fetchImpl = fetch} = {}) {
  const live = lease => { try { return typeof lease?.isCurrent === 'function' && lease.isCurrent() === true; } catch { return false; } };
  if (modeLease?.mode !== '1p' || !live(modeLease) || typeof accountStore?.getActiveAccessToken !== 'function' ||
      typeof accountStore?.getActiveIdentitySnapshot !== 'function' || typeof fetchImpl !== 'function') return null;
  try {
    const token = await accountStore.getActiveAccessToken();
    if (typeof token !== 'string' || !token || !live(modeLease)) return null;
    const identity = accountStore.getActiveIdentitySnapshot();
    if (!UUID.test(identity?.accountId ?? '') || !UUID.test(identity?.orgId ?? '') || !live(identity)) return null;
    const current = () => live(modeLease) && live(identity);
    const headers = {Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'anthropic-beta':'oauth-2025-04-20'};
    const get = async endpoint => {
      const response = await fetchImpl(HOST + endpoint, {method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(3000)});
      if (!response?.ok || !current()) return null;
      const body = await response.json();
      return current() ? body : null;
    };
    const profile = await get('/api/oauth/profile');
    const account = profile?.account?.uuid, org = profile?.organization?.uuid;
    if (typeof account !== 'string' || typeof org !== 'string' ||
        account.toLowerCase() !== identity.accountId.toLowerCase() || org.toLowerCase() !== identity.orgId.toLowerCase()) return null;
    const policy = await get('/api/claude_code/policy_limits');
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !policy.restrictions ||
        typeof policy.restrictions !== 'object' || Array.isArray(policy.restrictions) ||
        policy.compliance_taints !== undefined && !Array.isArray(policy.compliance_taints) ||
        policy.defaults !== undefined && (typeof policy.defaults !== 'object' || policy.defaults === null || Array.isArray(policy.defaults)) || !current()) return null;
    const restricted = (policy.compliance_taints ?? []).includes('hipaa');
    return { accountId:identity.accountId, orgId:identity.orgId, restricted, isCurrent:current };
  } catch { return null; }
}
module.exports = { readIdentityBoundPolicy };
