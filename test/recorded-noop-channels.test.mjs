// Fire-and-forget notification channels answer null on purpose — recorded so they stop being
// re-investigated every round.
//
// METHOD. The Launch/RemoteControl methods the shipped frontend really calls were checked one by
// one. Most are not gaps; the ones below are deliberate no-ops because the consumer never reads
// the answer:
//
//   setRemoteSessionViewed(sessionId, viewed)   (cea3bd4e2-DcZ2RJBv.js)
//     t.setRemoteSessionViewed(n, true).catch(i),  return t?.setRemoteSessionViewed?.(n, false).catch(r)
//
//     The call site is an effect: it marks a session viewed while mounted and clears the mark on
//     unmount. BOTH calls end in .catch(); nothing reads the resolved value. Answering null is
//     therefore correct, and inventing a return shape would be noise.
//
// This test exists so a future round does not 'fix' it into something with behaviour the
// upstream does not have: remote sessions are hosted elsewhere and this build has no
// RemoteControlServing implementation at all (9 methods, 0 handlers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function callOn(service, method, ...args) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-noop-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
  const handlers = new Map();
  registerBridgeServices({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  });
  try {
    const channel = [...handlers.keys()].find((c) => {
      const seg = c.split('_$_');
      return seg[seg.length - 2] === service && seg[seg.length - 1] === method;
    });
    if (!channel) throw new Error('no handler for ' + service + '.' + method);
    return await handlers.get(channel)({}, ...args);
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* gone */ }
  }
}

test('setRemoteSessionViewed is a fire-and-forget no-op with no caller reading it', async () => {
  // The value is not asserted to be non-null on purpose: null IS the answer.
  // It is declared on Launch, not LocalSessions (checked against bridge-map.json).
  const answer = await callOn('Launch', 'setRemoteSessionViewed', 'session-x', true);
  assert.equal(answer, null, 'this channel is expected to answer the generic null');
});

test('RemoteControlServing is declared but unimplemented, and that is recorded', () => {
  // A guard against someone 'fixing' remote hosting into this reconstruction: the feature is
  // hosted elsewhere, so the honest answer for its channels is the generic fallback.
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json'), 'utf8'));
  const methods = map['claude.web'].RemoteControlServing;
  assert.ok(Array.isArray(methods), 'RemoteControlServing is no longer declared');
  assert.equal(methods.length, 9, 'the declared remote-control surface changed: ' + methods.length);
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const implemented = methods.filter((m) => bridge.includes('_$_' + m + "'"));
  assert.deepEqual(implemented, [], 'remote control gained an implementation without a remote host behind it');
});