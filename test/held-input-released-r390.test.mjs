// R390: promoting a held/deferred message into a turn must tell the renderer.
//
// `held_input_released` is not decoration. The store's reducer:
//
//   case"held_released": {
//     let r = t.heldInput.filter(e => !n.uuids.includes(e));
//     let i = r.length === t.heldInput.length ? t : {...t, heldInput: r.length===0?Mw:r, ...};
//     return !n.startsTurn || t.pendingTurn !== null ? i
//       : (U.reset(e), K.begin(e), W.clear(e), W.takeRevealStats(e),
//          {...i, pendingTurn:{startTime:Date.now(), armedAt:Date.now(), endTurnSeen:false,
//                              interrupting:false, responseStarted:false, rearmed:false,
//                              metaArmed:true, streamingAnchor:null}, promptSuggestion:null, ...})
//   }
//
// So it (a) drops the uuid from heldInput and (b) when startsTurn, ARMS the turn display. Without
// the event the row stays "held" forever and the turn never appears as running, even though the
// backend already has the message. `turn_started` alone does not do this: it carries no uuids.
//
// The pinned original emits it from two places — the deferred-send drain (once per batch, with
// `startsTurn` reflecting whether an idle session had to be armed) and noteCliTookInput
// (`startsTurn:false`, for a row the CLI accepted). `startsTurn` is the load-bearing field here,
// so it is asserted in both directions.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

const UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const released = (events) => events.filter((e) => e.type === 'held_input_released');

test('a queued message that becomes the turn is announced as released', async () => {
  // The path a plain session takes: a turn is running, a second message is queued behind it,
  // and the drain promotes that message into the next turn.
  const events = [];
  const firstTurn = Promise.withResolvers();
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: (_id, message) => (message === 'first'
      ? firstTurn.promise
      : Promise.resolve({ text: 'ok', stopReason: 'end_turn' })),
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    getSteerUuids: () => [],
  };
  const kernel = createSessionKernel({ backend, emit: (e) => events.push(e) });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const first = kernel.sendMessage(sessionId, 'first');
    first.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    await kernel.sendMessage(sessionId, 'queued', { deferIfBusy: true, messageUuid: UUID });
    assert.ok(kernel.getQueuedMessages(sessionId).some((row) => row.uuid === UUID),
      'the message was not queued, so nothing will be promoted');

    // Finish the first turn; the drain promotes the queued message.
    firstTurn.resolve({ text: 'ok', stopReason: 'end_turn' });
    await Promise.race([first, new Promise((r) => setTimeout(r, 2000))]);
    await new Promise((r) => setTimeout(r, 200));

    const fired = released(events);
    assert.equal(fired.length, 1, 'the promoted message was never announced as released');
    assert.deepEqual(fired[0].releasedUuids, [UUID], 'the announcement names the wrong row');
    assert.equal(fired[0].sessionId, sessionId);
    assert.ok(fired[0].session, 'the event carries no session snapshot, so heldHostRedial cannot clear');
    // The queued drain runs right after the previous turn finished, so by then nothing is
    // running: this message is what starts the turn.
    assert.equal(fired[0].startsTurn, true,
      'startsTurn is false, so the reducer will not arm the turn display');
  } finally {
    kernel.dispose();
  }
});

test('startsTurn comes from the captured value, not a hardcoded true', async () => {
  // In THIS replica both release paths require that nothing was running (drainDeferredStarts
  // returns early when pendingTurns is set; promoteHeldMessage likewise), so the field is
  // always true here. Hardcoding `true` at the emit site would therefore look harmless and
  // would survive a behavioural test — measured: mutating the field to a literal `true` stayed
  // green, because every observable release has startsTurn true.
  //
  // What is still checkable statically is that the value is threaded through from where it is
  // captured. If it stops being threaded, a future held-across-loss path would inherit `true`
  // and reset the renderer's pendingTurn under a live turn.
  const fs = await import('node:fs');
  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  const emitAt = source.indexOf("emit({ type: 'held_input_released'");
  assert.ok(emitAt > 0, 'the release emission is gone');
  const emitBlock = source.slice(emitAt, emitAt + 400);
  assert.match(emitBlock, /startsTurn: options\.heldReleaseStartsTurn === true/,
    'startsTurn no longer reads the captured value');
  const captureAt = source.indexOf('const heldReleaseStartsTurn =');
  assert.ok(captureAt > 0, 'the captured startsTurn value is gone');
  assert.match(source.slice(captureAt, captureAt + 200), /isRunning !== true/,
    'the captured value no longer means "nothing was running before this message"');
});

test('an ordinary new message announces nothing', async () => {
  // The mirror case. A plain first message is not a release: there was no held row, and the
  // renderer arms its own turn from sendMessage's reply. Emitting here would tombstone a uuid
  // the store never held and reset pendingTurn for no reason.
  const events = [];
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: 'ok', stopReason: 'end_turn' }; } }),
  });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(sessionId, 'ordinary');
    assert.equal(released(events).length, 0,
      'an ordinary message was announced as a held-input release');
  } finally {
    kernel.dispose();
  }
});

test('the announcement carries the prompt row identity the store keys on', async () => {
  // The reducer matches `n.uuids` against `heldInput`, which holds prompt uuids. If the event
  // carried anything else (a tool id, a request id) the filter would match nothing and the
  // release would be a no-op that still looks successful.
  const events = [];
  const firstTurn = Promise.withResolvers();
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: (_id, message) => (message === 'first'
      ? firstTurn.promise
      : Promise.resolve({ text: 'ok', stopReason: 'end_turn' })),
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    getSteerUuids: () => [],
  };
  const kernel = createSessionKernel({ backend, emit: (e) => events.push(e) });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const first = kernel.sendMessage(sessionId, 'first');
    first.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    await kernel.sendMessage(sessionId, 'queued', { deferIfBusy: true, messageUuid: UUID });

    // The uuid the renderer holds for that row, before it is promoted.
    const held = kernel.getQueuedMessages(sessionId).find((row) => row.uuid === UUID);
    assert.ok(held, 'the queued row is not visible');

    firstTurn.resolve({ text: 'ok', stopReason: 'end_turn' });
    await Promise.race([first, new Promise((r) => setTimeout(r, 2000))]);
    await new Promise((r) => setTimeout(r, 200));

    const fired = released(events);
    assert.equal(fired.length, 1);
    assert.deepEqual(fired[0].releasedUuids, [held.uuid],
      'the released uuid is not the uuid the store was holding');
    assert.equal(typeof fired[0].releasedUuids[0], 'string');
    assert.ok(fired[0].releasedUuids[0].length > 0);
  } finally {
    kernel.dispose();
  }
});
