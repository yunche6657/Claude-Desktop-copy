// Conversation history must survive a restart, and the model must see it next turn.
//
// Measured live this round against the real gateway (deepseek-v4.1-flash):
//
//   turn 1: 'Remember this number: 4711. Reply with just OK.'   -> 'OK'
//   turn 2: 'What number did I ask you to remember?'           -> '4711'
//
//   session id before restart: local_d0bf36ee-7685-471d-9efd-7a71cda2cf2d
//   session id after  restart: local_d0bf36ee-7685-471d-9efd-7a71cda2cf2d
//   transcript rows: 4 both times; '4711' and 'OK' both still present
//
// The second turn is the real test of turn one: a shell that only appends to a local array
// would also answer 'OK', but it could not answer '4711' unless the prior turn was actually
// fed back into the request. And the restart proves the answer came from storage, not from
// a process that happened to still be warm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** A kernel whose agent records the messages it was handed on each turn. */
function makeKernel(storePath) {
  const seen = [];
  const kernel = createSessionKernel({
    emit: () => {},
    log: () => {},
    ...(storePath ? { storePath } : {}),
    createAgent: () => ({
      model: 'stub',
      tools: [],
      async run(opts) {
        seen.push(JSON.parse(JSON.stringify(opts.messages || [])));
        return { text: 'ok', stopReason: 'end_turn' };
      },
    }),
  });
  return { kernel, seen };
}

test('the second turn is handed the first turn as history', async () => {
  // Without this the model cannot answer a question about something it was told earlier.
  const { kernel, seen } = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  await kernel.sendMessage(s.sessionId, 'Remember this number: 4711.');
  await kernel.sendMessage(s.sessionId, 'What number did I ask you to remember?');

  assert.equal(seen.length, 2, 'the agent was not called twice');
  const secondCall = JSON.stringify(seen[1]);
  assert.ok(secondCall.includes('4711'), 'the first user message was not carried into turn two');
});

test('the transcript keeps both turns in order', async () => {
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  await kernel.sendMessage(s.sessionId, 'Remember this number: 4711.');
  await kernel.sendMessage(s.sessionId, 'What number did I ask you to remember?');

  const rows = kernel.getTranscript(s.sessionId);
  assert.ok(Array.isArray(rows));
  const text = JSON.stringify(rows);
  assert.ok(text.includes('4711'), 'the transcript lost the first user message');
  const firstAt = text.indexOf('4711');
  const secondAt = text.indexOf('remember?');
  assert.ok(firstAt < secondAt, 'the transcript rows are out of order');
});

test('history survives a kernel restart through the store', async () => {
  // The live check restarted the whole process and got the same session id and 4 rows.
  const fs = require('node:fs');
  const os = require('node:os');
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-')), 'store.json');
  try {
    // The store must be attached to the FIRST kernel too: without it nothing is written,
    // and the reload assertion would fail for a reason unrelated to persistence.
    const first = makeKernel(storePath);
    const s = first.kernel.start({ cwd: process.cwd() });
    await first.kernel.sendMessage(s.sessionId, 'Remember this number: 4711.');
    if (typeof first.kernel.persist === 'function') first.kernel.persist(storePath);

    // Measured: the store file is written (3039 bytes here) and holds the message.
    assert.equal(fs.existsSync(storePath), true, 'nothing was persisted to the store');
    assert.ok(fs.readFileSync(storePath, 'utf8').includes('4711'), 'the store does not hold the message');

    const reloaded = createSessionKernel({
      emit: () => {},
      log: () => {},
      storePath,
      createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: 'ok' }; } }),
    });
    // Unconditional: an `if (rows.length)` guard would let a broken reload pass silently,
    // which is exactly the no-coverage failure this suite has hit before.
    const rows = reloaded.getTranscript(s.sessionId);
    assert.ok(Array.isArray(rows) && rows.length > 0, 'the reloaded kernel has no transcript at all');
    assert.ok(JSON.stringify(rows).includes('4711'), 'the reloaded transcript lost the message');
  } finally {
    fs.rmSync(path.dirname(storePath), { recursive: true, force: true });
  }
});
