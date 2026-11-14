// One turn per session at a time, and the session must never get stuck in that state.
//
// Measured this round:
//   three concurrent sends  -> fulfilled, rejected, rejected
//   rejection message       -> "a turn is already running for this session"
//   agent ran               1 time, transcript has 2 rows (user + assistant)
//
//   sequential send after completion -> ok
//   send after cancel                -> ok
//
// The UI makes the concurrent case unreachable in practice: while a turn runs the send
// button is REMOVED from the DOM (measured sendVisible=null, not merely hidden) and the stop
// button takes its place. So the kernel guard is a backstop for programmatic callers, and
// the interesting risk is the opposite one — that a finished or cancelled turn leaves
// isRunning stuck and blocks every later message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** A kernel whose agent takes a moment, so a second send lands mid-turn. */
function slowKernel(delayMs = 100) {
  return createSessionKernel({
    emit: () => {},
    log: () => {},
    createAgent: () => ({
      model: 'stub',
      tools: [],
      async run() {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { text: 'ok' };
      },
    }),
  });
}

test('a second send during a turn is refused with a clear reason', async () => {
  const kernel = slowKernel();
  const session = kernel.start({ cwd: ROOT });
  const results = await Promise.allSettled([
    kernel.sendMessage(session.sessionId, 'first'),
    kernel.sendMessage(session.sessionId, 'second'),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /already running/i,
    'the refusal does not explain itself');
});

test('the refused message does not reach the transcript', async () => {
  // A half-accepted message would appear in the conversation but never be answered.
  const kernel = slowKernel();
  const session = kernel.start({ cwd: ROOT });
  await Promise.allSettled([
    kernel.sendMessage(session.sessionId, 'accepted-one'),
    kernel.sendMessage(session.sessionId, 'refused-one'),
  ]);
  const text = JSON.stringify(kernel.getTranscript(session.sessionId));
  assert.ok(text.includes('accepted-one'), 'the accepted message is missing');
  assert.equal(text.includes('refused-one'), false, 'the refused message was recorded anyway');
});

test('a later send works once the first turn finished', async () => {
  // The failure this guards: isRunning left true after completion, which would block the
  // session forever with "a turn is already running".
  const kernel = slowKernel(60);
  const session = kernel.start({ cwd: ROOT });
  await kernel.sendMessage(session.sessionId, 'first');
  await kernel.sendMessage(session.sessionId, 'second');
  const rows = kernel.getTranscript(session.sessionId);
  assert.ok(rows.length >= 4, 'the second turn produced no transcript rows');
});

test('cancel clears isRunning so the session is usable again', async () => {
  // The failure this guards: isRunning stuck true after cancel, which blocks every later
  // message with "a turn is already running". Verified directly on the flag rather than by
  // racing a second send — the send path legitimately waits for the cancelled turn's own
  // promise, which is the agent's timer, not the kernel's state.
  const kernel = slowKernel(3000);
  const session = kernel.start({ cwd: ROOT });
  // Measured: cancel returns in 1 ms and isRunning is false within 200 ms. The test must not
  // wait on the cancelled turn's own promise — that settles only when the stub agent's 5 s
  // timer would have fired, which made this test take 5 s for no extra coverage.
  kernel.sendMessage(session.sessionId, 'will-be-cancelled').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(kernel.cancel(session.sessionId), { ok: true }, 'cancel did not report success');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(kernel.getSession(session.sessionId).isRunning, false,
    'isRunning stayed true after cancel, so no later message could run');
});

test('two different sessions run independently', async () => {
  // The guard is per session; a busy session must not block a quiet one.
  const kernel = slowKernel(120);
  const first = kernel.start({ cwd: ROOT });
  const second = kernel.start({ cwd: ROOT });
  await Promise.all([
    kernel.sendMessage(first.sessionId, 'in-first'),
    kernel.sendMessage(second.sessionId, 'in-second'),
  ]);
  assert.ok(JSON.stringify(kernel.getTranscript(first.sessionId)).includes('in-first'));
  assert.ok(JSON.stringify(kernel.getTranscript(second.sessionId)).includes('in-second'));
});
