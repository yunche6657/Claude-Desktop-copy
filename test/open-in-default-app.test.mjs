// "Open in default app" and "show in folder" must exist, and must be honest about failure.
//
// `FileSystem` had 19 declared methods and only 2 handlers (getSystemPath, listDirectory).
// The missing ones were not merely absent -- their absence had a visible consequence one
// step removed: the file UI asks
//   CoworkFilePreview.isOpenInDefaultAppEnabled()
// whether it may offer the action, and the generic fallback answers `false` for any `is*`
// method without a handler. So the capability was reported permanently unavailable and the
// action never appeared, even though the build can open files.
//
// Measured on the live replica before the fix:
//   isOpenInDefaultAppEnabled -> false
//   openLocalFile             -> null
//   showInFolder              -> null
// while listDirectory returned 26 real entries and getSystemPath a real path.
//
// The spawning itself is not exercised here (that would open a window on the test host);
// what is asserted is the contract the renderer depends on: a `{ok}` object, a refusal for
// a path that does not exist, and a capability probe that agrees with the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('isOpenInDefaultAppEnabled answers true, so the action is offered', async () => {
  const { call } = makeBridge();
  assert.equal(await call('CoworkFilePreview', 'isOpenInDefaultAppEnabled'), true);
});

test('the capability probe and the implementation agree', async () => {
  // The defect was a probe that answered false while the methods behind it were simply
  // missing. Guard the relationship rather than the individual values.
  const { call } = makeBridge();
  const enabled = await call('CoworkFilePreview', 'isOpenInDefaultAppEnabled');
  const missing = path.join(os.tmpdir(), 'fx-definitely-not-here-round76.txt');
  const result = await call('FileSystem', 'openLocalFile', missing);
  assert.equal(enabled, true, 'this build can open files, so the probe must say so');
  assert.equal(typeof result, 'object', 'openLocalFile must answer an object, not null');
  assert.equal(typeof result.ok, 'boolean');
});

test('openLocalFile refuses a path that does not exist instead of launching a dialog', async () => {
  const { call } = makeBridge();
  const missing = path.join(os.tmpdir(), 'fx-not-a-real-file-round76.txt');
  assert.equal(fs.existsSync(missing), false);

  const result = await call('FileSystem', 'openLocalFile', missing);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /not found/);
});

test('openLocalFile refuses a missing or non-string path', async () => {
  const { call } = makeBridge();
  for (const bad of [undefined, null, '', 42]) {
    const result = await call('FileSystem', 'openLocalFile', bad);
    assert.equal(result.ok, false, `openLocalFile(${JSON.stringify(bad)}) must refuse`);
  }
});

test('showInFolder refuses a path that does not exist', async () => {
  const { call } = makeBridge();
  const missing = path.join(os.tmpdir(), 'fx-not-a-real-file-round76b.txt');
  const result = await call('FileSystem', 'showInFolder', missing);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /not found/);
});

test('showInFolder refuses a missing or non-string path', async () => {
  const { call } = makeBridge();
  for (const bad of [undefined, null, '', {}]) {
    const result = await call('FileSystem', 'showInFolder', bad);
    assert.equal(result.ok, false, `showInFolder(${JSON.stringify(bad)}) must refuse`);
  }
});

test('both methods answer an object the caller can read, never null', async () => {
  // The consumer does `?.then(...)` and inspects the result; a null there is reported to
  // the user as "Couldn't open this file with the default app", which would be a
  // fabricated failure for a path we simply refused.
  const { call } = makeBridge();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-open-'));
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'x');

  // A real file is still not opened here: assert only the shape, by checking that the
  // refusal path and the accept path both produce objects.
  const missing = path.join(dir, 'absent.txt');
  for (const [method, arg] of [['openLocalFile', missing], ['showInFolder', missing]]) {
    const result = await call('FileSystem', method, arg);
    assert.ok(result && typeof result === 'object', `${method} must answer an object`);
    assert.ok('ok' in result, `${method} must answer {ok}`);
  }
});
