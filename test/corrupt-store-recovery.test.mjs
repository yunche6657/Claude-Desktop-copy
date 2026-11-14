// A corrupt store must not take the app down. Seven ways to break it, all survived.
//
// MEASURED by writing each shape to a real store file and constructing a kernel over it:
//
//   empty file            sessions 0  can start true
//   not JSON              sessions 0  can start true
//   null                  sessions 0  can start true
//   {}                    sessions 0  can start true
//   sessions: "nope"      sessions 0  can start true
//   transcripts: {x: 5}   sessions 1  can start true   (the bad transcript is dropped)
//   session without id    sessions 0  can start true   (the malformed record is dropped)
//
// The last two are the interesting ones: a malformed ENTRY is dropped while the rest of the
// file is still loaded. Losing one bad session is recoverable; refusing to start is not.
//
// This is the 'state' checklist from the previous round applied literally: not 'does restart
// work' but 'what state can the file be in, and does each one still boot'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const CASES = [
  ['an empty file', ''],
  ['text that is not JSON', 'this is not json'],
  ['the literal null', 'null'],
  ['an empty object', '{}'],
  ['sessions that is not an array', '{"sessions":"nope","transcripts":{}}'],
  ['a transcript that is not an array', '{"sessions":[{"sessionId":"local_x"}],"transcripts":{"local_x":5}}'],
  ['a session with no id', '{"sessions":[{"title":"no id"}],"transcripts":{}}'],
];

/** Build a kernel over the given store content and report what it loaded. */
function bootWith(content) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-corrupt-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(storePath, content, 'utf8');
  try {
    const kernel = createSessionKernel({
      createAgent: () => ({ model: 'm', tools: [], run: async () => ({ text: 'ok', stopReason: 'end_turn' }) }),
      emit: () => {},
      storePath,
    });
    const sessions = kernel.getAll();
    const started = kernel.start({ cwd: ROOT });
    return { sessions, started };
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
}

for (const [label, content] of CASES) {
  test(`the app still boots with ${label}`, () => {
    let booted;
    assert.doesNotThrow(() => { booted = bootWith(content); }, 'a corrupt store prevented startup');
    assert.ok(Array.isArray(booted.sessions), 'getAll() did not return an array');
    assert.ok(booted.started && booted.started.sessionId, 'a new session could not be started');
  });
}

test('a malformed session entry is dropped without losing the valid ones', () => {
  // Two sessions, one of which has no id: the good one must survive.
  const content = JSON.stringify({
    sessions: [
      { sessionId: 'local_good', cwd: '/tmp', title: 'good', createdAt: 1, updatedAt: 1 },
      { title: 'no id at all' },
    ],
    transcripts: { local_good: [] },
  });
  const { sessions } = bootWith(content);
  assert.ok(sessions.some((s) => s.sessionId === 'local_good'), 'the valid session was dropped with the bad one');
  assert.equal(sessions.length, 1, 'the malformed entry was kept');
});

test('a store that is valid JSON but has no sessions key boots empty', () => {
  const { sessions, started } = bootWith('{"somethingElse":true}');
  assert.equal(sessions.length, 0);
  assert.ok(started && started.sessionId, 'a new session could not be started');
});
