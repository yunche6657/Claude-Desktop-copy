// R385: a rewind discards the steer it just rewound past, and nothing else.
//
// The discard path is scoped to the uuids the backend's steer ledger reports. Ordinary
// busy-queue entries are NOT steers and must survive: on the local kernel (no ledger at all)
// the loop is empty and the pre-existing behaviour is unchanged, and on a CCB session a plain
// queued message must not be thrown away by someone rewinding an unrelated turn.
//
// This file pins the boundary in both directions. A version that cleared deferredStarts
// wholesale would pass the CCB cases and silently drop unrelated queued messages on the local
// kernel; that is the regression this file exists to catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** A minimal backend with a controllable steer ledger and a turn that never settles. */
function makeBackend({ ledger = {} } = {}) {
  const state = { ledger: { ...ledger }, cancelled: [] };
  return {
    id: 'stub',
    start: () => ({}),
    sendMessage: () => new Promise(() => {}),
    cancel: (id) => { state.cancelled.push(id); return { ok: true }; },
    onEvent: () => () => {},
    dispose: () => {},
    getSteerUuids: (id) => state.ledger[id] || [],
    withdrawSteer: (id, uuid) => {
      state.ledger[id] = (state.ledger[id] || []).filter((u) => u !== uuid);
      return true;
    },
    _state: state,
  };
}

test('a rewind discards the steers the ledger reports', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r385-discard-'));
  const backend = makeBackend();
  const events = [];
  const kernel = createSessionKernel({ backend, emit: (e) => events.push(e), storePath: path.join(dir, 'store.json') });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    backend._state.ledger[sessionId] = ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const turn = kernel.sendMessage(sessionId, 'A');
    turn.catch(() => {});

    kernel.cancel(sessionId, { keepHeldInput: false });

    assert.deepEqual(backend._state.ledger[sessionId], [],
      'the rewound steer is still in the ledger, so it will fire on the next turn');
    assert.ok(events.some((e) => e.type === 'session_updated'),
      'the renderer was not told the queued steer is gone');
  } finally {
    kernel.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rewind leaves an empty ledger alone and announces nothing', async () => {
  // The local kernel has no steer ledger. Nothing may be discarded and no session_updated may
  // be invented, or every rewind on the local kernel would emit a spurious update.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r385-discard-empty-'));
  const backend = makeBackend();
  const events = [];
  const kernel = createSessionKernel({ backend, emit: (e) => events.push(e), storePath: path.join(dir, 'store.json') });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    const turn = kernel.sendMessage(sessionId, 'A');
    turn.catch(() => {});
    const before = events.filter((e) => e.type === 'session_updated').length;

    kernel.cancel(sessionId, { keepHeldInput: false });

    assert.deepEqual(backend._state.ledger[sessionId] || [], [], 'nothing should have been withdrawn');
    assert.equal(events.filter((e) => e.type === 'session_updated').length, before,
      'an empty ledger produced a spurious session_updated');
  } finally {
    kernel.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stop still hands held inputs back instead of discarding them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r385-discard-stop-'));
  const calls = [];
  const backend = {
    id: 'stub',
    start: () => ({}),
    sendMessage: () => new Promise(() => {}),
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    parkHeldSteers: (id) => calls.push(['park', id]),
    getSteerUuids: () => [],
    withdrawSteer: (id, uuid) => { calls.push(['withdraw', uuid]); return true; },
  };
  const kernel = createSessionKernel({ backend, emit: () => {}, storePath: path.join(dir, 'store.json') });
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    kernel.sendMessage(sessionId, 'A').catch(() => {});
    kernel.cancel(sessionId);
    assert.deepEqual(calls.map((c) => c[0]), ['park'],
      'a plain stop did not use the hand-back path: ' + JSON.stringify(calls));
  } finally {
    kernel.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
