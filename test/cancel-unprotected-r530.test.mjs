// R530: three cancel() decisions whose removal no test noticed. Each test below is written to fail when its
// decision is deleted, and that was confirmed by mutation before the test was kept.
//
// WHAT branch-mutation SHOWED
//   tools/branch-mutation.cjs mutates one decision at a time and runs the tests expected to notice. After fixing the
//   test list — the first run guessed `session-reveal-and-warm.test.mjs` for every visibility mutation, and that file
//   never mentions the symbols, producing four false "unprotected" verdicts — the honest result was:
//
//       cancel-park                    caught        the R527 hand-back
//       cancel-withdraw                caught        rewind withdrawal
//       visibility-arm                 caught        setVisibility calling the lifecycle
//       visibility-warm                caught        scheduling a warm
//       visibility-wasvisible-default  caught        unknown-session default
//       cancel-pending-cancel          UNPROTECTED
//       cancel-abort                   UNPROTECTED
//       cancel-no-running-turn         UNPROTECTED
//
//   `cancel-approvals` was skipped: no test file mentions `resolveAllApprovals` at all, so it needs the whole suite and
//   was left for a separate run rather than folded in silently.
//
// THE THREE GAPS, AND WHY EACH IS REAL RATHER THAN COSMETIC
//   cancel-abort         `controller.abort()` is what unblocks the turn's await. Everything after it — backend.cancel,
//                        record(isRunning:false), running.delete — still runs, so a test that only checks the
//                        post-teardown state cannot tell aborted from not-aborted. The observable difference is that
//                        the controller's signal fires.
//   cancel-pending-cancel  a turn that has not started yet must be marked so its queued action refuses to run. The
//                        marking is read by the queued closure (`token.cancelled`), so the observable difference is
//                        whether the queued action returns `{ok:false}`.
//   cancel-no-running-turn  cancelling with no controller must report `{ok:false, reason:'no running turn'}`. Changing
//                        it to `{ok:true}` tells the UI a turn was stopped when none existed.
//
// WHAT THESE TESTS DO NOT CLAIM
//   Not that cancel() is fully covered: the mutation table has nine entries, `cancel-approvals` has never been run
//   suite-wide, and decisions outside the table are unexamined. Not that these three are the only gaps — they are the
//   three the table found.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** A backend whose turn never settles, so cancel() has a controller to act on. */
function makeBackend({ steerUuids = [] } = {}) {
  const state = { cancelled: [], ledger: { } };
  return {
    id: 'stub',
    start: () => ({}),
    sendMessage: () => new Promise(() => {}),
    cancel: (id) => { state.cancelled.push(id); return { ok: true }; },
    onEvent: () => () => {},
    dispose: () => {},
    parkHeldSteers: () => {},
    getSteerUuids: (id) => state.ledger[id] || steerUuids,
    withdrawSteer: (id, uuid) => {
      state.ledger[id] = (state.ledger[id] || []).filter((u) => u !== uuid);
      return true;
    },
    _state: state,
  };
}

function withKernel(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r530-'));
  const backend = makeBackend();
  const kernel = createSessionKernel({ backend, emit: () => {}, storePath: path.join(dir, 'store.json') });
  try {
    return fn({ kernel, backend, dir });
  } finally {
    kernel.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('cancel with no running turn refuses, rather than reporting success', () => {
  // Guards the `if (!controller) return { ok: false, reason: 'no running turn' }` line. Mutating it to `ok: true`
  // made every named test pass, because nothing asked what cancel returns when there is nothing to cancel.
  withKernel(({ kernel }) => {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const r = kernel.cancel(sessionId);
    assert.equal(r.ok, false, 'cancel reported success with no turn running: ' + JSON.stringify(r));
    assert.equal(r.reason, 'no running turn', 'the refusal no longer says why: ' + JSON.stringify(r));
  });
});

test('cancel aborts the controller signal the backend was handed', async () => {
  // Guards `controller.abort()`. Everything after that line still runs — backend.cancel, record(isRunning:false),
  // running.delete — so post-teardown state cannot distinguish aborted from not-aborted, which is why the first
  // attempt at this test did not discriminate.
  //
  // The kernel passes `signal: controller.signal` into backend.sendMessage (session-kernel.cjs, the runMessage call
  // site). That signal is the only observable that changes exactly when abort() runs, so the test captures it and
  // asserts its state after cancel.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r530-abort-'));
  let captured = null;
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: (id, message, options) => {
      captured = options && options.signal ? options.signal : null;
      return new Promise(() => {});
    },
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    parkHeldSteers: () => {},
    getSteerUuids: () => [],
    withdrawSteer: () => true,
  };
  const kernel = createSessionKernel({ backend, emit: () => {}, storePath: path.join(dir, 'store.json') });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    kernel.sendMessage(sessionId, 'A').catch(() => {});
    // The turn must actually start; the `!pending.started` early return skips abort entirely.
    for (let i = 0; i < 50 && !captured; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(captured, 'the backend never received a signal: the turn did not start, so abort cannot be observed');
    assert.equal(captured.aborted, false, 'the signal was already aborted before cancel');

    kernel.cancel(sessionId);
    assert.equal(captured.aborted, true,
      'cancel() did not abort the signal the backend was given: controller.abort() is missing or unreachable');
  } finally {
    kernel.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a queued turn that is cancelled before starting never reaches the backend', async () => {
  // Guards `pending.cancelled = true;` in the `!pending.started` branch. The flag is read by the queued closure, so
  // the observable difference is whether that closure proceeds at all.
  //
  // TWO EARLIER VERSIONS WERE WRONG, IN DIFFERENT WAYS
  //   1. `await first` hung for 60s. `sendMessage` returns `Promise.race([queued, cancelled])`; on the not-started
  //      path `cancelled` resolves and `queued` never does, so the first promise never settles.
  //   2. Asserting that a fresh send afterwards reaches the backend failed. It does not: `modelTurnQueues` still
  //      holds the tail of the first (unsettled) action, so the queue stays blocked by design. That is a property of
  //      the queue, not of `pending.cancelled`, and testing it here was measuring something else.
  //
  //   What survives is the claim the mutation actually changes: the cancelled-before-start turn must not be handed to
  //   the backend.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r530-pending-'));
  let backendSends = 0;
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: () => { backendSends += 1; return new Promise(() => {}); },
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    parkHeldSteers: () => {},
    getSteerUuids: () => [],
    withdrawSteer: () => true,
  };
  const kernel = createSessionKernel({ backend, emit: () => {}, storePath: path.join(dir, 'store.json') });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const first = kernel.sendMessage(sessionId, 'A');
    first.catch(() => {}); // never awaited: it only settles when the still-pending turn settles

    const r = kernel.cancel(sessionId);
    assert.equal(r.ok, true, 'cancelling a queued turn did not report success: ' + JSON.stringify(r));

    const observed = backendSends;
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(backendSends, observed,
      'the cancelled-before-start turn still reached the backend: pending.cancelled was not honoured');
  } finally {
    kernel.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// THE RECURSION THAT HAD TO GO
//   A fourth test here re-ran `branch-mutation.cjs --only <id>` and asserted `caught`. That is the right check but the
//   wrong place: `branch-mutation` runs these very tests while a mutation is applied, so the check would launch a
//   second mutation of the same file from inside the first, against an already-mutated source. It reported
//   `unprotected` for `cancel-abort` while a standalone probe showed the signal IS aborted — the recursion, not the
//   code, produced that verdict.
//
//   The discrimination check belongs in tools/branch-mutation.cjs's own output, run deliberately, not inside the tests
//   it is measuring. Verified separately: `node tools/branch-mutation.cjs --skip cancel-approvals` now reports
//   `caught` for all three.
