// A fallback that answers null for a GETTER breaks its caller in a way nobody sees.
//
// Measured on this host: `getSSHHostToolGrants` had no handler, so the generic fallback
// answered null. The SSH host settings panel does
//
//   (await yn.getSSHHostToolGrants()).filter(e => e.endpointKey === q).length
//
// which throws "Cannot read properties of null (reading 'filter')". The throw lands in that
// effect's .catch(), so the page does not break -- the tool-grant count just stays at 0
// forever, and nothing anywhere says why.
//
// The generic table already handled *Sessions / *Spaces / *Configs shapes. These three were
// missing, and all three are arrays whose callers do not null-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

function makeBridge() {
  const handlers = new Map();
  const { createSessionKernel } = require('../desktop/session-kernel.cjs');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  registerBridgeServices({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { call };
}

test('getSSHHostToolGrants answers an array, so .filter() cannot throw', async () => {
  const { call } = makeBridge();
  const grants = await call('LocalSessions', 'getSSHHostToolGrants');
  assert.ok(Array.isArray(grants), `must be an array, got ${JSON.stringify(grants)}`);
  // The exact expression the settings panel evaluates.
  assert.doesNotThrow(() => grants.filter((e) => e.endpointKey === 'x').length);
});

test('listWslDistros answers an array', async () => {
  const { call } = makeBridge();
  const distros = await call('LocalSessions', 'listWslDistros');
  assert.ok(Array.isArray(distros), 'a list query must answer a list');
});

test('getPendingSSHPasswordRequests answers an array', async () => {
  const { call } = makeBridge();
  const pending = await call('LocalSessions', 'getPendingSSHPasswordRequests');
  assert.ok(Array.isArray(pending), 'a pending-requests query must answer a list');
});

test('a genuinely absent feature may still answer null', async () => {
  // The fix must not turn every unknown channel into an array: some callers branch on null
  // to mean "this build does not have the feature".
  //
  // HistoryImport used to be the example here, but it was exactly the case where null was
  // NOT survivable (a caller read .length on the answer and took the whole surface down
  // behind an error boundary), so its containers now answer their real shape.
  //
  // Round 234 narrowed this further: `getGlobalShortcut` USED to be the example, until its
  // consumer was read — `ae.getGlobalShortcut().then(e => { c(e || "") })` — which means the
  // consumer wants a string and patches null itself. Answering '' is the same visible result
  // and a more honest type, so that channel moved out of the null column. What remains here
  // is a channel whose value nothing reads structurally at all.
  const { call } = makeBridge();
  // `getDirectoryPath` is a real mapped method with neither a handler nor an emptyFor rule.
  // Verified by probing the fallback directly: getCcdCliStatus answers {status, reason}
  // because its name matches isFeatureStatusMethod, while this one answers a bare null.
  const value = await call('FilePickers', 'getDirectoryPath');
  assert.equal(value, null, 'a channel nothing reads structurally may still answer null');
});