// R392: a stop that withdraws a steer must say WHICH rows it dropped, not only that it ended.
//
// The pinned original's `close` carries `withdrawnUuids`, and the transport chooses its branch
// from it:
//
//   case"close": t(r.withdrawnUuids?.length
//     ? {kind:"done", withdrawn:r.withdrawnUuids, ...r.lostUuids?.length&&{lost:r.lostUuids}}
//     : r.interruptQueued ? {kind:"done", settleOnly:!0}
//     : {kind:"done", dropUnconfirmedEchoes:!0}); break;
//
// and the store's withdrawn branch feeds those uuids to KE, the reducer that tombstones rows:
//
//   case"done": if (n.settleOnly || n.withdrawn) return i=!0, U.reset(e), K.reset(e), W.clear(e),
//     IC(e), KE({...t, ...UE}, e, n.withdrawn ?? Mw);
//
// R385 already parked steers on stop; R386 already withdraws them on rewind. Neither reported the
// uuids, so the transport always took the plain `done` branch and a row the backend no longer had
// stayed visible as pending.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

const UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const closes = (events) => events.filter((e) => e.type === 'close');

/**
 * What the transport will actually do with this close payload.
 *
 *   case"close": t(r.withdrawnUuids?.length ? {kind:"done", withdrawn:...} : ...)
 *
 * So the load-bearing question is `withdrawnUuids?.length`, not "is the field present". An
 * empty array and an absent field take the SAME branch — measured: asserting
 * `=== undefined` let `withdrawnUuids = []` survive, and asserting `Array.isArray` would let the
 * absent case through. Both halves are checked through this one predicate.
 */
const transportBranch = (payload) => (payload?.withdrawnUuids?.length ? 'withdrawn' : 'plain');

/** A backend that holds one steer in its ledger and never settles a turn. */
function makeHeldSteerKernel({ steerUuid = UUID } = {}) {
  const events = [];
  const ledger = new Set([steerUuid]);
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: () => new Promise(() => {}),
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    getSteerUuids: () => [...ledger],
    withdrawSteer: (id, uuid) => { ledger.delete(uuid); return true; },
    parkHeldSteers: () => {},
  };
  const kernel = createSessionKernel({ backend, emit: (e) => events.push(e) });
  return { kernel, events, backend, ledger };
}

test('a discard-style stop reports the rows it withdrew', async () => {
  // keepHeldInput:false is the rewind/discard path — it withdraws rather than hands back.
  const { kernel, events } = makeHeldSteerKernel();
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const turn = kernel.sendMessage(sessionId, 'running');
    turn.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    kernel.cancel(sessionId, { keepHeldInput: false });

    const fired = closes(events);
    assert.equal(fired.length, 1, 'the stop did not emit one close');
    assert.deepEqual(fired[0].withdrawnUuids, [UUID],
      'close does not name the withdrawn row, so the transport takes the plain done branch');
    assert.equal(transportBranch(fired[0]), 'withdrawn',
      'the transport would take the plain done branch for this close');
    // The store spreads the session snapshot on this path too.
    assert.ok(fired[0].session, 'close carries no session snapshot');
  } finally {
    kernel.dispose();
  }
});

test('an ordinary stop reports no withdrawn rows', async () => {
  // keepHeldInput:true hands the steer back so it survives the stop. Reporting it as withdrawn
  // would tombstone a message that is still going to be sent.
  const { kernel, events } = makeHeldSteerKernel();
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const turn = kernel.sendMessage(sessionId, 'running');
    turn.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    kernel.cancel(sessionId);

    const fired = closes(events);
    assert.equal(fired.length, 1);
    assert.equal(transportBranch(fired[0]), 'plain',
      'an ordinary stop claimed a withdrawal, so a still-parked steer would be tombstoned');
  } finally {
    kernel.dispose();
  }
});

test('nothing is reported when there was nothing to withdraw', async () => {
  // No steer ledger at all — the local kernel. `withdrawnUuids` must stay absent so the
  // transport keeps the plain `done` branch instead of running KE over an empty set.
  const events = [];
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: () => ({ model: 'm', tools: [], async run() { return new Promise(() => {}); } }),
  });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const turn = kernel.sendMessage(sessionId, 'running');
    turn.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    kernel.cancel(sessionId, { keepHeldInput: false });

    const fired = closes(events);
    assert.equal(fired.length, 1);
    assert.equal(transportBranch(fired[0]), 'plain',
      'a stop with nothing withdrawn reported a withdrawal');
  } finally {
    kernel.dispose();
  }
});

test('the reported uuid is the one the ledger actually dropped', async () => {
  // Two steers, one withdrawn: the payload must name exactly the dropped one. Reporting the
  // whole ledger would tombstone a row that is still live.
  const KEPT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const events = [];
  const ledger = new Set([UUID, KEPT]);
  const dropped = [];
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: () => new Promise(() => {}),
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    getSteerUuids: () => [...ledger],
    withdrawSteer: (_id, uuid) => { dropped.push(uuid); ledger.delete(uuid); return true; },
    parkHeldSteers: () => {},
  };
  const kernel = createSessionKernel({ backend, emit: (e) => events.push(e) });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const turn = kernel.sendMessage(sessionId, 'running');
    turn.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    kernel.cancel(sessionId, { keepHeldInput: false });

    const fired = closes(events);
    assert.equal(fired.length, 1);
    // Both were in the ledger, so both are reported — and both must actually be gone from it.
    assert.equal(transportBranch(fired[0]), 'withdrawn',
      'the transport would not run the withdrawn branch for this close');
    assert.deepEqual([...fired[0].withdrawnUuids].sort(), [UUID, KEPT].sort(),
      'the reported set does not match the ledger that was withdrawn');
    assert.deepEqual(dropped.sort(), [UUID, KEPT].sort(),
      'the reported uuids were not the ones actually withdrawn');
    assert.equal(ledger.size, 0, 'the ledger still holds rows that were reported as withdrawn');
  } finally {
    kernel.dispose();
  }
});
