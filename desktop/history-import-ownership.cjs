'use strict';
// Projection of host-supplied, complete inventory; this module never opens a
// user directory. The host owns enumeration, parsing, identity and exclusion.
// A version must change for every relevant disk or in-memory ownership change.
function createImportOwnershipProvider({readInventory}) {
  if (typeof readInventory !== 'function') throw new TypeError('Inventory reader required');
  return async () => {
    const inventory = await readInventory();
    if (!inventory || inventory.complete !== true || !inventory.coverage ||
        !['allAccountsAndOrgs','loadedSessions','deletingSessions','tombstones'].every(k => inventory.coverage[k] === true) ||
        !Array.isArray(inventory.records) || !Array.isArray(inventory.tombstones) || !Array.isArray(inventory.liveClaims) ||
        !(typeof inventory.version === 'string' && inventory.version.length || Number.isSafeInteger(inventory.version)) ||
        typeof inventory.isCurrent !== 'function') throw Error('Complete ownership inventory unavailable');
    const ids = new Set();
    const add = value => {
      if (typeof value !== 'string' || value.length === 0) throw Error('Invalid ownership inventory');
      ids.add(value.toLowerCase());
    };
    for (const id of inventory.tombstones) add(id);
    for (const id of inventory.liveClaims) add(id);
    for (const entry of inventory.records) {
      if (!entry || typeof entry.stem !== 'string' || !entry.stem || typeof entry.currentTenant !== 'boolean' ||
          !entry.record || typeof entry.record !== 'object' || Array.isArray(entry.record)) throw Error('Invalid ownership inventory');
      // Native xI claims the local filename stem in both own and foreign orgs.
      add(entry.stem);
      for (const field of ['cliSessionId','unarchivedCliSessionId']) {
        const value = entry.record[field];
        if (value !== undefined && value !== null) add(value);
      }
      const prior = entry.record.priorCliSessionIds;
      if (prior !== undefined && prior !== null) {
        if (!Array.isArray(prior)) throw Error('Invalid ownership inventory');
        for (const id of prior) add(id);
      }
    }
    if (await inventory.isCurrent() !== true) throw Error('Ownership inventory changed');
    return {complete:true, version:inventory.version, cliSessionIds:ids, isCurrent:()=>inventory.isCurrent()};
  };
}
module.exports = {createImportOwnershipProvider};
