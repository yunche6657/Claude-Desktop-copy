'use strict';
const {createHybridIdentityState} = require('./hybrid-identity-state.cjs');
const {deriveHybridOidc} = require('./hybrid-oidc-session.cjs');
// KC latches launch slot and stored account once; later writes do not rewrite it.
function createHybridIdentityController({launchSlot, store, relaunch = () => {}, invalidateBearer = () => {}, warn = () => {}, slotForBootstrap = url => deriveHybridOidc(url).storeKey}) {
  let launchAccount;
  if (launchSlot !== undefined) { try { launchAccount = store.read(launchSlot); } catch { /* native launch proceeds without identity */ } }
  const state = createHybridIdentityState({launchSlot, launchAccount});
  let relaunching = false;
  function beforePersist({oidc, accountUuid}) {
    invalidateBearer();
    state.noteIncomingHybridGrant(accountUuid, oidc.storeKey);
  }
  async function recordIdentitySlot(slot, identity, {isCurrent = () => true, apply = false} = {}) {
    let recorded;
    try { recorded = await store.record(slot, identity, {isCurrent}); }
    catch (error) { warn(error); return; }
    if (!apply || recorded === undefined || !isCurrent() || relaunching ||
        (launchSlot === slot && launchAccount?.accountUuid === identity.accountUuid.toLowerCase())) return;
    relaunching = true; state.markRelaunching(); await relaunch();
  }
  async function afterPersist({oidc, accountUuid, isCurrent = () => true}) {
    return recordIdentitySlot(oidc.storeKey, {accountUuid}, {isCurrent, apply:true});
  }
  // L5t calls note owner first, then records profile identity with default apply:false.
  const membershipIdentity = {
    noteOwner: (accountUuid, bootstrapUrl) => state.noteHybridBearerOwner(accountUuid, slotForBootstrap(bootstrapUrl)),
    recordIdentity: (bootstrapUrl, identity, options) => recordIdentitySlot(slotForBootstrap(bootstrapUrl), identity, options),
  };

  return {beforePersist, afterPersist, state, membershipIdentity};
}
module.exports = {createHybridIdentityController};
