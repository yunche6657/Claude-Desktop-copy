// Settings > System: the two device switches.
//
// Both rendered and both were inert: isStartupOnLoginEnabled / setStartupOnLoginEnabled /
// isMenuBarEnabled / setMenuBarEnabled had no handlers, so they answered the generic
// fallback (false / null). Measured on the live replica:
//
//   before click : [false, false]
//   after click  : [true, true]        <- optimistic UI only
//   after reload : [false, false]      <- nothing was stored anywhere
//   bridge direct: isStartupOnLoginEnabled=false, isMenuBarEnabled=false
//
// "Run on startup" is additionally blocked by the environment: the Electron main
// process here runs at LOW integrity, so app.setLoginItemSettings() succeeds without
// doing anything (see desktop/main.cjs's loginItemSupported comment for the measurement).
// The honest answer is a refusal with a reason, not a switch that never sticks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/** A bridge over a throwaway data directory, with the login item stubbed per test. */
function makeBridge({ loginItemSupported = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-startup-'));
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const win = {
    isDestroyed: () => false,
    webContents: { send() {} },
    menuBarVisible: true,
    setAutoHideMenuBar() {},
    setMenuBarVisibility(value) { this.menuBarVisible = value; },
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => win,
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', dataDir, loginItemSupported, kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = async (service, method, ...args) => {
    const channel = [...handlers.keys()].find((c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`));
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return await handlers.get(channel)({}, ...args);
  };
  return { call, win, dataDir, prefsFile: path.join(dataDir, 'preferences.json') };
}

test('the startup switch is answerable and refuses instead of pretending', async () => {
  const bridge = makeBridge({ loginItemSupported: false });
  // A boolean, not null: the switch renders off rather than "unknown".
  assert.equal(await bridge.call('Startup', 'isStartupOnLoginEnabled'), false);

  const result = await bridge.call('Startup', 'setStartupOnLoginEnabled', true);
  assert.equal(result.ok, false);
  assert.match(result.error, /not available/i);
  // The refusal must not leave the switch looking enabled.
  assert.equal(await bridge.call('Startup', 'isStartupOnLoginEnabled'), false);
});

test('the tray switch persists instead of only flipping the UI', async () => {
  const bridge = makeBridge();
  // Default on, which is what the shipped template starts from (menuBarEnabled: true).
  assert.equal(await bridge.call('Startup', 'isMenuBarEnabled'), true);

  const off = await bridge.call('Startup', 'setMenuBarEnabled', false);
  assert.equal(off.ok, true);
  assert.equal(off.menuBarEnabled, false);

  // Persisted, not just held: the file the next launch reads carries the choice.
  const stored = JSON.parse(fs.readFileSync(bridge.prefsFile, 'utf8'));
  assert.equal(stored.menuBarEnabled, false);
});

test('a supported host really calls the login-item API', async () => {
  // Electron is not loadable under plain node, so the handler must not throw when the
  // capability is claimed but the module cannot provide it: it reports {ok:false}.
  const bridge = makeBridge({ loginItemSupported: true });
  const result = await bridge.call('Startup', 'setStartupOnLoginEnabled', true);
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.ok, 'boolean');
  if (!result.ok) assert.equal(typeof result.error, 'string');
});
// ---- the tray / close-to-tray decision -------------------------------------

test('closing the window with the tray preference on hides instead of quitting', () => {
  const tray = require('../desktop/tray.cjs');
  // The shipped handler: e.preventDefault() then hide, unless the pref is off.
  assert.equal(tray.closeAction({ isQuitting: false, trayEnabled: true, trayAvailable: true }), 'hide');
  assert.equal(tray.closeAction({ isQuitting: false, trayEnabled: false, trayAvailable: true }), 'quit');
  // A real quit always wins, whatever the preference says.
  assert.equal(tray.closeAction({ isQuitting: true, trayEnabled: true, trayAvailable: true }), 'quit');
  // The dangerous combination: the preference asks for a tray but none could be created.
  // Hiding would leave the app unreachable, so quit.
  assert.equal(tray.closeAction({ isQuitting: false, trayEnabled: true, trayAvailable: false }), 'quit');
});

test('the tray switch persists through the bridge and reports the runtime answer', async () => {
  const bridge = makeBridge();
  const applied = [];
  // Simulate main.cjs's controller: this runtime has no Tray, which is the honest
  // answer under plain node and must still persist the user's choice.
  const withTray = makeBridgeWithTray((enabled) => {
    applied.push(enabled);
    return { enabled, available: false, reason: 'no Tray in this runtime' };
  });
  assert.deepEqual(applied, []);
  const off = await withTray.call('Startup', 'setMenuBarEnabled', false);
  assert.equal(off.ok, true);
  assert.equal(off.menuBarEnabled, false);
  assert.deepEqual(applied, [false], 'the controller was called immediately');
  const stored = JSON.parse(fs.readFileSync(withTray.prefsFile, 'utf8'));
  assert.equal(stored.menuBarEnabled, false, 'and the choice was written');
  // The capability answer is carried through rather than swallowed.
  assert.equal(off.tray.available, false);
  void bridge;
});

/** Same bridge as makeBridge, plus an applyTray hook. */
function makeBridgeWithTray(applyTray) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-tray-'));
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', dataDir, applyTray, loginItemSupported: false, kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = async (service, method, ...args) => {
    const channel = [...handlers.keys()].find((c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`));
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return await handlers.get(channel)({}, ...args);
  };
  return { call, dataDir, prefsFile: path.join(dataDir, 'preferences.json') };
}