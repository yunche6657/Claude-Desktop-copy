'use strict';

// Native KC: launch identity is latched for the lifetime of the process.
// This object tracks ownership only; persistence and relaunch are host duties.
function createHybridIdentityState({ launchSlot, launchAccount } = {}) {
  let owner, ownerVerification = 'unverified', relaunching = false;
  const listeners = new Set();
  const account = launchAccount?.accountUuid;
  const matchesSlot = slot => slot === undefined || (launchSlot !== undefined && launchSlot === slot);
  const current = () => relaunching ? undefined : owner === undefined ? account : owner;
  const heard = () => owner !== undefined;
  function markVerified(match) {
    if (match) { if (ownerVerification === 'unverified') ownerVerification = 'verified'; }
    else ownerVerification = 'changed';
  }
  function setOwner(value) {
    const old = current(), previouslyHeard = heard(), next = value?.toLowerCase() || null;
    if (next !== null || previouslyHeard || launchAccount !== undefined) owner = next;
    return !relaunching && (current() !== old || heard() !== previouslyHeard);
  }
  function noteIncomingHybridGrant(value, slot) {
    if (matchesSlot(slot)) setOwner(value);
    markVerified(!!value && !!account && value.toLowerCase() === account && matchesSlot(slot));
  }
  function noteHybridBearerOwner(value, slot) {
    if (launchSlot === undefined || (account !== undefined && value?.toLowerCase() !== account) ||
        (launchSlot !== undefined && !matchesSlot(slot))) markVerified(false);
    else if (account !== undefined && value !== undefined) markVerified(true);
    if (matchesSlot(slot) && setOwner(value)) for (const fn of listeners) { try { fn(); } catch {} }
  }
  return { noteIncomingHybridGrant, noteHybridBearerOwner, current, heard,
    matchesLaunch: () => ownerVerification !== 'changed', verified: () => ownerVerification === 'verified',
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    markRelaunching: () => { relaunching = true; } };
}
module.exports = { createHybridIdentityState };
