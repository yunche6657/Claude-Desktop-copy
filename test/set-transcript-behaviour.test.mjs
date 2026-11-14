// setTranscript replaces, refuses unknown sessions, and refuses non-arrays — verified by running.
//
// MEASURED through the real kernel:
//   after a normal turn           2 rows
//   setTranscript(sid, [r1, r2])  -> the transcript becomes exactly [r1, r2]
//   uuids                         ["r1", "r2"]      (replaced, not appended)
//   setTranscript(unknown, rows)  -> null
//   setTranscript(sid, 'nope')    -> null            (refused, not coerced)
//
// The replace-vs-append distinction is the one that matters: this method exists so a caller can
// REPLACE a conversation (an import, a rewind), and an implementation that appended would
// double every row while still returning a plausible-looking transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const ROWS = [
  { uuid: 'r1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'A' }] } },
  { uuid: 'r2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'B' }] } },
];

/** A kernel with one session that already holds a completed turn. */
async function seeded() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-set-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    createAgent: () => ({ model: 'm', tools: [], run: async () => ({ text: 'ok', stopReason: 'end_turn' }) }),
    emit: () => {},
    storePath,
  });
  const s = kernel.start({ cwd: ROOT });
  await kernel.sendMessage(s.sessionId, 'seed');
  return { kernel, storePath, sessionId: s.sessionId };
}

test('setTranscript REPLACES the transcript instead of appending to it', async () => {
  const h = await seeded();
  try {
    assert.equal((h.kernel.getTranscript(h.sessionId) || []).length, 2, 'the seed turn did not record');
    h.kernel.setTranscript(h.sessionId, ROWS);
    const after = h.kernel.getTranscript(h.sessionId) || [];
    assert.equal(after.length, 2, 'the transcript grew instead of being replaced: ' + after.length);
    assert.deepEqual(after.map((r) => r.uuid), ['r1', 'r2'], 'the replacement rows are not the ones supplied');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('setTranscript refuses an unknown session', async () => {
  const h = await seeded();
  try {
    assert.equal(h.kernel.setTranscript('local_does-not-exist', ROWS), null, 'an unknown session was accepted');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('setTranscript refuses a non-array body', async () => {
  // Coercing a string into rows would create a transcript that cannot be sent.
  const h = await seeded();
  try {
    assert.equal(h.kernel.setTranscript(h.sessionId, 'not an array'), null, 'a string body was accepted');
    assert.equal(h.kernel.setTranscript(h.sessionId, null), null, 'a null body was accepted');
    assert.equal((h.kernel.getTranscript(h.sessionId) || []).length, 2, 'a refused write damaged the transcript');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('a replaced transcript can still be continued', async () => {
  // The point of replacing: the caller keeps a usable conversation.
  const h = await seeded();
  try {
    h.kernel.setTranscript(h.sessionId, ROWS);
    const res = await h.kernel.sendMessage(h.sessionId, 'continue');
    assert.equal(res.ok, true, 'the replaced transcript could not be continued: ' + JSON.stringify(res && res.error));
    assert.equal((h.kernel.getTranscript(h.sessionId) || []).length, 4, 'the continued turn did not append');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});
