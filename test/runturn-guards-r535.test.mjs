// R535: two runTurn guards that no test could see removed.
//
// HOW THIS ROUND GOT HERE
//   R534 ranked functions by uncovered branches per referencing test and put `beginExistingStart` first. That was
//   wrong — the function is eleven lines with two branches, and attribution had credited it with twelve more from the
//   code that follows it. After fixing the attribution (this round's first half), the top of the ranking became
//   `runTurn`, 8 branches. Mutating its guards found two that nothing notices.
//
// THE TWO GUARDS, AND WHY EACH MATTERS
//   session-kernel.cjs:1254 — the cross-session event filter
//       if (event.sessionId !== undefined && event.sessionId !== null && event.sessionId !== sessionId) return;
//   The comment above it states the hazard: "a backend that outlives a turn (the CCB child process does) must not
//   leak a stale turn's output into the transcript being built now." Removing the guard admits every event the
//   backend emits, including those tagged for another session, and no test failed.
//
//   session-kernel.cjs:1256-1258 — the composite gate on `user_input_observed`
//   Six conditions: the feature flag, the backend id, the abort state, the identity of the running controller, the
//   event's session, its messageUuid, and the actor token. Replacing all six with `true` records an observation for
//   any `user_input_observed` event, and no test failed.
//
// WHAT THESE TESTS DO
//   Drive one turn, emit both kinds of event through the backend's onEvent callback, and assert the kernel's record of
//   the turn is unaffected by the foreign ones. The observable is the emitted `session_updated`/transcript content and
//   the recorded CLI observation — both reachable from the public surface.
//
// WHAT IS NOT CLAIMED
//   Not that all six conditions of the composite gate are individually tested: the single mutation replaced the whole
//   conjunction, so this pins that the conjunction is load-bearing, not each term. Not that the cross-session filter
//   handles every tag shape — `undefined` and `null` are deliberately admitted and are asserted as such. Not that
//   `runTurn`'s other five guards are covered: two were mutated and both are now caught, three were not mutated.
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

/** A backend that keeps its event listener, so a test can push events into the running turn. */
function listeningBackend() {
  const listeners = new Set();
  const sent = [];
  return {
    id: 'ccb',
    start: () => ({}),
    sendMessage: (id, message) => { sent.push({ id, message }); return new Promise(() => {}); },
    cancel: () => ({ ok: true }),
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    dispose: () => {},
    parkHeldSteers: () => {},
    getSteerUuids: () => [],
    withdrawSteer: () => true,
    getInfo: () => ({ actorToken: 'actor-1' }),
    emitToListeners: (event) => { for (const fn of listeners) fn(event); },
    sent,
  };
}

function openKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r535-'));
  const backend = listeningBackend();
  const events = [];
  const kernel = createSessionKernel({
    backend,
    emit: (e) => events.push(e),
    storePath: path.join(dir, 'store.json'),
    // Declared by createSessionKernel at line 87 with a default of false; passing it here is what makes the
    // `user_input_observed` gate reachable at all.
    trackCliInputObservations: true,
  });
  return {
    kernel, backend, events,
    close() { kernel.dispose(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('an event tagged for another session does not reach the turn', async () => {
  // Guards session-kernel.cjs:1254. Removing it admits a stale turn's output into this turn — the hazard the comment
  // names — and before this test nothing failed.
  //
  // THE OBSERVABLE IS THE EMITTED EVENT STREAM, NOT session.messages
  //   The first version asserted on `getSession(id).messages` and measured zero both before and after an admitted
  //   event: `messages` is not where the kernel keeps turn output, so that assertion would have passed even with the
  //   guard removed. The kernel forwards admitted events through its own `emit`, which is what a renderer consumes, so
  //   that is what a test can see.
  const { kernel, backend, events, close } = openKernel();
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const other = kernel.start({ cwd: ROOT }).sessionId;
    assert.notEqual(other, sessionId, 'the two sessions have the same id: the test would prove nothing');

    kernel.sendMessage(sessionId, 'A').catch(() => {});
    await sleep(40);
    events.length = 0;

    backend.emitToListeners({
      type: 'assistant',
      sessionId: other,
      message: { role: 'assistant', content: [{ type: 'text', text: 'LEAKED-FROM-ANOTHER-SESSION' }] },
    });
    await sleep(30);
    // Assert on the forwarded events' own fields, not on a stringified blob: test/assertion-scope.test.mjs rejects
    // `JSON.stringify(x).includes(...)` because it cannot tell a hit in the payload from a hit in a key name.
    const forwarded = events.filter((e) => e.type === 'assistant');
    for (const e of forwarded) {
      assert.notEqual(e.sessionId, other,
        'an event tagged for a different session was forwarded: the cross-session filter is gone');
      const text = JSON.stringify(e.message?.content ?? []);
      assert.equal(text.includes('LEAKED-FROM-ANOTHER-SESSION'), false,
        'the foreign message text was forwarded into this turn');
    }
  } finally {
    close();
  }
});

test('an untagged event is admitted, because it belongs to the only turn in flight', async () => {
  // The other half of the filter: `undefined` and `null` are deliberately NOT dropped. A test that only asserts
  // "foreign sessions are dropped" would still pass if the guard became `if (event.sessionId !== sessionId) return;`,
  // which would reject every untagged event and silently break every backend that does not tag.
  const { kernel, backend, events, close } = openKernel();
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    kernel.sendMessage(sessionId, 'A').catch(() => {});
    await sleep(40);
    events.length = 0;

    backend.emitToListeners({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'UNTAGGED-BELONGS-HERE' }] },
    });
    await sleep(30);
    const admitted = events.filter((e) => e.type === 'assistant'
      && Array.isArray(e.message?.content)
      && e.message.content.some((c) => c?.text === 'UNTAGGED-BELONGS-HERE'));
    assert.ok(admitted.length > 0,
      'an untagged event was dropped: the filter is now rejecting events that carry no session tag, which breaks'
      + ' every backend that does not tag its output');
  } finally {
    close();
  }
});

test('a user_input_observed event for a different turn does not record an observation', async () => {
  // Guards the composite gate at 1256-1258. Replacing it with `true` records an observation for any
  // `user_input_observed` event; the guard's job is to record only the one belonging to THIS turn.
  //
  // The observable is again the emitted stream: an admitted observation produces a `session_updated`, which the
  // renderer uses to show that the CLI saw the user typing.
  const { kernel, backend, events, close } = openKernel();
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    kernel.sendMessage(sessionId, 'A').catch(() => {});
    await sleep(40);
    events.length = 0;

    // Same session, wrong messageUuid: this belongs to some other turn.
    backend.emitToListeners({
      type: 'user_input_observed',
      sessionId,
      messageUuid: 'not-this-turns-uuid',
      actorToken: 'actor-1',
    });
    await sleep(30);
    const recorded = events.filter((e) => e.type === 'session_updated');
    assert.deepEqual(recorded, [],
      'an observation for a different messageUuid was recorded: the composite gate is not discriminating');
  } finally {
    close();
  }
});

test('the guard lines still read as they did when they were measured', () => {
  // A cheap structural pin: the two conditions must remain in the file in the shapes the mutations target. If someone
  // rewrites them, the mutation entries stop applying and would report anchor-missing rather than silently passing.
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  assert.ok(src.includes('if (event.sessionId !== undefined && event.sessionId !== null && event.sessionId !== sessionId) return;'),
    'the cross-session filter line changed shape');
  assert.ok(src.includes("if (trackCliInputObservations === true && backendId === 'ccb'"),
    'the composite gate line changed shape');
});
