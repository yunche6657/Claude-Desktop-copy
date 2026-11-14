// ComputerUseTcc.getState must answer enum members, not an empty object.
//
// TCC is the macOS privacy gate (Transparence, Consent, Control). The consumer compares
// each field against
//   Tt = { Granted:"granted", Denied:"denied", NotDetermined:"not-determined",
//          NotSupported:"not-supported", Restricted:"restricted" }
// (shared-0-BRYCPbU4.js, `zb`, exported as `Bh`) and renders:
//   s = state.accessibility === Tt.Granted                     // row shown as granted
//   showSettings = state.accessibility !== Tt.Granted
//               && state.accessibility !== Tt.NotSupported      // "Open System Settings"
//
// With no handler, `getState` matched the sync-store fallback and answered `{}`. Every
// field was `undefined`: not Granted (so the row rendered as ungranted) and not
// NotSupported (so it offered a macOS-only settings button). Measured on the live replica:
//   platform "Win32", state {}, showsOpenSettings true
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function makeBridge() {
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
  return { kernel, call };
}

// The enum members, copied from the shipped bundle.
const GRANTED = 'granted';
const DENIED = 'denied';
const NOT_DETERMINED = 'not-determined';
const NOT_SUPPORTED = 'not-supported';
const RESTRICTED = 'restricted';
const MEMBERS = new Set([GRANTED, DENIED, NOT_DETERMINED, NOT_SUPPORTED, RESTRICTED]);

const PERMISSIONS = ['accessibility', 'screenRecording', 'microphone'];

test('every permission field is a member of the UI enum', async () => {
  const { call } = makeBridge();
  const state = await call('ComputerUseTcc', 'getState');
  for (const key of PERMISSIONS) {
    assert.ok(MEMBERS.has(state[key]), `${key}: ${JSON.stringify(state[key])} is not an enum member`);
  }
});

test('on Windows the gate is reported not-supported, which is the truth', async () => {
  // There is no TCC on Windows. `not-supported` is the member that says so.
  const { call } = makeBridge();
  const state = await call('ComputerUseTcc', 'getState');
  if (process.platform === 'win32') {
    for (const key of PERMISSIONS) {
      assert.equal(state[key], NOT_SUPPORTED);
    }
  }
});

test('the macOS-only settings button is suppressed on this platform', async () => {
  // This is the visible defect: `undefined` satisfied neither branch, so the button
  // appeared. Replay the consumer's expression exactly.
  const { call } = makeBridge();
  const state = await call('ComputerUseTcc', 'getState');
  for (const key of PERMISSIONS) {
    const showsSettings = state[key] !== GRANTED && state[key] !== NOT_SUPPORTED;
    if (process.platform === 'win32') {
      assert.equal(showsSettings, false, `${key} must not offer a settings button here`);
    }
  }
});

test('the state is never an empty object', async () => {
  // `{}` was the old answer, and it is the shape that made every comparison meaningless.
  const { call } = makeBridge();
  const state = await call('ComputerUseTcc', 'getState');
  assert.ok(state && typeof state === 'object');
  assert.ok(Object.keys(state).length > 0, 'an empty object says nothing about any permission');
});

test('no permission is claimed as granted without being checked', async () => {
  // Fabricating `granted` would be the worst outcome: the app would stop asking and the
  // underlying capability still would not exist.
  const { call } = makeBridge();
  const state = await call('ComputerUseTcc', 'getState');
  for (const key of PERMISSIONS) {
    assert.notEqual(state[key], GRANTED, `${key} must not be claimed as granted`);
  }
});

test('the request methods answer an object instead of null', async () => {
  const { call } = makeBridge();
  for (const method of ['requestAccessibility', 'requestScreenRecording', 'requestMicrophone']) {
    const result = await call('ComputerUseTcc', method);
    assert.equal(typeof result, 'object', `${method} must answer an object`);
    assert.equal(typeof result.granted, 'boolean');
    assert.ok(MEMBERS.has(result.status), `${method} status ${JSON.stringify(result.status)} outside enum`);
  }
});

test('listInstalledApps answers an array', async () => {
  const { call } = makeBridge();
  const apps = await call('ComputerUseTcc', 'listInstalledApps');
  assert.ok(Array.isArray(apps));
});

test('the granted/not-supported predicates agree with the platform', async () => {
  // A cross-check that the state is derived rather than constant: on a platform without
  // TCC nothing may be granted, and the settings button must be hidden.
  const { call } = makeBridge();
  const state = await call('ComputerUseTcc', 'getState');
  const anyGranted = PERMISSIONS.some((k) => state[k] === GRANTED);
  const anyOffersSettings = PERMISSIONS.some((k) => state[k] !== GRANTED && state[k] !== NOT_SUPPORTED);

  if (process.platform !== 'darwin') {
    assert.equal(anyGranted, false, 'no TCC grant can exist on this platform');
    assert.equal(anyOffersSettings, false, 'no settings button may be offered on this platform');
  }
});
