// Fallback answer shapes: each channel's empty value must match how its consumer reads it.
//
// MEASURED through a real bridge over a real kernel (temp store), calling the registered
// handlers directly:
//
//   LocalPlugins.getPlugins                    array(0)
//   CustomPlugins.listMarketplaces             array(0)
//   LocalSessions.getSessionList               object        <- {sessions, archived, pinned}
//   Extensions.getInstalledExtensionsWithState array(0)
//   Extensions.isExtensionsEnabled             boolean
//   CoworkScheduledTasks.getAllScheduledTasks  array(0)
//
// The distinction that costs bugs is array vs object. emptyFor() spells out why: searchSessions
// ends in 'Sessions' but its consumer does `for (let t of l)`, so an object threw 'l is not
// iterable' and the whole palette route hit the error boundary; listCliSessions likewise goes
// straight into `.map()`. Both are special-cased BEFORE the generic /Sessions$/ rule.
//
// A BOOLEAN case matters too: isExtensionsEnabled must answer false (not null), because the
// settings UI checks `=== true` to decide whether to offer the panel at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** A callable bridge over a fresh kernel. */
async function makeBridge() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-shape-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
  const handlers = new Map();
  registerBridgeServices({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  });
  const call = async (service, method) => {
    const channel = [...handlers.keys()].find((c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`));
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return await handlers.get(channel)({}, undefined, undefined);
  };
  return { call, storePath };
}

test('list-shaped fallbacks answer arrays', async () => {
  const b = await makeBridge();
  try {
    for (const [svc, method] of [
      ['LocalPlugins', 'getPlugins'],
      ['CustomPlugins', 'listMarketplaces'],
      ['Extensions', 'getInstalledExtensionsWithState'],
      ['CoworkScheduledTasks', 'getAllScheduledTasks'],
    ]) {
      const value = await b.call(svc, method);
      assert.ok(Array.isArray(value), svc + '.' + method + ' answered ' + (value === null ? 'null' : typeof value) + ', not an array');
    }
  } finally {
    try { fs.unlinkSync(b.storePath); } catch { /* already gone */ }
  }
});

test('the session-list fallback answers the container object', async () => {
  // Its consumer reads .sessions / .archived / .pinned, so an array here would break it the
  // other way around.
  const b = await makeBridge();
  try {
    const value = await b.call('LocalSessions', 'getSessionList');
    assert.equal(typeof value, 'object');
    assert.ok(Array.isArray(value.sessions), 'getSessionList did not answer a sessions array');
  } finally {
    try { fs.unlinkSync(b.storePath); } catch { /* already gone */ }
  }
});

test('boolean-shaped fallbacks answer real booleans', async () => {
  // The settings UI checks `=== true`; null would silently mean 'no panel'.
  const b = await makeBridge();
  try {
    const value = await b.call('Extensions', 'isExtensionsEnabled');
    assert.equal(typeof value, 'boolean', 'isExtensionsEnabled answered ' + JSON.stringify(value));
  } finally {
    try { fs.unlinkSync(b.storePath); } catch { /* already gone */ }
  }
});

test('the two Sessions-suffixed channels that need arrays are special-cased', () => {
  // Pinned in source because they must be checked BEFORE the generic /Sessions$/ rule.
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.match(bridge, /if \(\/searchSessions\$\/i\.test\(frag\)\) return \[\];/, 'searchSessions is no longer an array');
  assert.match(bridge, /if \(\/listCliSessions\$\/i\.test\(frag\)\) return \[\];/, 'listCliSessions is no longer an array');
});
