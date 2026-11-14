'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_ORG = '00000000-0000-4000-8000-000000000001';

function bootstrapOrg(url) {
  if (typeof url !== 'string' || !URL.canParse(url)) return undefined;
  const match = /^\/v1\/desktop\/orgs\/([^/]+)\/bootstrap\/?$/.exec(new URL(url).pathname);
  if (!match) return undefined;
  try {
    const value = decodeURIComponent(match[1]);
    return UUID.test(value) ? value.toLowerCase() : undefined;
  } catch { return undefined; }
}

// installId must be the host's trusted, stable non-secret installation UUID.
// Context contains only derived, non-secret identifiers. The host must validate
// the hybrid URL against its own bootstrap trust policy before passing it here.
function createCowork3pIdentity({ installId, getContext }) {
  if (typeof installId !== 'string' || !UUID.test(installId) || typeof getContext !== 'function') {
    throw new TypeError('trusted installation UUID and getContext are required');
  }
  let initialized = false;
  let hybridOrg;
  return async function getAccountContext() {
    const context = await getContext();
    if (!context || context.mode !== '3p') return null;
    if (!initialized) {
      hybridOrg = bootstrapOrg(context.trustedHybridBootstrapUrl);
      initialized = true;
    }
    const fallback = context.organizationKey ?? context.selfHostedOrganizationKey ?? context.mintedOrganizationUuid ?? DEFAULT_ORG;
    const orgId = hybridOrg ?? fallback;
    if (typeof orgId !== 'string' || !UUID.test(orgId)) return null;
    return { accountId: installId, orgId };
  };
}

// The host must mark a hybrid URL trusted only after applying its bootstrap
// trust policy. Null/undefined hybrid means no hybrid configuration; a present
// but invalid or untrusted configuration must never become the default org.
function snapshotContext(context) {
  if (!context || context.mode !== '3p') return null;
  if (context.hybrid != null) {
    const hybrid = context.hybrid;
    if (typeof hybrid !== 'object' || hybrid.trusted !== true || typeof hybrid.url !== 'string') return null;
    try {
      const url = new URL(hybrid.url);
      const orgId = bootstrapOrg(hybrid.url);
      if (url.protocol !== 'https:' || url.username || url.password || !orgId) return null;
      return { key: JSON.stringify(['3p', 'hybrid', url.origin, orgId]), orgId };
    } catch { return null; }
  }
  const orgId = context.organizationKey ?? context.selfHostedOrganizationKey ?? context.mintedOrganizationUuid ?? DEFAULT_ORG;
  if (typeof orgId !== 'string' || !UUID.test(orgId)) return null;
  return { key: JSON.stringify(['3p', 'ordinary', orgId]), orgId };
}

// Synchronous observation must also be called on every relevant source change.
// A previously observed mismatch is irreversible for this instance.
function createCowork3pStartupIdentity({ installId, launchContext, getCurrentContext }) {
  if (typeof installId !== 'string' || !UUID.test(installId) || typeof getCurrentContext !== 'function') {
    throw new TypeError('trusted installation UUID and synchronous getCurrentContext are required');
  }
  const launch = snapshotContext(launchContext);
  let valid = !!launch;
  function isCurrent() {
    if (!valid) return false;
    try {
      const current = getCurrentContext();
      if (current && typeof current.then === 'function') {
        Promise.resolve(current).catch(() => {});
        valid = false;
      } else {
        valid = snapshotContext(current)?.key === launch.key;
      }
    } catch { valid = false; }
    return valid;
  }
  function getIdentity() {
    return isCurrent() ? { accountId: installId, orgId: launch.orgId, isCurrent } : null;
  }
  getIdentity.observe = isCurrent;
  return getIdentity;
}

module.exports = { createCowork3pIdentity, createCowork3pStartupIdentity };
