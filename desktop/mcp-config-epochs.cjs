'use strict';
const { createHash } = require('node:crypto');

// One instance belongs to one actor. Tokens change whenever an observed
// server config changes, disappears, or becomes ambiguous; old tokens never
// become current again, even if the original config returns later.
function createMcpConfigEpochs() {
  const entries = new Map(); let sequence = 0;
  function update(rows) {
    const next = new Map();
    if (Array.isArray(rows)) for (const row of rows) {
      if (!row || typeof row.name !== 'string' || !row.name) continue;
      if (next.has(row.name)) { next.set(row.name, null); continue; }
      if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)) { next.set(row.name, null); continue; }
      try {
        const value = JSON.stringify({ config:row.config, scope:row.scope, origin:row.origin });
        next.set(row.name, createHash('sha256').update(value).digest('hex'));
      } catch { next.set(row.name, null); }
    }
    for (const name of entries.keys()) if (!next.has(name)) entries.delete(name);
    for (const [name, hash] of next) {
      if (!hash) { entries.delete(name); continue; }
      if (entries.get(name)?.hash !== hash) {
        if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('MCP config epoch exhausted');
        entries.set(name, { hash, token:++sequence });
      }
    }
  }
  return Object.freeze({ update, get:name => entries.get(name)?.token });
}
module.exports={createMcpConfigEpochs};
