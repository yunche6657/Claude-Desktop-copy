// resolveLocalSettings must answer the TYPES the consumer's schema expects.
//
// The schema (shared-6-DkPBS4Mh.js) wraps every field in
//   bj(name, yj(T))   where yj(t) = union([{value: t, source?, path?}, t.transform(...)])
//
// and T differs per field:
//
//   model, defaultPermissionMode              -> e()  (string)
//   availableModels                           -> f(e()) (array of string)
//   fastMode, sandboxEnabled, enableWorkflows -> c()  (boolean)
//   disableBypassPermissionsMode, disableAutoMode -> e()  (STRING, not boolean)
//
// Answering a boolean for the last two fails with
//   "expected string, received boolean"
// and the field is silently dropped with a console warning, so the pane never learns
// that bypass is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
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
      readCodeSettings: () => ({}),
      patchCodeSettings: () => ({}),
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

/** Mirrors the consumer's yj() union: either the bare value or {value}. */
function accepts(value, kind) {
  const inner = value && typeof value === 'object' && 'value' in value ? value.value : value;
  if (kind === 'string') return typeof inner === 'string';
  if (kind === 'boolean') return typeof inner === 'boolean';
  if (kind === 'string[]') return Array.isArray(inner) && inner.every((x) => typeof x === 'string');
  return false;
}

test('string-typed fields answer strings', async () => {
  const { call } = makeBridge();
  const s = await call('ClaudeCode', 'resolveLocalSettings');
  for (const field of ['model', 'defaultPermissionMode']) {
    assert.ok(accepts(s[field], 'string'), `${field} must be a string, got ${JSON.stringify(s[field])}`);
  }
});

test('disableBypassPermissionsMode answers a STRING, not a boolean', async () => {
  // This is the exact field that failed: it uses e() (string) while its siblings use
  // c() (boolean), so a reasonable-looking `true` is wrong.
  const { call } = makeBridge();
  const s = await call('ClaudeCode', 'resolveLocalSettings');
  assert.ok(accepts(s.disableBypassPermissionsMode, 'string'),
    `must be a string reason, got ${JSON.stringify(s.disableBypassPermissionsMode)}`);
});

test('disableAutoMode answers a STRING, not a boolean', async () => {
  const { call } = makeBridge();
  const s = await call('ClaudeCode', 'resolveLocalSettings');
  assert.ok(accepts(s.disableAutoMode, 'string'),
    `must be a string, got ${JSON.stringify(s.disableAutoMode)}`);
});

test('boolean-typed fields answer booleans', async () => {
  const { call } = makeBridge();
  const s = await call('ClaudeCode', 'resolveLocalSettings');
  for (const field of ['sandboxEnabled', 'strictSandboxMode', 'enableWorkflows']) {
    assert.ok(accepts(s[field], 'boolean'), `${field} must be a boolean, got ${JSON.stringify(s[field])}`);
  }
});

test('availableModels answers an array of strings', async () => {
  const { call } = makeBridge();
  const s = await call('ClaudeCode', 'resolveLocalSettings');
  assert.ok(accepts(s.availableModels, 'string[]'),
    `must be string[], got ${JSON.stringify(s.availableModels)}`);
});

test('the bypass reason explains itself rather than being an empty string', async () => {
  // The pane shows this as the reason the option is disabled; an empty string would
  // render as a disabled control with no explanation.
  const { call } = makeBridge();
  const s = await call('ClaudeCode', 'resolveLocalSettings');
  const reason = s.disableBypassPermissionsMode.value;
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 0, 'the reason must say something');
});

test('every field carries a {value} wrapper', async () => {
  // yj() accepts a bare value too, but the wrapper is what carries `source`, and the
  // pane reads it to distinguish a stored value from a default.
  const { call } = makeBridge();
  const s = await call('ClaudeCode', 'resolveLocalSettings');
  for (const [field, entry] of Object.entries(s)) {
    assert.equal(typeof entry, 'object', `${field} must be an object`);
    assert.ok('value' in entry, `${field} must carry a value`);
  }
});
