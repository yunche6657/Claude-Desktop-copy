import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function harness() {
  const sent = [];
  let emit;
  registerBridgeServices({
    ipcMain: { handle() {}, removeHandler() {} },
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } }),
    settings: { kernelFactory: options => {
      emit = options.emit;
      return createSessionKernel({ emit, createAgent: () => ({ run() {} }) });
    } },
    frontend: { root: process.cwd() },
  });
  return { sent, emit };
}

test('kernel error text reaches the field the shipped UI actually reads', () => {
  const h = harness();
  const event = { type: 'error', sessionId: 's', message: 'API 503: gateway unavailable', code: 'server' };
  h.emit(event);
  assert.equal(h.sent.length, 4);
  for (const { payload } of h.sent) {
    assert.equal(payload.error, event.message);
    assert.equal(payload.code, 'server');
    assert.equal(payload.message, event.message);
  }
  assert.equal(event.error, undefined, 'the producer object should not be mutated');
});

test('a producer supplying the frontend error field stays authoritative', () => {
  const h = harness();
  h.emit({ type: 'error', message: 'internal detail', error: 'specific frontend detail' });
  assert.equal(h.sent[0].payload.error, 'specific frontend detail');
});

test('other session events retain their original payload', () => {
  const h = harness();
  const event = { type: 'message', message: 'normal message' };
  h.emit(event);
  assert.deepEqual(h.sent[0].payload, event);
});
