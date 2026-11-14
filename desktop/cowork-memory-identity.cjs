'use strict';

// The host must call observe synchronously on every deployment-mode change.
// This prevents an observed 1p -> 3p -> 1p transition from reviving an
// identity acquired before the transition.
function createCoworkMemoryIdentityResolver({ getMode, get3pIdentity }) {
  if (typeof getMode !== 'function' || typeof get3pIdentity !== 'function') {
    throw new TypeError('getMode and get3pIdentity are required');
  }
  let lastMode;
  let generation = 0;
  function observe() {
    let mode;
    try {
      mode = getMode();
      if (mode && typeof mode.then === 'function') {
        Promise.resolve(mode).catch(() => {});
        mode = undefined;
      }
      if (mode !== '1p' && mode !== '3p') mode = undefined;
    } catch { mode = undefined; }
    if (mode !== lastMode) { lastMode = mode; generation++; }
    return mode;
  }
  function resolve(getAccount) {
    const mode = observe();
    if (mode === '3p') {
      try { return get3pIdentity() ?? null; } catch { return null; }
    }
    if (mode !== '1p' || typeof getAccount !== 'function') return null;
    let identity;
    try { identity = getAccount(); } catch { return null; }
    if (!identity || typeof identity.isCurrent !== 'function') return null;
    const acquiredGeneration = generation;
    let valid = true;
    const isCurrent = () => {
      if (!valid) return false;
      try {
        valid = observe() === '1p' && generation === acquiredGeneration && identity.isCurrent() === true;
      } catch { valid = false; }
      return valid;
    };
    return isCurrent() ? { accountId: identity.accountId, orgId: identity.orgId, isCurrent } : null;
  }
  resolve.observe = observe;
  return resolve;
}

module.exports = { createCoworkMemoryIdentityResolver };
