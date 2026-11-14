// ClaudeCode.resolveLocalSettings feeds the Code settings pane.
//
// The consumer (shared-6-DkPBS4Mh.js) validates the answer against a zod schema in
// which every field is `.optional().catch(...)`. A null answer is parsed to `{}`
// (Pj), so every setting reads as "unknown" and the pane shows its defaults instead
// of this build's real configuration. A partial object is legal; null is not.
//
// patchUserSettings writes the values that resolveLocalSettings reads back, so a
// change in the pane must survive a re-read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

function makeBridge(overrides = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  let stored = {};
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 's', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => null,
    settings: {
      sidebarMode: 'epitaxy',
      themeMode: 'system',
      kernelFactory: () => kernel,
      readCodeSettings: () => ({ ...stored }),
      patchCodeSettings: (patch) => { stored = { ...stored, ...patch }; return { ...stored }; },
      ...overrides,
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

test('resolveLocalSettings answers an object, not null', async () => {
  const { call } = makeBridge();
  const settings = await call('ClaudeCode', 'resolveLocalSettings');
  assert.ok(settings, 'a null answer is parsed to {} and the pane loses every value');
  assert.equal(typeof settings, 'object');
  assert.equal(Array.isArray(settings), false);
});

test('the model field carries {value, source}', async () => {
  // The schema is `yj(e())` = { value, source?, path? } transformed to { value }.
  const { call } = makeBridge();
  const { model } = await call('ClaudeCode', 'resolveLocalSettings');
  assert.ok(model);
  assert.equal(typeof model.value, 'string');
  assert.ok(model.value.length > 0);
});

test('availableModels carries a value array', async () => {
  const { call } = makeBridge();
  const { availableModels } = await call('ClaudeCode', 'resolveLocalSettings');
  assert.ok(availableModels);
  assert.ok(Array.isArray(availableModels.value));
  assert.ok(availableModels.value.length >= 1);
});

test('boolean settings are reported as {value: boolean}', async () => {
  // Only these three use the boolean schema `c()`. disableBypassPermissionsMode and
  // disableAutoMode use `e()` (string) despite sounding boolean — asserting them here
  // is what this test originally got wrong; see code-settings-types.test.mjs.
  const { call } = makeBridge();
  const s = await call('ClaudeCode', 'resolveLocalSettings');
  for (const key of ['sandboxEnabled', 'strictSandboxMode', 'enableWorkflows']) {
    assert.ok(s[key], `missing ${key}`);
    assert.equal(typeof s[key].value, 'boolean', key);
  }
});

test('bypass permissions are reported as unavailable, with a reason', async () => {
  // The approval gate is the only path to a tool call in this build, so advertising
  // the bypass would misrepresent what actually happens. The field is a STRING
  // reason, not a boolean flag.
  const { call } = makeBridge();
  const s = await call('ClaudeCode', 'resolveLocalSettings');
  assert.equal(typeof s.disableBypassPermissionsMode.value, 'string');
  assert.ok(s.disableBypassPermissionsMode.value.length > 0);
});

test('patchUserSettings writes, and resolveLocalSettings reads it back', async () => {
  const { call } = makeBridge();
  const result = await call('ClaudeCode', 'patchUserSettings', { defaultPermissionMode: 'acceptEdits' });
  assert.equal(result.ok, true);

  const s = await call('ClaudeCode', 'resolveLocalSettings');
  assert.equal(s.defaultPermissionMode.value, 'acceptEdits');
});

test('patchUserSettings merges instead of replacing', async () => {
  const { call } = makeBridge();
  await call('ClaudeCode', 'patchUserSettings', { defaultPermissionMode: 'plan' });
  await call('ClaudeCode', 'patchUserSettings', { disableAutoMode: true });

  const s = await call('ClaudeCode', 'resolveLocalSettings');
  assert.equal(s.defaultPermissionMode.value, 'plan', 'the earlier value must survive');
  assert.equal(s.disableAutoMode.value, true);
});

test('an invalid patch is refused rather than stored', async () => {
  const { call } = makeBridge();
  for (const bad of [null, [1, 2], 'text', 42]) {
    const result = await call('ClaudeCode', 'patchUserSettings', bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('with no writer configured patchUserSettings reports not_writable', async () => {
  // Better an explicit refusal than a success that stores nothing.
  const { call } = makeBridge({ patchCodeSettings: undefined });
  const result = await call('ClaudeCode', 'patchUserSettings', { x: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_writable');
});

test('a throwing writer is reported, not propagated', async () => {
  const { call } = makeBridge({ patchCodeSettings: () => { throw new Error('disk full'); } });
  const result = await call('ClaudeCode', 'patchUserSettings', { x: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
});

test('a missing reader falls back to defaults without throwing', async () => {
  const { call } = makeBridge({ readCodeSettings: undefined });
  const s = await call('ClaudeCode', 'resolveLocalSettings');
  assert.ok(s);
  assert.equal(typeof s.defaultPermissionMode.value, 'string');
});
