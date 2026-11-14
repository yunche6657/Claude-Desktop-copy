// R389: taking a queued message back must tell the renderer, not just the caller.
//
// `cancelQueuedMessage` has three withdrawal paths — a backend steer, an unstarted turn, and a
// deferred/held queue entry. Every one of them used to return `true` and emit nothing. The
// conversation is not driven by that return value; it is driven by the event:
//
//   main:      emit({type:'held_input_withdrawn', withdrawnUuids:[uuid], session})
//   transport: case"held_input_withdrawn": t({kind:"held_withdrawn", uuids:r.withdrawnUuids??[]})
//   store:     case"held_withdrawn": return KE(t,e,n.uuids)
//              KE -> tombstones those uuids, drops them from heldInput/queuedSteered/
//                    queuedDeferred, then messages.replaceAll(...) to rebuild the conversation
//
// So without the event the row stays in the UI after the user took it back. The pinned original
// emits it from three separate withdrawal paths, all carrying `withdrawnUuids`.
//
// Each test below names which path it covers, so a future edit that keeps only one of the three
// emissions fails here instead of shipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

const UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Collect the withdrawal announcements from a kernel. */
function withdrawnEvents(events) {
  return events.filter((e) => e.type === 'held_input_withdrawn');
}

test('withdrawing a backend steer announces the withdrawal', async () => {
  // Path 1: the steer lives in the backend's ledger (CCB nativeCycle). The ledger reports the
  // uuid, so this branch is taken before any queue is consulted.
  const ledger = new Set([UUID]);
  const events = [];
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: () => new Promise(() => {}),
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    getSteerUuids: () => [...ledger],
    withdrawSteer: (id, uuid) => { ledger.delete(uuid); return true; },
  };
  const kernel = createSessionKernel({ backend, emit: (e) => events.push(e) });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    assert.equal(kernel.cancelQueuedMessage(sessionId, UUID), true);

    const fired = withdrawnEvents(events);
    assert.equal(fired.length, 1, 'no withdrawal was announced, so the row stays in the UI');
    assert.deepEqual(fired[0].withdrawnUuids, [UUID]);
    assert.equal(fired[0].sessionId, sessionId);
    // The store's reducer also clears heldHostRedial/heldLostNotice off the payload, so the
    // session snapshot has to travel with the event.
    assert.ok(fired[0].session, 'the event carries no session snapshot');
  } finally {
    kernel.dispose();
  }
});

test('a refused backend withdrawal announces nothing', async () => {
  // The mirror case: the backend says no (too late, already written). Claiming a withdrawal
  // here would tombstone a message that is still live.
  const events = [];
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: () => new Promise(() => {}),
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    getSteerUuids: () => [UUID],
    withdrawSteer: () => false,
  };
  const kernel = createSessionKernel({ backend, emit: (e) => events.push(e) });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    assert.equal(kernel.cancelQueuedMessage(sessionId, UUID), false);
    assert.equal(withdrawnEvents(events).length, 0,
      'a refused withdrawal still announced one, which would hide a live message');
  } finally {
    kernel.dispose();
  }
});

test('withdrawing a deferred queue entry announces the withdrawal', async () => {
  // Path 3: the message is in deferredStarts (queued behind a running turn). This is the path a
  // plain local session reaches.
  const events = [];
  const release = Promise.withResolvers();
  const backend = {
    id: 'stub',
    start: () => ({}),
    async sendMessage() { await release.promise; return { text: 'ok', stopReason: 'end_turn' }; },
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    getSteerUuids: () => [],
  };
  const kernel = createSessionKernel({ backend, emit: (e) => events.push(e) });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    // Start a turn, then queue a second message behind it.
    const first = kernel.sendMessage(sessionId, 'running');
    first.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    await kernel.sendMessage(sessionId, 'queued', { deferIfBusy: true, messageUuid: UUID });

    assert.ok(kernel.getQueuedMessages(sessionId).some((row) => row.uuid === UUID),
      'the second message is not queued, so this test would prove nothing');

    assert.equal(kernel.cancelQueuedMessage(sessionId, UUID), true);
    const fired = withdrawnEvents(events);
    assert.equal(fired.length, 1, 'the queued row was withdrawn silently');
    assert.deepEqual(fired[0].withdrawnUuids, [UUID]);

    release.resolve();
    await Promise.race([first, new Promise((r) => setTimeout(r, 1000))]);
  } finally {
    kernel.dispose();
  }
});

test('a withdrawn row is gone and named exactly once', async () => {
  // This replaces an earlier version that branched on the return value and silently took the
  // "not cancellable" path — measured: `cancelQueuedMessage` returned false, so the assertion
  // inside that branch never ran and the test proved nothing.
  const events = [];
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: () => new Promise(() => {}),
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    getSteerUuids: () => [],
  };
  const kernel = createSessionKernel({ backend, emit: (e) => events.push(e) });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const first = kernel.sendMessage(sessionId, 'occupied');
    first.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    // Queued behind the running turn, then withdrawn. `cancelQueuedMessage` must SAY YES here,
    // otherwise this test is not exercising a withdrawal at all.
    await kernel.sendMessage(sessionId, 'take me back', { deferIfBusy: true, messageUuid: UUID });
    assert.ok(kernel.getQueuedMessages(sessionId).some((row) => row.uuid === UUID),
      'the message was not queued, so there is nothing to withdraw');
    assert.equal(kernel.cancelQueuedMessage(sessionId, UUID), true,
      'the queued message was not cancellable; this test would prove nothing');

    assert.ok(kernel.getQueuedMessages(sessionId).every((row) => row.uuid !== UUID),
      'the withdrawn row is still listed as queued');
    const fired = withdrawnEvents(events);
    assert.equal(fired.length, 1, 'the withdrawal was not announced');
    assert.deepEqual(fired[0].withdrawnUuids, [UUID]);
  } finally {
    kernel.dispose();
  }
});

test('an unknown uuid announces nothing', async () => {
  const events = [];
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    assert.equal(kernel.cancelQueuedMessage(sessionId, 'no-such-uuid'), false);
    assert.equal(withdrawnEvents(events).length, 0);
  } finally {
    kernel.dispose();
  }
});
