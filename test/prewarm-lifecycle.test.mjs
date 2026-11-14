// The prewarm lifecycle, end to end, against a REAL session kernel (no Electron, no model).
//
// Last round added the prewarm handlers but only verified them by reading the source and
// watching the log go quiet. That is not the same as verifying the flow: the composer calls
// prewarmLocal, then start({ sessionId }) with the id it got back, and expects the SAME
// session. If start() ignored the requested id, the route and the kernel would disagree about
// which session is open — which is a bug this project has already had once.
//
// These tests drive the kernel directly; the bridge handlers are thin wrappers over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function makeKernel() {
  return createSessionKernel({
    emit: () => {},
    // No model call is made by start/getSession/discard, so a stub runner is enough.
    createAgent: () => ({ model: 'stub', run: async () => ({ text: '', stopReason: 'end_turn' }) }),
  });
}

test('start() adopts the prewarmed session id instead of inventing one', () => {
  const kernel = makeKernel();
  const prewarmedId = 'local_prewarmed-abc';
  const session = kernel.start({ sessionId: prewarmedId, cwd: 'C:\\work' });
  assert.equal(session.sessionId, prewarmedId, 'the route already shows this id; a new one splits them');
  assert.equal(kernel.getSession(prewarmedId).sessionId, prewarmedId);
});

test('a prewarmed session is readable before the first turn', () => {
  // The composer reads it while the user is still typing, so it must exist as a record, not
  // only as a promise.
  const kernel = makeKernel();
  const session = kernel.start({ sessionId: 'local_pre-1', cwd: 'C:\\work' });
  assert.equal(session.isRunning, false);
  assert.equal(kernel.getTranscript('local_pre-1').length, 0, 'no turns yet, but a valid transcript');
  assert.ok(kernel.getAll().some((entry) => entry.sessionId === 'local_pre-1'));
});

test('discarding a prewarmed session removes it from the list', () => {
  // An unsent prewarmed session must not linger in the sidebar; the composer discards it
  // whenever the draft changes.
  const kernel = makeKernel();
  kernel.start({ sessionId: 'local_pre-2', cwd: 'C:\\work' });
  assert.ok(kernel.getAll().some((entry) => entry.sessionId === 'local_pre-2'));
  kernel.remove('local_pre-2');
  assert.equal(kernel.getSession('local_pre-2'), null);
  assert.equal(kernel.getAll().some((entry) => entry.sessionId === 'local_pre-2'), false);
});

test('discarding an unknown id is a no-op, not a throw', () => {
  // discardPrewarm races with start(): the composer may discard an id that was never created.
  const kernel = makeKernel();
  assert.doesNotThrow(() => kernel.remove('local_never-existed'));
});

test('two prewarms get distinct ids', () => {
  const kernel = makeKernel();
  const a = kernel.start({ cwd: 'C:\\work' });
  const b = kernel.start({ cwd: 'C:\\work' });
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(kernel.getAll().length, 2);
});
