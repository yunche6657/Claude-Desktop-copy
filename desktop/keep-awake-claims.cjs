'use strict';

// Fixed desktop 2.42304: oV/sV, vCr/cV/lV/yCr. A claim is retained
// while the managed gate is disabled and becomes effective when it reopens.
function createKeepAwakeClaims({ powerSaveBlocker, isAllowed, beforeStop = () => {} }) {
  const claims = new Set();
  let blockerId = null;
  function reconcile(releasedClaim) {
    const shouldBlock = claims.size > 0 && isAllowed();
    if (shouldBlock && blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!shouldBlock && blockerId !== null) {
      beforeStop();
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
  }
  return {
    claim(name) { if (!claims.has(name)) { claims.add(name); reconcile(); } },
    release(name) { if (claims.delete(name)) reconcile(name); },
    reconcile,
    isBlocking: () => blockerId !== null,
  };
}
module.exports = { createKeepAwakeClaims };
