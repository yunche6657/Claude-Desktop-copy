'use strict';
// Only a trusted host that enforces the supplied isCurrent at its atomic
// registration/manifest commit may set supportsAtomicAuthorityCommit.
const crypto = require('node:crypto');
function createHistoryImportBridge(options = {}) {
  const {host, getAuthority, rootPath, label} = options;
  const configured = host && host.supportsAtomicAuthorityCommit === true && typeof host.scan === 'function' && typeof host.importSource === 'function' &&
    typeof getAuthority === 'function' && typeof rootPath === 'string' && rootPath && typeof label === 'string' && label;
  let sourceId, capturedAuthority, offered = [], epoch = 0;
  async function authority() {
    if (!configured) return null;
    try {
      const a = await getAuthority();
      return a && typeof a.key === 'string' && a.key && typeof a.isCurrent === 'function' && await a.isCurrent() === true ? a : null;
    } catch { return null; }
  }
  async function current(snapshot) {
    try {
      if (!snapshot || await snapshot.isCurrent() !== true) return false;
      const a = await authority();
      return !!a && a.key === snapshot.key && await snapshot.isCurrent() === true;
    } catch { return false; }
  }
  function invalidate() { ++epoch; sourceId = undefined; capturedAuthority = undefined; offered = []; }
  return {
    async enumerateSessionSources() {
      invalidate();
      const scanEpoch = epoch, a = await authority();
      if (!a) return [];
      const entries = await host.scan();
      if (!Array.isArray(entries) || scanEpoch !== epoch || !await current(a) || scanEpoch !== epoch || !entries.length) return [];
      sourceId = crypto.randomUUID(); capturedAuthority = a; offered = entries;
      return [{id:sourceId, label, rootPath, origin:'terminal'}];
    },
    async scanSessionSource(id) {
      const empty = {sourceId:id, shape:'unknown', sessions:[]};
      if (!sourceId || id !== sourceId) return empty;
      const checkEpoch = epoch, snapshot = capturedAuthority;
      if (!await current(snapshot)) { if (epoch === checkEpoch) invalidate(); return empty; }
      if (epoch !== checkEpoch) return empty;
      const scanEpoch = ++epoch;
      offered = [];
      const entries = await host.scan();
      if (epoch !== scanEpoch || !await current(snapshot) || epoch !== scanEpoch || !Array.isArray(entries)) return empty;
      offered = entries;
      return {sourceId:id, shape:'projects', sessions:entries.map(({sessionId,title,kind,lastActivityAt,sizeBytes,accountId,alreadyImported}) => ({sessionId,title,kind,lastActivityAt,sizeBytes,accountId,alreadyImported}))};
    },
    async importSessionSources(cutoffMs, ids) {
      const none = {imported:0, skipped:0};
      if (!Array.isArray(ids) || !sourceId || !ids.includes(sourceId)) return none;
      const checkEpoch = epoch, snapshot = capturedAuthority;
      if (!await current(snapshot)) { if (epoch === checkEpoch) invalidate(); return none; }
      if (epoch !== checkEpoch) return none;
      const selected = offered; offered = [];
      const activeEpoch = epoch, cutoff = Number.isFinite(cutoffMs) ? cutoffMs : 0;
      let imported = 0, skipped = 0;
      for (const entry of selected) {
        if (!Number.isFinite(entry.lastActivityAt) || !(entry.lastActivityAt >= cutoff)) continue;
        const isCurrent = async () => epoch === activeEpoch && await current(snapshot) && epoch === activeEpoch;
        if (!await isCurrent()) break;
        const result = await host.importSource(entry.sourceToken, {isCurrent});
        if (result?.status === 'registered') {
          if (!await isCurrent()) throw Error('Import committed but authority or scan changed; outcome requires reconciliation');
          imported++;
        } else skipped++;
      }
      return {imported, skipped};
    }
  };
}
module.exports = {createHistoryImportBridge};
