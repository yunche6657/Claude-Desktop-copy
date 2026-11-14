'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices, messageChannel } = require('../desktop/bridge-services.cjs');
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeFixture(t) {
  const withdrawalAck = Promise.withResolvers();
  const releaseTurn = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const stored = new Set([B]);
  const kernelEvents = [], uiEvents = [], handlers = new Map(), listeners = new Set();
  const backend = {
    id: 'ccb',
    start() {}, cancel() {}, dispose() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getSteerUuids() { return [...stored]; },
    withdrawSteer(_sessionId, uuid) {
      return withdrawalAck.promise.then(confirmed => {
        if (confirmed) stored.delete(uuid);
        return confirmed;
      });
    },
    async sendMessage() {
      entered.resolve();
      await releaseTurn.promise;
      return { text: 'fixture', stopReason: 'end_turn' };
    },
  };
  const kernel = createSessionKernel({ backend, emit: event => kernelEvents.push(event) });
  const bridge = registerBridgeServices({
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false,
      webContents: { send: (_channel, payload) => uiEvents.push(payload) } }),
    settings: { kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  t.after(() => {
    withdrawalAck.resolve(false);
    releaseTurn.resolve();
    bridge.dispose();
    kernel.dispose();
  });
  const { sessionId } = kernel.start({});
  const discard = () => handlers.get(messageChannel('claude.web', 'LocalSessions', 'discardPendingTurn'))({}, sessionId);
  const startTurn = async () => {
    const task = kernel.sendMessage(sessionId, 'active prompt');
    task.catch(() => {});
    await entered.promise;
    assert.equal(kernel.getSession(sessionId).isRunning, true);
    // Return an object: returning the pending Promise from an async helper
    // would make the test await the entire blocked turn, not its admission.
    return { task };
  };
  return { kernel, sessionId, kernelEvents, uiEvents, stored, withdrawalAck, releaseTurn, discard, startTurn,
    emitBackend: event => { for (const listener of listeners) listener(event); } };
}

test('async steer withdrawal cannot announce success before acknowledgement', async t => {
  const f = makeFixture(t);
  const attempt = f.kernel.cancelQueuedMessage(f.sessionId, B);
  assert.equal(f.kernelEvents.filter(e => e.type === 'held_input_withdrawn').length, 0,
    'unresolved Promise is not withdrawal confirmation');
  f.withdrawalAck.resolve(true);
  assert.equal(await attempt, true);
  assert.deepEqual(f.kernelEvents.filter(e => e.type === 'held_input_withdrawn').map(e => e.withdrawnUuids), [[B]]);
});

test('rejected asynchronous steer withdrawal leaves it queued and emits no success event', async t => {
  const f = makeFixture(t);
  const attempt = f.kernel.cancelQueuedMessage(f.sessionId, B);
  assert.equal(f.kernelEvents.filter(e => e.type === 'held_input_withdrawn').length, 0);
  f.withdrawalAck.resolve(false);
  assert.equal(await attempt, false);
  assert.ok(f.kernel.getQueuedMessages(f.sessionId).some(row => row.uuid === B));
  assert.equal(f.kernelEvents.filter(e => e.type === 'held_input_withdrawn').length, 0);
});

test('discardPendingTurn waits for written steer acknowledgement and refuses unconfirmed discard', async t => {
  const f = makeFixture(t);
  await f.startTurn();
  let settled = false;
  const attempt = Promise.resolve(f.discard()).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false, 'discard resolved before steer cancellation was acknowledged');
  assert.equal(f.uiEvents.filter(e => e?.type === 'turn_discarded').length, 0);
  assert.equal(f.kernel.getSession(f.sessionId).isRunning, true);
  f.withdrawalAck.resolve(false);
  assert.equal(await attempt, false, 'a failed steer withdrawal must not report successful unsend');
  assert.equal(f.uiEvents.filter(e => e?.type === 'turn_discarded').length, 0);
  assert.equal(f.kernel.getSession(f.sessionId).isRunning, true);
  assert.ok(f.kernel.getQueuedMessages(f.sessionId).some(row => row.uuid === B));
});

test('assistant output while steer cancellation is pending prevents late unsend of its prompt', async t => {
  const f = makeFixture(t);
  await f.startTurn();
  const attempt = f.discard();
  f.emitBackend({ type: 'text', text: 'model already responded' });
  assert.equal(f.kernel.turnProducesOutput(f.sessionId), true);
  f.withdrawalAck.resolve(true);
  assert.equal(await attempt, false,
    'the original turn is no longer unsendable after the model has responded');
  assert.equal(f.kernel.getSession(f.sessionId).isRunning, true,
    'discard cancelled a turn whose output had already begun');
  assert.equal(f.uiEvents.filter(e => e?.type === 'turn_discarded').length, 0,
    'the renderer was falsely told to delete a prompt the model already acted on');
});

test('acknowledged asynchronous steer withdrawal allows discard and emits a precise UUID list', async t => {
  const f = makeFixture(t);
  await f.startTurn();
  let settled = false;
  const attempt = Promise.resolve(f.discard()).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  f.withdrawalAck.resolve(true);
  assert.equal(await attempt, true);
  assert.equal(f.stored.size, 0);
  const discarded = f.uiEvents.find(e => e?.type === 'turn_discarded');
  assert.ok(discarded, 'the renderer was not told about the confirmed discard');
  assert.ok(discarded.discardedUuids.includes(B));
  assert.equal(f.kernel.getSession(f.sessionId).isRunning, false);
});
