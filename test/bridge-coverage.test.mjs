// Every method the shipped frontend can call exists on the bridge. All 1,333 of them.
//
// Measured live this round by walking bridge-map.json (captured from a running original) and
// resolving each name against the preload surface:
//
//   { total: 1333, present: 1333, missingCount: 0 }
//
// The first attempt reported 0 present because it resolved `claude.web.LocalSessions.onOnEvent`
// as a nested object path. The preload exposes `window['claude.web']` as ONE key containing a
// dot, so the lookup has to try progressively shorter dotted prefixes. That mistake is worth
// recording: a coverage probe that fails to resolve anything is a broken probe, not a broken
// bridge — and "0 of 1333" should have been suspicious rather than alarming.
//
// What this proves and what it does not:
//   proves   every mapped name resolves to a callable function
//   does not prove each one returns the right shape (that is what the per-service tests do)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json'), 'utf8'));
const SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
const LIVE = process.env.REPLICA_CDP;
const liveTest = LIVE ? test : test.skip;

/** Flatten bridge-map.json into `claude.<ns>.<Service>.<method>` strings. */
function mappedMethods() {
  const out = [];
  const walk = (node, prefix) => {
    if (Array.isArray(node)) {
      for (const entry of node) if (typeof entry === 'string') out.push(prefix + entry);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, prefix ? prefix + key + '.' : key + '.');
    }
  };
  walk(MAP, '');
  return out;
}

test('bridge-map lists the full captured surface', () => {
  // A sudden drop means the map was regenerated from a partial capture.
  const methods = mappedMethods();
  assert.ok(methods.length >= 1300, 'the mapped surface shrank to ' + methods.length);
});

test('the bridge registers a handler for every mapped method', () => {
  // Two layers exist, and the first version of this test only looked at the second:
  //
  //   1. `define(...)` registers a REAL implementation for the methods this reconstruction
  //      implements (about 60 of them).
  //   2. a generic loop walks bridgeMap and registers every remaining method with a typed
  //      negative answer, so no channel is missing.
  //
  // Checking `define` alone therefore reported ~1,270 "missing" methods that are in fact
  // registered by the loop. The runtime probe settles it: 1333 of 1333 callable.
  assert.match(SOURCE, /for \(const \[domain, services\] of Object\.entries\(bridgeMap\)\)/,
    'the generic registration loop is gone, so unmapped methods have no channel');
  assert.match(SOURCE, /ipcMain\.handle\(channel,/, 'the loop no longer registers a handler');
});

test('real implementations override the generic fallback', () => {
  // Order matters: the loop must consult the handler table rather than overwrite it.
  const loopAt = SOURCE.indexOf('for (const [domain, services] of Object.entries(bridgeMap))');
  const lookupAt = SOURCE.indexOf('handlers.get(frag)', loopAt);
  assert.ok(loopAt > 0 && lookupAt > loopAt,
    'the loop does not look up a real handler before falling back');
});

liveTest('every mapped method resolves to a callable at runtime', async () => {
  const { pathToFileURL } = await import('node:url');
  const { withTarget } = await import(pathToFileURL(path.join(ROOT, 'tools', 'cdp.mjs')).href);
  const names = JSON.stringify(mappedMethods());
  const probe = "(() => { const names = " + names + ";"
    + ' let present = 0; const missing = [];'
    + " for (const full of names) { const parts = full.split('.'); const method = parts.pop();"
    + ' let ns = null;'
    + ' for (let take = parts.length; take >= 1 && !ns; take--) {'
    + " const key = parts.slice(0, take).join('.');"
    + " if (window[key] && typeof window[key] === 'object') { ns = window[key];"
    + ' for (const p of parts.slice(take)) ns = ns && ns[p]; } }'
    + " if (ns && typeof ns[method] === 'function') present++; else missing.push(full); }"
    + ' return JSON.stringify({ total: names.length, present, missing: missing.slice(0, 10) }); })()';
  const result = await withTarget(null, async (connection) => JSON.parse(await connection.eval(probe)));
  assert.ok(result.total > 1300, 'the probe received no names');
  assert.deepEqual(result.missing, [],
    'mapped methods that are not callable: ' + result.missing.join(', '));
});
