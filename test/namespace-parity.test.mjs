// The two session namespaces must behave the same.
//
// The composer picks its transport by surface, and LocalSessions and
// LocalAgentModeSessions expose the same method names. Rounds 17-19 implemented
// setModel / setEffort / setPermissionMode / updateSession / stop on LocalSessions
// only, so a surface talking to LocalAgentModeSessions would find every one of them
// dead:
//
//   LocalSessions.setModel            -> the updated record
//   LocalAgentModeSessions.setModel   -> null
//
// These tests pin the parity so the two cannot drift again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { VALID_MODES } = require('../desktop/permissions.cjs');

const NAMESPACES = ['LocalSessions', 'LocalAgentModeSessions'];

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

test('setModel works in both namespaces', async () => {
  for (const ns of NAMESPACES) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    const result = await call(ns, 'setModel', s.sessionId, 'claude-opus-5-5');
    assert.ok(result, `${ns}.setModel answered null`);
    assert.equal(kernel.getSession(s.sessionId).model, 'claude-opus-5-5', ns);
  }
});

test('setEffort works in both namespaces', async () => {
  for (const ns of NAMESPACES) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    const result = await call(ns, 'setEffort', s.sessionId, 'high');
    assert.ok(result, `${ns}.setEffort answered null`);
    assert.equal(kernel.getSession(s.sessionId).effortLevel, 'high', ns);
  }
});

test('setPermissionMode works in both namespaces', async () => {
  for (const ns of NAMESPACES) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    const result = await call(ns, 'setPermissionMode', s.sessionId, 'plan');
    assert.ok(result, `${ns}.setPermissionMode answered null`);
    assert.equal(kernel.getSession(s.sessionId).permissionMode, 'plan', ns);
  }
});

test('updateSession works in both namespaces', async () => {
  for (const ns of NAMESPACES) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    const result = await call(ns, 'updateSession', s.sessionId, { title: `renamed-by-${ns}` });
    assert.ok(result, `${ns}.updateSession answered null`);
    assert.equal(kernel.getSession(s.sessionId).title, `renamed-by-${ns}`, ns);
  }
});

test('both namespaces validate the permission mode the same way', async () => {
  for (const ns of NAMESPACES) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    await call(ns, 'setPermissionMode', s.sessionId, 'plan');
    assert.equal(await call(ns, 'setPermissionMode', s.sessionId, 'yolo'), null, ns);
    assert.equal(kernel.getSession(s.sessionId).permissionMode, 'plan', ns);
  }
});

test('both namespaces accept every valid permission mode', async () => {
  for (const ns of NAMESPACES) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    for (const mode of VALID_MODES) {
      assert.ok(await call(ns, 'setPermissionMode', s.sessionId, mode), `${ns}: ${mode}`);
      assert.equal(kernel.getSession(s.sessionId).permissionMode, mode);
    }
  }
});

test('both namespaces refuse an empty model', async () => {
  // One bridge per namespace: building two and taking the kernel from one while
  // calling through the other makes setModel return null because the session is
  // unknown, not because the empty model was refused — a false pass.
  for (const ns of NAMESPACES) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    await call(ns, 'setModel', s.sessionId, 'claude-opus-5-5');

    assert.equal(await call(ns, 'setModel', s.sessionId, ''), null, ns);
    assert.equal(await call(ns, 'setModel', s.sessionId, null), null, ns);
    assert.equal(kernel.getSession(s.sessionId).model, 'claude-opus-5-5',
      `${ns}: the prior model must survive a refused write`);
  }
});

test('stopTask reports a result in the agent namespace', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  const result = await call('LocalAgentModeSessions', 'stopTask', s.sessionId);
  assert.equal(typeof result, 'object');
  assert.equal(result.ok, true);
  assert.equal(typeof result.cancelled, 'boolean');
});

test('mutating through one namespace is visible through the other', async () => {
  // They share one kernel, so a write on either side must be readable on both.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });

  await call('LocalAgentModeSessions', 'setModel', s.sessionId, 'claude-opus-5-5');
  const viaLocal = await call('LocalSessions', 'getSession', s.sessionId);
  assert.equal(viaLocal.model, 'claude-opus-5-5');

  await call('LocalSessions', 'setPermissionMode', s.sessionId, 'plan');
  const viaAgent = await call('LocalAgentModeSessions', 'getSession', s.sessionId);
  assert.equal(viaAgent.permissionMode, 'plan');
});
