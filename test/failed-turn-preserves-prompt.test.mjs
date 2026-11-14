// A failed turn must not delete what the user typed.
//
// Measured before the fix: sendMessage('my important question') against an agent that throws
//   -> { ok: false, sessionId, error: 'turn failed' }
//   -> transcript rows: 0
//   -> 'my important question' nowhere in the transcript
//
// The user's own words are theirs whether or not the model answered. Only the assistant side
// of a turn is incomplete when it fails, so the catch writes the user row and nothing else —
// turnEntries is deliberately skipped, because a half-built tool sequence would render as a
// broken conversation.
//
// Found while auditing the checkpoint-audit teammate's note that a ReferenceError inside
// sendMessage is swallowed into { ok: false }. The swallowing is real; this file covers what
// it swallowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** A kernel whose agent always throws, plus the events it emitted. */
function failingKernel(storePath) {
  const events = [];
  const kernel = createSessionKernel({
    emit: (event) => events.push(event),
    log: () => {},
    ...(storePath ? { storePath } : {}),
    createAgent: () => ({
      model: 'stub',
      tools: [],
      async run() { throw new Error('turn failed'); },
    }),
  });
  return { kernel, events };
}

test('the user message survives a failed turn', async () => {
  const { kernel } = failingKernel();
  const session = kernel.start({ cwd: ROOT });
  const result = await kernel.sendMessage(session.sessionId, 'my important question');
  assert.equal(result.ok, false, 'the turn was expected to fail');
  const rows = kernel.getTranscript(session.sessionId);
  assert.equal(rows.length, 1, 'the failed turn left ' + rows.length + ' rows instead of the user row');
  assert.equal(rows[0].type, 'user');
  assert.match(JSON.stringify(rows[0].message), /my important question/,
    'the user text is not in the transcript');
});

test('the preserved row keeps a valid parent link to earlier turns', async () => {
  // Appending a failed row must not break the chain the transcript view walks.
  const { kernel } = failingKernel();
  const session = kernel.start({ cwd: ROOT });
  kernel.setTranscript(session.sessionId, [{
    uuid: '11111111-2222-4333-8444-555555555555',
    parentUuid: null,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
  }]);
  await kernel.sendMessage(session.sessionId, 'second');
  const rows = kernel.getTranscript(session.sessionId);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].parentUuid, rows[0].uuid, 'the failed row does not chain to the previous one');
});

test('no half-built tool rows are recorded for a failed turn', async () => {
  // Only the user row: an interrupted tool sequence would render as a broken conversation.
  const { kernel } = failingKernel();
  const session = kernel.start({ cwd: ROOT });
  await kernel.sendMessage(session.sessionId, 'x');
  const rows = kernel.getTranscript(session.sessionId);
  assert.equal(rows.filter((row) => row.type === 'assistant').length, 0,
    'a failed turn recorded an assistant row');
});

test('the failure is still reported through an error event', async () => {
  // Preserving the row must not silence the notification.
  const { kernel, events } = failingKernel();
  const session = kernel.start({ cwd: ROOT });
  await kernel.sendMessage(session.sessionId, 'x');
  const errors = events.filter((event) => event.type === 'error');
  assert.equal(errors.length, 1, 'expected exactly one error event, saw ' + errors.length);
  assert.match(String(errors[0].message), /turn failed/);
});

test('a failed turn does not mark the session as running', async () => {
  const { kernel } = failingKernel();
  const session = kernel.start({ cwd: ROOT });
  await kernel.sendMessage(session.sessionId, 'x');
  assert.equal(kernel.getSession(session.sessionId).isRunning, false,
    'the session was left marked running after a failure');
});

test('the preserved row is written to the store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-turn-'));
  try {
    const { kernel } = failingKernel(path.join(dir, 'store.json'));
    const session = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(session.sessionId, 'persisted after failure');
    kernel.flush();
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
    const rows = (stored.transcripts || {})[session.sessionId] || [];
    assert.equal(rows.length, 1, 'the user row never reached the store');
    assert.match(JSON.stringify(rows[0]), /persisted after failure/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
