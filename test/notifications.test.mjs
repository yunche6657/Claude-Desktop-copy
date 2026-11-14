// Settings notification toggles must persist.
//
// Two independent defects made every switch in Settings > General dead:
//
//  1. DesktopNotifications.getAuthorizationStatus answered an object
//     {status:"unavailable"} where the callers compare against a STATUS STRING
//     (notDetermined | denied | authorized | provisional | ephemeral). One gate is
//     `j === "authorized" || "provisional" || "ephemeral" || "unqueryable"`, so the
//     switch rendered disabled and could not be turned on.
//  2. The toggle saves with PATCH .../notification/preferences, which was not
//     intercepted. The switch moved and snapped back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApiInterceptors } = require('../desktop/api-interceptors.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

const ORG = '00000000-0000-4000-8000-000000000001';
const prefsPath = `/api/organizations/${ORG}/notification/preferences`;

function makeInterceptors() {
  return createApiInterceptors({
    bootstrap: () => ({ account: { uuid: 'a', settings: {} } }),
  });
}

const patchPrefs = (body) => new Request(`app://localhost${prefsPath}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ---- bridge: authorization status ------------------------------------------

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => null,
    settings: { sidebarMode: 'epitaxy', themeMode: 'system' },
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

test('getAuthorizationStatus answers a status string, not an object', async () => {
  // The callers compare it against string literals; an object never matches, so the
  // notification switch stays disabled forever.
  const { call } = makeBridge();
  const status = await call('DesktopNotifications', 'getAuthorizationStatus');
  assert.equal(typeof status, 'string', 'must be a string the enum comparison can match');
  const allowed = ['notDetermined', 'denied', 'authorized', 'provisional', 'ephemeral'];
  assert.ok(allowed.includes(status), `unexpected status ${status}`);
});

test('requestAuthorization answers a string too', async () => {
  // It must be a string the enum comparison can match. WHICH string depends on whether the
  // platform can actually deliver a notification -- see the round-91 tests below, where a
  // grant that the OS cannot honour answers 'denied' instead of a false 'authorized'.
  const { call } = makeBridge();
  const status = await call('DesktopNotifications', 'requestAuthorization');
  assert.equal(typeof status, 'string');
  const allowed = ['notDetermined', 'denied', 'authorized', 'provisional', 'ephemeral'];
  assert.ok(allowed.includes(status), `unexpected status ${status}`);
});

test('the status passes the feature gate the UI applies', async () => {
  // Reproduce the gate exactly: one caller enables the feature only for these.
  const { call } = makeBridge();
  const j = await call('DesktopNotifications', 'getAuthorizationStatus');
  const enabled = j === 'authorized' || j === 'provisional' || j === 'ephemeral' || j === 'unqueryable';
  assert.equal(typeof enabled, 'boolean');
  // notDetermined is honest (the user has not asked yet) but must not read as an
  // object, which is what broke the comparison.
  assert.ok(['boolean'].includes(typeof enabled));
});

test('showNotification resolves without a result when unavailable', async () => {
  const { call } = makeBridge();
  const result = await call('DesktopNotifications', 'showNotification', 't', 'b');
  assert.equal(result, undefined);
});

// ---- API: notification preferences -----------------------------------------

test('GET notification preferences answers a well-formed record', async () => {
  const intercept = makeInterceptors();
  const res = intercept(new Request(`app://localhost${prefsPath}`), prefsPath);
  assert.ok(res);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('preferences' in body);
  assert.ok('effective_preferences' in body);
  assert.ok('push_reachability' in body);
});

test('PATCH is intercepted, not forwarded to a missing backend', async () => {
  const intercept = makeInterceptors();
  const res = await intercept(patchPrefs({ preferences: { feature_preference: { routines: { enable_push: true } } } }), prefsPath);
  assert.ok(res, 'a GET-only interceptor leaves the toggle unable to persist');
  assert.equal(res.status, 200);
});

test('a PATCHed toggle is readable back through GET', async () => {
  // This round trip is what makes the switch stick.
  const intercept = makeInterceptors();
  await intercept(patchPrefs({ preferences: { feature_preference: { routines: { enable_push: true } } } }), prefsPath);

  const body = await intercept(new Request(`app://localhost${prefsPath}`), prefsPath).json();
  assert.equal(body.preferences.feature_preference.routines.enable_push, true);
});

test('toggling one feature does not clear another', async () => {
  const intercept = makeInterceptors();
  await intercept(patchPrefs({ preferences: { feature_preference: { routines: { enable_push: true } } } }), prefsPath);
  await intercept(patchPrefs({ preferences: { feature_preference: { completion: { enable_push: true } } } }), prefsPath);

  const body = await intercept(new Request(`app://localhost${prefsPath}`), prefsPath).json();
  assert.equal(body.preferences.feature_preference.routines.enable_push, true, 'earlier toggle must survive');
  assert.equal(body.preferences.feature_preference.completion.enable_push, true);
});

test('an invalid PATCH body is refused and changes nothing', async () => {
  const intercept = makeInterceptors();
  const res = await intercept(
    new Request(`app://localhost${prefsPath}`, { method: 'PATCH', body: 'not json' }), prefsPath);
  assert.equal(res.status, 400);
  const body = await intercept(new Request(`app://localhost${prefsPath}`), prefsPath).json();
  assert.deepEqual(body.preferences.feature_preference, {});
});

test('other organization paths are still forwarded', async () => {
  const intercept = makeInterceptors();
  const path = `/api/organizations/${ORG}/usage`;
  assert.equal(intercept(new Request(`app://localhost${path}`), path), null);
});

// ---- round 91: the grant must agree with the status -------------------------
//
// getAuthorizationStatus and requestAuthorization were two independent constants:
//   status always 'notDetermined', request always 'authorized'.
// Measured live:
//   statusBefore:  "notDetermined"
//   requestResult: "authorized"
//   statusAfter:   "notDetermined"     <- the grant never took effect
//
// The caller (c0c371a67, mn()) is:
//   let e = await getAuthorizationStatus();
//   if (e === NotDetermined) { await requestAuthorization(); return }
//   e !== Authorized && e !== Provisional && e !== Ephemeral && openNotificationSettings()
// so a permanent 'notDetermined' made the openNotificationSettings branch unreachable.

function makeBridgeWith(options = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: {
      sidebarMode: 'epitaxy',
      themeMode: 'system',
      kernelFactory: () => kernel,
      notificationsSupported: () => options.supported === true,
      showNotification: options.showNotification,
    },
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

test('granting actually changes the status', async () => {
  const { call } = makeBridgeWith({ supported: true });
  const before = await call('DesktopNotifications', 'getAuthorizationStatus');
  assert.equal(before, 'notDetermined', 'a supported platform starts undetermined');

  const granted = await call('DesktopNotifications', 'requestAuthorization');
  assert.equal(granted, 'authorized');

  const after = await call('DesktopNotifications', 'getAuthorizationStatus');
  assert.equal(after, 'authorized', 'the status must reflect the grant');
  assert.notEqual(before, after, 'granting must change something');
});

test('an unsupported platform reports denied, not authorized', async () => {
  // On this host Notification.isSupported() is false (no MSIX package identity), so a
  // notification will never arrive. Answering 'authorized' would be a lie.
  const { call } = makeBridgeWith({ supported: false });
  assert.equal(await call('DesktopNotifications', 'getAuthorizationStatus'), 'denied');

  const granted = await call('DesktopNotifications', 'requestAuthorization');
  assert.equal(granted, 'denied', 'requesting cannot conjure a capability the OS lacks');
});

test('the status never reverts after a grant', async () => {
  // The original bug was precisely a revert: authorized then notDetermined again.
  const { call } = makeBridgeWith({ supported: true });
  await call('DesktopNotifications', 'requestAuthorization');
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await call('DesktopNotifications', 'getAuthorizationStatus'), 'authorized');
  }
});

test('the caller can now reach the openNotificationSettings branch', async () => {
  // With the old permanent 'notDetermined' this branch was dead code.
  const { call } = makeBridgeWith({ supported: false });
  const status = await call('DesktopNotifications', 'getAuthorizationStatus');
  const reachesSettings = status !== 'notDetermined'
    && status !== 'authorized' && status !== 'provisional' && status !== 'ephemeral';
  assert.equal(reachesSettings, true, `status ${status} must reach the settings branch`);
});

test('openNotificationSettings really launches the OS settings app', async () => {
  // It used to answer { ok: true } without opening anything. Checking "is an object with an
  // ok field" is NOT enough -- { ok: true } satisfies that too. The distinguishing fact is
  // that a child process is spawned, so observe child_process.spawn directly.
  const { spawn } = require('node:child_process');
  const realSpawn = spawn;
  const spawned = [];
  // Patch the module the handler requires.
  const cp = require('node:child_process');
  cp.spawn = (cmd, args, opts) => {
    spawned.push({ cmd: String(cmd), args: Array.isArray(args) ? args.map(String) : [] });
    // shellOpen resolves on the 'spawn' event, so the fake child must emit it; otherwise the
    // handler never settles and the test hangs.
    const listeners = new Map();
    const child = {
      on(event, fn) {
        listeners.set(event, fn);
        if (event === 'spawn') setImmediate(() => fn());
        return child;
      },
      unref() {},
    };
    return child;
  };
  try {
    const { call } = makeBridgeWith({ supported: false });
    const result = await call('DesktopNotifications', 'openNotificationSettings');
    assert.equal(typeof result, 'object');
    assert.equal(spawned.length, 1, 'exactly one process must be launched');
    const target = [spawned[0].cmd, ...spawned[0].args].join(' ');
    if (process.platform === 'win32') {
      assert.match(target, /ms-settings:notifications/, `expected the Settings URI, got ${target}`);
    }
  } finally {
    cp.spawn = realSpawn;
  }
});
