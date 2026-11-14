// R386: `discardPendingTurn` was declared, called by the shipped composer, and had NO handler.
//
// The generic fallback answered `null`. The composer reads that as "not discarded" and falls
// back to a plain stop, so Escape in an empty composer never took the pending message back —
// it just stopped the turn and left the message in the conversation.
//
// Measured consumer (cc43287c9-Me-M2ucD.js):
//
//   let u = Tn.discardPendingTurn, d = jx.holdForAck(q.id, () => u(q.id));
//   SN(d, { onStopped: t => { cC({..., discarded: t}), !t && (a(), Bu(q), c(), l()); ... },
//           onFailed: ..., onRefused: ... });
//
// and ys(e,{onStopped,onFailed,onRefused}) is `e.then(onStopped).catch(...)`. So:
//   true  -> the turn was taken back, the message must not come back
//   false -> honest stop, the composer restores the text
//   throw -> refused (the renderer shows the refusal message)
//
// What each test below can and cannot prove is stated with it. The backend here never settles
// a turn, because the whole feature only exists for a turn that has not answered yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/**
 * A bridge over a backend that holds its turn open.
 *
 * `settle` decides whether the turn ever answers; by default it never does, which is the only
 * state in which "unsend" is meaningful.
 *
 * A real (stub) backend rather than createAgent: the kernel refuses both at once, and the tests
 * need a steer ledger on the backend. The local agent path has no ledger at all, and without one
 * the difference between "hand the input back" and "withdraw it" is invisible — measured:
 * mutating the discard to use the stop path stayed green until a ledger existed.
 */
function makeBridge({ settle = false } = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const release = Promise.withResolvers();
  const ledger = new Map();          // sessionId -> [uuid]
  const ledgerCalls = [];            // ['park', id] | ['withdraw', uuid]
  const listeners = new Set();
  const emitToBackend = (event) => { for (const fn of [...listeners]) fn(event); };
  const backend = {
    id: 'stub',
    start: () => ({}),
    async sendMessage(sessionId, message) {
      if (settle) return { text: 'ok', stopReason: 'end_turn' };
      await release.promise;
      return { text: 'ok', stopReason: 'end_turn' };
    },
    cancel: () => ({ ok: true }),
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    dispose: () => {},
    getSteerUuids: (id) => ledger.get(id) || [],
    withdrawSteer: (id, uuid) => {
      ledgerCalls.push(['withdraw', uuid]);
      ledger.set(id, (ledger.get(id) || []).filter((u) => u !== uuid));
      return true;
    },
    parkHeldSteers: (id) => { ledgerCalls.push(['park', id]); },
    _ledger: ledger,
    _ledgerCalls: ledgerCalls,
    _emit: emitToBackend,
  };
  const kernel = createSessionKernel({ emit: () => {}, backend });
  const sent = [];
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  registerBridgeServices({
    ipcMain,
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  });
  const channels = [...handlers.keys()];
  const invoke = async (method, ...args) => {
    const channel = channels.find((c) => c.includes('LocalSessions_$_') && c.endsWith('_$_' + method));
    if (!channel) throw new Error('no channel for ' + method);
    return handlers.get(channel)({}, ...args);
  };
  const events = () => sent.map(([, payload]) => payload).filter((p) => p && p.type);
  return { kernel, channels, invoke, events, release: () => release.resolve(), backend };
}

/** Wait until the kernel reports the session running. Returns whether it did. */
async function waitRunning(kernel, sessionId, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (kernel.getSession(sessionId)?.isRunning === true) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('discardPendingTurn refuses an unknown session instead of answering the fallback null', async () => {
  // The fallback answers null and null is falsy, which the composer reads as "honest stop".
  // A refusal has to be distinguishable, or the handler could be missing without any symptom.
  const bridge = makeBridge();
  const answer = await bridge.invoke('discardPendingTurn', 'local_does-not-exist');
  assert.notEqual(answer, null, 'the generic fallback answered: the handler is not registered');
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'unknown_session');
});

test('a turn with no response yet is taken back and announced', async () => {
  const bridge = makeBridge();
  const { sessionId } = bridge.kernel.start({ cwd: ROOT });
  const first = bridge.kernel.sendMessage(sessionId, 'unsend me');
  first.catch(() => {});
  assert.equal(await waitRunning(bridge.kernel, sessionId), true,
    'the turn never reached the running state, so this test would prove nothing');
  // Captured BEFORE the discard: the pending-turn token is what the discard clears, so reading
  // it afterwards answers undefined and the comparison would be meaningless.
  const turnUuid = bridge.kernel.getRunningTurnUuid(sessionId);
  assert.equal(typeof turnUuid, 'string', 'the running turn has no uuid to announce');

  const answer = await bridge.invoke('discardPendingTurn', sessionId);
  assert.equal(answer, true, 'an unsent turn was not taken back: ' + JSON.stringify(answer));

  // emitSessionEvent broadcasts the same payload on several channels (two namespaces, two
  // spellings) so a subscriber of either gets it. Counting deliveries would measure the fan-out,
  // not the behaviour, so the assertions below read the payload once.
  const discarded = [...new Map(
    bridge.events().filter((e) => e.type === 'turn_discarded').map((e) => [e.userMessageUuid, e]),
  ).values()];
  assert.equal(discarded.length, 1, 'the renderer was never told to drop the message');
  assert.equal(typeof discarded[0].userMessageUuid, 'string',
    'turn_discarded carries no userMessageUuid, so the renderer cannot identify the row');
  assert.ok(Array.isArray(discarded[0].discardedUuids) && discarded[0].discardedUuids.length > 0,
    'turn_discarded lists nothing to drop');
  assert.equal(discarded[0].userMessageUuid, turnUuid,
    'the announced uuid is not the turn that was taken back');

  bridge.release();
  await Promise.race([first, new Promise((r) => setTimeout(r, 2000))]);
});

test('a turn that already answered refuses to be unsent', async () => {
  // The original logs "honest stop" here: the content is already with the model.
  const bridge = makeBridge({ settle: true });
  const { sessionId } = bridge.kernel.start({ cwd: ROOT });
  await bridge.kernel.sendMessage(sessionId, 'answered');
  assert.notEqual(bridge.kernel.getSession(sessionId)?.isRunning, true);

  const answer = await bridge.invoke('discardPendingTurn', sessionId);
  assert.equal(answer, false, 'an idle session claimed its turn could be taken back');
  assert.equal(bridge.events().filter((e) => e.type === 'turn_discarded').length, 0,
    'a turn that cannot be unsent still announced a discard');
});

test('taking a turn back does not leave the prompt queued for the next turn', async () => {
  // A discard must not behave like a stop: a stop hands host-held input back so it survives.
  // If the discard reused that path, the message the user took back would fire on the next
  // turn instead of being gone.
  //
  // This needs a session that actually HOLDS something. Without a ledger both paths look the
  // same — measured: mutating keepHeldInput back to the stop default stayed green.
  const bridge = makeBridge();
  const { sessionId } = bridge.kernel.start({ cwd: ROOT });
  const held = 'hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh';
  bridge.backend._ledger.set(sessionId, [held]);

  const first = bridge.kernel.sendMessage(sessionId, 'unsend me');
  first.catch(() => {});
  assert.equal(await waitRunning(bridge.kernel, sessionId), true, 'the turn never started');

  assert.equal(await bridge.invoke('discardPendingTurn', sessionId), true);
  const calls = bridge.backend._ledgerCalls;
  assert.deepEqual(calls.filter(([what]) => what === 'park'), [],
    'the discard handed a host-held input back, so it will be sent on the next turn');
  assert.deepEqual(calls.filter(([what]) => what === 'withdraw').map(([, uuid]) => uuid), [held],
    'the discard did not withdraw the host-held input');
  assert.deepEqual(bridge.kernel.getQueuedMessages(sessionId), []);

  bridge.release();
  await Promise.race([first, new Promise((r) => setTimeout(r, 2000))]);
});

test('a turn already in flight refuses to be unsent once it has produced output', async () => {
  // Distinct from the idle case above: the session IS running, so the idle early-return does
  // not explain the refusal. Without this case, deleting the responseStarted guard stayed green
  // (measured) because every other test kept the turn silent.
  const bridge = makeBridge();
  const { sessionId } = bridge.kernel.start({ cwd: ROOT });
  const first = bridge.kernel.sendMessage(sessionId, 'half answered');
  first.catch(() => {});
  assert.equal(await waitRunning(bridge.kernel, sessionId), true, 'the turn never started');

  // Real output, through the same channel the UI consumes — not a hand-written record field.
  // An earlier version of this test set `pendingTurn.responseStarted` directly, which meant it
  // stayed green while the production guard was dead (nothing writes that field).
  assert.equal(bridge.kernel.turnProducesOutput(sessionId), false,
    'the turn claimed output before producing any, so the guard would trip for the wrong reason');
  bridge.backend._emit({ type: 'text', text: 'here is my answer' });
  const deadline = Date.now() + 2000;
  while (bridge.kernel.turnProducesOutput(sessionId) !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(bridge.kernel.turnProducesOutput(sessionId), true,
    'assistant text did not mark the turn as having produced output');

  const answer = await bridge.invoke('discardPendingTurn', sessionId);
  assert.equal(answer, false,
    'a turn that already produced output claimed it could be taken back');
  assert.equal(bridge.kernel.getSession(sessionId).isRunning, true,
    'the running turn was stopped even though its content is already with the model');

  bridge.release();
  await Promise.race([first, new Promise((r) => setTimeout(r, 2000))]);
});

test('a tool call also makes the turn unsendable', async () => {
  // The model acting on the prompt is the same threshold as answering it. Pinned separately
  // because the two marks are written in different branches.
  const bridge = makeBridge();
  const { sessionId } = bridge.kernel.start({ cwd: ROOT });
  const first = bridge.kernel.sendMessage(sessionId, 'use a tool');
  first.catch(() => {});
  assert.equal(await waitRunning(bridge.kernel, sessionId), true, 'the turn never started');

  bridge.backend._emit({ type: 'tool_request', id: 't1', name: 'Read', input: {} });
  const deadline = Date.now() + 2000;
  while (bridge.kernel.turnProducesOutput(sessionId) !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(bridge.kernel.turnProducesOutput(sessionId), true,
    'a tool call did not mark the turn as having produced output');
  assert.equal(await bridge.invoke('discardPendingTurn', sessionId), false);

  bridge.release();
  await Promise.race([first, new Promise((r) => setTimeout(r, 2000))]);
});

test('discardPendingTurn withdraws ordinary queued UUIDs that it reports as discarded', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.release());
  const { sessionId } = bridge.kernel.start({ cwd: ROOT });
  const first = bridge.kernel.sendMessage(sessionId, 'active');
  first.catch(() => {});
  assert.equal(await waitRunning(bridge.kernel, sessionId), true, 'the first turn was never active');

  const queuedUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  await bridge.kernel.sendMessage(sessionId, 'queued person message', {
    messageUuid: queuedUuid, deferIfBusy: true, plainInput: true,
  });
  assert.ok(bridge.kernel.getQueuedMessages(sessionId).some((row) => row.uuid === queuedUuid),
    'the test never established an ordinary host-held input');

  assert.equal(await bridge.invoke('discardPendingTurn', sessionId), true);
  const discarded = bridge.events().find((e) => e.type === 'turn_discarded' &&
    e.discardedUuids?.includes(queuedUuid));
  assert.ok(discarded, 'the renderer was not told that the queued UUID was discarded');
  assert.ok(!bridge.kernel.getQueuedMessages(sessionId).some((row) => row.uuid === queuedUuid),
    'a UUID announced as discarded is still queued and can be sent on the next turn');

  bridge.release();
  await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 2000))]);
});