// Custom3pSetup.listConfigs and readConfig must answer the shapes their consumer destructures.
//
// The consumer (c71860c77, fn j) does:
//   let t = await e.listConfigs();
//   i(t.entries); o(t.appliedId); m(t.isManaged); v(t.platform);
//   x.current = t.isInternalBuild ?? false;
//   if (t.isManaged) { ... t.managedConfig ... }
//
// It answered a bare ARRAY, so `t.entries` and `t.appliedId` were both undefined: the list
// rendered empty and the active profile was never marked. Measured live before the fix:
//   listConfigs -> "array(1)"
//
// And fn M does:
//   let n = await e.readConfig(t);
//   return n.ok ? (onLoadConfig(t, n.config, ...), true) : (onError(n.error ?? "unknown"), false)
// It answered a bare config object, so `n.ok` was undefined and opening a profile ALWAYS
// reported an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/**
 * Build a bridge pointed at a throwaway config library, via LOCALAPPDATA, so the real
 * %LOCALAPPDATA%\Claude-3p\configLibrary is never read or written by these tests.
 *
 * The library mirrors the shipped layout exactly:
 *   configLibrary/_meta.json   -> { entries: [{id, name}], appliedId }
 *   configLibrary/<id>.json    -> the provider configuration
 * Measured on this host: _meta.json is 167 bytes with one entry named "CC Switch".
 * @param {object|null} config contents for the one profile, or null for "none exists"
 */
function makeBridge(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-c3p-'));
  const dir = path.join(root, 'Claude-3p', 'configLibrary');
  fs.mkdirSync(dir, { recursive: true });
  if (config !== null) {
    fs.writeFileSync(path.join(dir, 'profile-a.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({
      entries: [{ id: 'profile-a', name: 'CC Switch' }],
      appliedId: 'profile-a',
    }, null, 2));
  }

  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;

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

  const restore = () => {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  };
  return { call, restore };
}

const SAMPLE = {
  deploymentMode: '3p',
  inferenceProvider: 'gateway',
  inferenceGatewayBaseUrl: 'https://example.invalid',
};

test('listConfigs answers an object with entries, not a bare array', async () => {
  const { call, restore } = makeBridge(SAMPLE);
  try {
    const result = await call('Custom3pSetup', 'listConfigs');
    assert.equal(Array.isArray(result), false, 'a bare array leaves every destructured field undefined');
    assert.equal(typeof result, 'object');
    assert.ok(Array.isArray(result.entries), 'entries must be an array the list can map');
  } finally { restore(); }
});

test('the fields the consumer destructures are all present', async () => {
  const { call, restore } = makeBridge(SAMPLE);
  try {
    const result = await call('Custom3pSetup', 'listConfigs');
    for (const key of ['entries', 'appliedId', 'isManaged', 'managedConfig', 'platform', 'isInternalBuild']) {
      assert.ok(key in result, `the consumer reads .${key}; it must exist`);
    }
    assert.equal(typeof result.isManaged, 'boolean');
    assert.equal(typeof result.isInternalBuild, 'boolean');
    assert.equal(typeof result.platform, 'string');
  } finally { restore(); }
});

test('appliedId names the config that exists', async () => {
  // Without this the active profile is never marked in the list.
  const { call, restore } = makeBridge(SAMPLE);
  try {
    const result = await call('Custom3pSetup', 'listConfigs');
    assert.equal(result.entries.length, 1);
    assert.equal(typeof result.appliedId, 'string');
    assert.equal(result.appliedId, result.entries[0].id,
      'the applied id must match the entry it refers to');
  } finally { restore(); }
});

test('no config still answers the full shape', async () => {
  // An absent file must produce an empty list, not a different type -- the consumer does not
  // branch on the shape.
  const { call, restore } = makeBridge(null);
  try {
    const result = await call('Custom3pSetup', 'listConfigs');
    assert.equal(Array.isArray(result.entries), true);
    assert.equal(result.entries.length, 0);
    assert.equal(result.appliedId, null);
    assert.equal(result.isManaged, false);
  } finally { restore(); }
});

test('readConfig answers { ok, config }, which is what the caller checks', async () => {
  // A bare config made `n.ok` undefined, so the caller always took the failure branch.
  const { call, restore } = makeBridge(SAMPLE);
  try {
    const result = await call('Custom3pSetup', 'readConfig');
    assert.equal(typeof result, 'object');
    assert.equal(result.ok, true, 'the caller does `n.ok ? ... : onError(...)`');
    assert.equal(typeof result.config, 'object');
    assert.equal(result.config.inferenceProvider, 'gateway');
  } finally { restore(); }
});

test('readConfig reports a missing config instead of answering null', async () => {
  const { call, restore } = makeBridge(null);
  try {
    const result = await call('Custom3pSetup', 'readConfig');
    assert.equal(typeof result, 'object');
    assert.equal(result.ok, false);
    assert.ok(result.error, 'the failure must carry a reason');
  } finally { restore(); }
});

test('readConfig refuses an id that is not the file on disk', async () => {
  // Reading the wrong profile would edit the wrong provider configuration.
  const { call, restore } = makeBridge(SAMPLE);
  try {
    const listed = await call('Custom3pSetup', 'listConfigs');
    const goodId = listed.entries[0].id;

    const good = await call('Custom3pSetup', 'readConfig', goodId);
    assert.equal(good.ok, true);

    const bad = await call('Custom3pSetup', 'readConfig', 'some-other-id');
    assert.equal(bad.ok, false, 'an unknown id must not return the current config');
  } finally { restore(); }
});

test('the round trip the UI performs works end to end', async () => {
  // list -> read -> read the config the list named.
  const { call, restore } = makeBridge(SAMPLE);
  try {
    const list = await call('Custom3pSetup', 'listConfigs');
    assert.equal(list.entries.length, 1);
    const read = await call('Custom3pSetup', 'readConfig', list.entries[0].id);
    assert.equal(read.ok, true);
    assert.deepEqual(read.config, SAMPLE);
  } finally { restore(); }
});
