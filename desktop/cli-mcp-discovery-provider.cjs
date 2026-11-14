'use strict';

const { matchesCliServer } = require('./mcp-session-policy.cjs');
const SOURCE_KEYS = ['coordinator', 'config', 'reserved', 'identities', 'session', 'tenantHistory', 'plugins', 'gate', 'scope'];

// Every source is main-owned and must report complete data and invalidate on
// changes. Missing readers, subscriptions or freshness checks fail closed.
function createCliMcpDiscoveryProvider(sources = {}) {
  let generation = 0, watching = false, healthy = false, disposers = [];
  const listeners = new Set(), issued = new WeakMap();
  const usable = source => source && typeof source.read === 'function' &&
    typeof source.isCurrent === 'function' && typeof source.subscribe === 'function';
  const invalidate = () => {
    generation++;
    for (const listener of [...listeners]) { try { listener(); } catch { /* notify other consumers */ } }
  };
  function stopWatching() {
    watching = false; healthy = false;
    for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* already invalidated */ } }
  }
  function startWatching() {
    if (watching) return;
    watching = true;
    if (!SOURCE_KEYS.every(key => usable(sources[key]))) return;
    try {
      for (const key of SOURCE_KEYS) {
        const dispose = sources[key].subscribe(invalidate);
        if (typeof dispose !== 'function') throw new TypeError('source must return an unsubscribe function');
        disposers.push(dispose);
      }
      healthy = true;
    } catch { stopWatching(); }
  }
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    startWatching();
    return () => { listeners.delete(listener); if (!listeners.size) { generation++; stopWatching(); } };
  }
  function isCurrent(snapshot) {
    const record = issued.get(snapshot);
    if (!record || !healthy || !watching || record.generation !== generation) return false;
    try { return SOURCE_KEYS.every(key => sources[key].isCurrent(record.values[key]) === true); }
    catch { return false; }
  }
  async function getSnapshot(context) {
    if (!healthy || !watching) return { complete: false };
    const token = generation;
    let values;
    try {
      values = Object.fromEntries(await Promise.all(SOURCE_KEYS.map(async key => [key, await sources[key].read(context)])));
      if (token !== generation || !healthy || !SOURCE_KEYS.every(key => values[key]?.complete === true && sources[key].isCurrent(values[key]) === true)) return { complete: false };
      const nameKeys = SOURCE_KEYS.slice(0, 7);
      if (!nameKeys.every(key => Array.isArray(values[key].names) && values[key].names.every(name => typeof name === 'string')) ||
          typeof values.reserved.isReserved !== 'function' || typeof values.gate.featureEnabled !== 'boolean' ||
          typeof values.scope.sessionAllowed !== 'boolean' || typeof values.scope.cliRunsAsThisUser !== 'boolean' ||
          !values.scope.tenancy || !['accountId', 'orgId'].every(key => Object.hasOwn(values.scope.tenancy, key) &&
            (values.scope.tenancy[key] === null || typeof values.scope.tenancy[key] === 'string'))) return { complete: false };
      const names = nameKeys.flatMap(key => values[key].names);
      const snapshot = Object.freeze({ complete: true, version: token,
        coverage: Object.freeze(Object.fromEntries(nameKeys.map(key => [key, true]))),
        featureEnabled: values.gate.featureEnabled, sessionAllowed: values.scope.sessionAllowed,
        cliRunsAsThisUser: values.scope.cliRunsAsThisUser,
        tenancy: Object.freeze({ accountId: values.scope.tenancy.accountId, orgId: values.scope.tenancy.orgId }),
        conflicts: name => {
          if (!isCurrent(snapshot)) throw new Error('MCP discovery snapshot is stale');
          const reserved = values.reserved.isReserved(name);
          if (typeof reserved !== 'boolean') throw new TypeError('reserved-name source must return a boolean');
          return reserved || matchesCliServer(names, name);
        },
      });
      issued.set(snapshot, { generation: token, values });
      return snapshot;
    } catch { return { complete: false }; }
  }
  return { subscribe, getSnapshot, isCurrent };
}
module.exports = { createCliMcpDiscoveryProvider, SOURCE_KEYS };
