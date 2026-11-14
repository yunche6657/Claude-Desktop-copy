import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { createMainGrowthBookRuntime } = require('../desktop/main-growthbook-runtime.cjs');

const disabled = '11111111-1111-1111-1111-111111111111';
const enabled = '22222222-2222-2222-2222-222222222222';
const browserFlag = '17519066';
const forcedFlag = '123929380';

test('real bridge notifications update main provider across 1p -> 3p and profile changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'growthbook-switch-r374-'));
  const local = path.join(root, 'local');
  const roaming = path.join(root, 'roaming');
  const userData = path.join(root, 'user-data');
  const library = path.join(local, 'Claude-3p', 'configLibrary');
  fs.mkdirSync(library, { recursive: true });
  fs.mkdirSync(roaming, { recursive: true });
  fs.writeFileSync(path.join(library, '_meta.json'), JSON.stringify({ entries: [
    { id: disabled, name: 'disabled' }, { id: enabled, name: 'enabled' },
  ], appliedId: disabled }));
  fs.writeFileSync(path.join(library, `${disabled}.json`), JSON.stringify({ builtinBrowserEnabled: false }));
  fs.writeFileSync(path.join(library, `${enabled}.json`), JSON.stringify({ builtinBrowserEnabled: true }));
  fs.writeFileSync(path.join(local, 'Claude-3p', 'claude_desktop_config.json'), JSON.stringify({ deploymentMode: '1p' }));

  const oldLocal = process.env.LOCALAPPDATA, oldRoaming = process.env.APPDATA, oldFetch = globalThis.fetch;
  process.env.LOCALAPPDATA = local; process.env.APPDATA = roaming;
  let fetchCount = 0, bridge, runtime;
  globalThis.fetch = async () => { fetchCount++; throw new Error('unexpected network'); };
  const notifications = [];
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) };
  const kernel = createSessionKernel({ emit() {}, createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }) });
  try {
    bridge = registerBridgeServices({ ipcMain,
      onMainFeatureSourceChanged: () => { if (runtime) notifications.push(runtime.accountChanged()); },
      bridgeMap: require('../desktop/shim/bridge-map.json'),
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
      settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel }, frontend: { root: process.cwd() },
    });
    runtime = createMainGrowthBookRuntime({ getContext: () => bridge.getMainGrowthBookContext(), userData,
      providerOptions: { setTimer() { return { unref() {} }; }, clearTimer() {} } });
    const call = (method, ...args) => {
      const channel = [...handlers.keys()].find(c => c.includes('_$_Custom3pSetup_$_') && c.endsWith(`_$_${method}`));
      assert.ok(channel, `missing ${method} handler`);
      return handlers.get(channel)({}, ...args);
    };
    const settle = async () => {
      let from = 0;
      while (from < notifications.length) {
        const batch = notifications.slice(from); from = notifications.length;
        await Promise.all(batch);
      }
      notifications.length = 0;
      await runtime.waitForGrowthBookSettled();
    };
    const assertValues = (forced, browser) => {
      assert.equal(runtime.getFeatureValue(forcedFlag, 'absent'), forced);
      assert.equal(runtime.getFeatureValue(browserFlag, 'absent'), browser);
    };

    assert.equal(bridge.getMainGrowthBookContext().mode, '1p');
    assert.equal(await runtime.init(), 'static');
    assertValues('absent', 'absent');

    await call('setAppliedConfig', disabled); await settle();
    assertValues(true, 'absent');
    await call('setAppliedConfig', enabled); await settle();
    assertValues(true, true);
    await call('setAppliedConfig', disabled); await settle();
    assertValues(true, 'absent');

    assert.deepEqual(await call('writeConfig', disabled, { builtinBrowser: { enabled: true } }), { ok: true });
    await settle(); assertValues(true, true);
    assert.deepEqual(await call('writeConfig', disabled, { builtinBrowser: { enabled: false } }), { ok: true });
    await settle(); assertValues(true, 'absent');
    // Deliberately do not settle between two application operations: the final
    // profile must win even when refresh notifications overlap.
    await call('setAppliedConfig', enabled);
    await call('setAppliedConfig', disabled);
    await settle(); assertValues(true, 'absent');
    assert.equal(fetchCount, 0);
    assert.equal(fs.existsSync(path.join(userData, 'fcache')), false);
  } finally {
    runtime?.dispose();
    await bridge?.dispose();
    globalThis.fetch = oldFetch;
    if (oldLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocal;
    if (oldRoaming === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldRoaming;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
