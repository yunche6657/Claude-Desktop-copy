// R533: condition coverage — of the branches that contain an effect mutation, is the CONDITION itself tested?
//
// R532 counted 367 branches and found five containing an effect anchor. That was explicitly an effect-coverage figure,
// not condition coverage, and it left the sharper question open: change the guard and does anything notice?
//
// THE SEVEN CONDITION MUTATIONS AND WHAT THEY FOUND
//   cond-cancel-park-true        caught   the branch runs on a rewind too
//   cond-cancel-park-false       caught   the branch never runs
//   cond-discarded-true          caught   an empty ledger now goes through the withdrawal path
//   cond-visibility-true         caught   the branch runs when it should not
//   cond-visibility-false        caught   the branch never runs
//   cond-cancel-withdraw-true    UNPROTECTED
//   cond-cancel-pending-started  UNPROTECTED
//
//   So three of the five effect-covered branches also have a tested condition. The other two needed looking at, and
//   looking at them produced two different answers.
//
// THE FIRST "UNPROTECTED" IS REAL AND NARROW — cancel-withdraw
//   Widening `if (backend && !keepHeldInput)` to `if (true)` changes ONE thing a test could see: a plain stop now
//   consults the steer ledger. Inside the branch, `if (discarded.length)` then refuses to do anything when the ledger
//   is empty, so the widened branch is otherwise a no-op — which is why the existing tests stayed green.
//
//   Measured with a probe that records backend calls:
//       plain stop (keepHeldInput defaults true) -> ["parkHeldSteers"]      getSteerUuids NOT called
//       rewind     (keepHeldInput = false)        -> ["getSteerUuids"]
//   That difference is observable, so the mutation was not a no-op; nothing was asserting it. The test below asserts
//   it, and the mutation becomes caught.
//
// THE SECOND "UNPROTECTED" IS NOT A COVERAGE GAP — cancel-pending-started
//   `if (pending && !pending.started)` widened to `if (pending)` runs the same body whenever a pending turn exists.
//   R530 measured that the body's only lasting effect — `pending.cancelled = true` — is unobservable, because the very
//   next line deletes the map entry and the only reader (`unstartedTurn`) reads through that map. So widening this
//   guard cannot change anything a test could detect: the assignment it now makes in extra cases is one nothing reads.
//
//   That is "no test could catch it", which is a different statement from "no test does". It stays UNPROTECTED in the
//   table and is explained here rather than papered over with a test that would assert the absence of a non-effect.
//
// WHAT IS NOT CLAIMED
//   Not that condition coverage is complete: seven guards were mutated, and 367 branches exist. Not that a caught
//   condition means every path through the body is tested — only that the guard's two outcomes are distinguished.
//   Not that `parkHeldSteers`/`getSteerUuids` are the only observables; they are the two this branch touches.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Record every backend call cancel() makes, so a widened branch is visible as an extra call. */
async function cancelCalls(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r533-'));
  const calls = [];
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: () => new Promise(() => {}),
    cancel: () => { calls.push('cancel'); return { ok: true }; },
    onEvent: () => () => {},
    dispose: () => {},
    parkHeldSteers: () => calls.push('parkHeldSteers'),
    getSteerUuids: () => { calls.push('getSteerUuids'); return []; },
    withdrawSteer: () => { calls.push('withdrawSteer'); return true; },
  };
  const kernel = createSessionKernel({ backend, emit: () => {}, storePath: path.join(dir, 'store.json') });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    kernel.sendMessage(sessionId, 'A').catch(() => {});
    await sleep(40);
    kernel.cancel(sessionId, options);
    await sleep(20);
    return calls;
  } finally {
    kernel.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a plain stop does not consult the steer ledger', async () => {
  // Guards the negative half of `if (backend && !keepHeldInput)`. Widening that guard to `if (true)` makes this call
  // happen, and nothing was asserting that it did not.
  const calls = await cancelCalls(undefined);
  assert.equal(calls.includes('getSteerUuids'), false,
    'a plain stop called getSteerUuids: the keepHeldInput guard is not distinguishing the two paths. Calls: '
    + JSON.stringify(calls));
  assert.equal(calls.includes('parkHeldSteers'), true,
    'a plain stop did not hand held inputs back: the other guard is broken. Calls: ' + JSON.stringify(calls));
});

test('a rewind consults the ledger and does not hand back', async () => {
  // The positive half, so the two paths are pinned from both sides rather than only one.
  const calls = await cancelCalls({ keepHeldInput: false });
  assert.equal(calls.includes('getSteerUuids'), true,
    'a rewind did not consult the ledger: it cannot know what to withdraw. Calls: ' + JSON.stringify(calls));
  assert.equal(calls.includes('parkHeldSteers'), false,
    'a rewind handed held inputs back: that is the redelivery the R385 work removed. Calls: ' + JSON.stringify(calls));
});

test('the condition mutation table exists and every entry names a real file', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'branch-mutation.cjs'), 'utf8');
  assert.match(src, /const CONDITION_MUTATIONS = \[/, 'the condition table is gone');
  const block = src.slice(src.indexOf('const CONDITION_MUTATIONS = ['), src.lastIndexOf('];'));
  const files = [...block.matchAll(/'test\/[^']+\.test\.mjs'/g)].map((m) => m[0].slice(1, -1));
  assert.ok(files.length > 0, 'no test files named');
  for (const f of new Set(files)) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} does not exist`);
  }
  // Seven entries: five guards, two of them tested in both directions.
  const ids = [...block.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  // Ten entries: five guards (two tested in both directions) plus three runTurn guards added in R535. The count is
  // pinned so a silently-dropped entry is noticed; it is expected to change when a round adds one.
  assert.equal(ids.length, 10, `expected 10 condition mutations, found ${ids.length}: ` + ids.join(', '));
});

test('the unobservable guard is explained rather than papered over', () => {
  // `cond-cancel-pending-started` cannot be caught, and the reason is a property of the code measured in R530.
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'branch-mutation.cjs'), 'utf8');
  assert.match(src, /if \(pending && !pending.started\) -> taken whenever a pending turn exists/,
    'the unobservable entry is no longer labelled');
  // And the property it depends on must still hold: the map entry is deleted right after the flag is written.
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  const at = kernel.indexOf('if (pending && !pending.started) {');
  assert.match(kernel.slice(at, at + 400), /pendingTurns\.delete\(sessionId\)/,
    'the deletion that makes the flag unobservable is gone: this explanation needs revisiting');
});
