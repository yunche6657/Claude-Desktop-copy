'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Retain code coordinates only: error messages and arbitrary URLs may contain chat data.
function safeRendererError({ componentName, errorName, stack, route, sessionId } = {}) {
  if (!['EpitaxyChatPanel', 'EpitaxyAgentGraphView'].includes(componentName)) return null;
  const frames = [];
  const pattern = /app:\/\/localhost\/(assets\/v1\/[A-Za-z0-9_.-]+\.js):(\d+):(\d+)/g;
  for (const match of String(stack || '').matchAll(pattern)) {
    const frame = `${match[1]}:${match[2]}:${match[3]}`;
    if (!frames.includes(frame)) frames.push(frame);
    if (frames.length === 24) break;
  }
  const knownError = /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|ChunkLoadError|URIError|EvalError)$/;
  const normalizedName = knownError.test(errorName) ? errorName : 'Error';
  const id = typeof sessionId === 'string' && /^local_[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : null;
  const safeRoute = typeof route === 'string' && /^\/epitaxy(?:\/local_[0-9a-f-]{36})?$/.test(route.split(/[?#]/)[0]) ? route.split(/[?#]/)[0] : '/epitaxy';
  return { componentName, errorName: normalizedName, route: safeRoute, sessionId: id, frames };
}

function createRendererErrorLog({ directory, maxBytes = 64 * 1024, clock = () => new Date().toISOString() } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('An absolute error log directory is required');
  const file = path.join(directory, 'renderer-session-errors.jsonl');
  return {
    file,
    record(event) {
      const entry = safeRendererError(event);
      if (!entry) return false;
      try {
        fs.mkdirSync(directory, { recursive: true });
        let lines = [];
        try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        lines.push(JSON.stringify({ at: clock(), ...entry }));
        while (lines.length && Buffer.byteLength(lines.join('\n') + '\n') > maxBytes) lines.shift();
        fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
        return true;
      } catch { return false; }
    },
  };
}
module.exports = { safeRendererError, createRendererErrorLog };
