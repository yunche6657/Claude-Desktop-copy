// Tests for the session kernel: the adapter that lets the shipped frontend use
// the project's existing agent runner over the EIPC bridge instead of HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/** A stub agent that streams a fixed reply and records what it was asked. */
function stubAgent(reply = 'STUB-OK') {
  const seen = [];
  return {
    model: 'stub-model',
    tools: ['Read'],
    seen,
    async run({ messages, onEvent }) {
      seen.push(messages);
      onEvent({ type: 'text', text: reply });
      return {
        text: reply,
        stopReason: 'end_turn',
        messages: [...messages, { role: 'assistant', content: [{ type: 'text', text: reply }] }],
      };
    },
  };
}

function makeKernel(reply) {
  const events = [];
  const agent = stubAgent(reply);
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: () => agent,
  });
  return { kernel, events, agent };
}

test('start creates a session with the given folder', () => {
  const { kernel, events } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\work' });
  assert.match(s.sessionId, /^local_[0-9a-f-]{36}$/);
  assert.equal(s.cwd, 'C:\\work');
  assert.equal(s.isRunning, false);
  // The renderer's event switch has cases for "start" and "session_updated"; it
  // has no "session_started" case, so that name reached nobody.
  assert.equal(events[0].type, 'start');
  assert.equal(events[1].type, 'session_updated');
});

test('start adopts the session id a prewarm handed out', () => {
  // The landing composer prewarms, then passes that handle's sessionId back to
  // start(). Inventing a different id made the created session differ from the
  // route the renderer had already navigated to.
  const { kernel } = makeKernel();
  const id = 'local_11111111-2222-4333-8444-555555555555';
  const s = kernel.start({ sessionId: id, cwd: 'C:\\work' });
  assert.equal(s.sessionId, id);
  assert.equal(kernel.getSession(id).sessionId, id);
});

test('start runs the message it was given as the first turn', async () => {
  // The landing composer never calls sendMessage: it passes the text as `message`
  // inside the start payload. Dropping it produced a session with an empty
  // transcript and no reply, which is exactly the "create then send does nothing"
  // symptom.
  const { kernel, agent } = makeKernel('FIRST-OK');
  const s = kernel.start({ cwd: 'C:\\work', message: 'hello there' });

  // The turn runs detached so start() can resolve the record immediately.
  for (let i = 0; i < 100 && kernel.getTranscript(s.sessionId).length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const entries = kernel.getTranscript(s.sessionId);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].message.content[0].text, 'hello there');
  assert.equal(entries[1].message.content[0].text, 'FIRST-OK');
  assert.equal(agent.seen.length, 1);
});

test('a first turn emits stream-json message events', async () => {
  // The transcript view appends rows from `message` events carrying stream-json
  // entries; nothing else populates it.
  const { kernel, events } = makeKernel('EVT-OK');
  const s = kernel.start({ cwd: 'C:\\work', message: 'ping' });
  for (let i = 0; i < 100 && !events.some((e) => e.type === 'message'); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const messages = events.filter((e) => e.type === 'message' && e.sessionId === s.sessionId);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message.type, 'user');
  assert.equal(messages[1].message.type, 'assistant');
});

test('a start without a message does not run a turn', () => {
  const { kernel, agent } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\work', message: '   ' });
  assert.equal(kernel.getTranscript(s.sessionId).length, 0);
  assert.equal(agent.seen.length, 0);
});

test('the session record matches the observed original shape', () => {
  // A running original's session object carries these names and no `messages`
  // field; the detail view reads conversation content from getTranscript.
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\work' });
  for (const key of ['sessionId', 'cwd', 'cliSessionId', 'userSelectedFolders',
    'isRunning', 'createdAt', 'lastActivityAt', 'model', 'effortLevel',
    'permissionMode', 'isArchived', 'homePath', 'sessionType']) {
    assert.ok(key in s, `missing ${key}`);
  }
  assert.equal('messages' in s, false, 'the session record must not carry messages');
});

test('timestamps are epoch milliseconds and cliSessionId is set', () => {
  // The original reports lastActivityAt as a number (e.g. 1792319394134) and always
  // carries a cliSessionId. An ISO string there leaves the sidebar unable to order
  // entries, and a null cliSessionId reads as "not yet started".
  const { kernel } = makeKernel();
  const s = kernel.start({});
  assert.equal(typeof s.createdAt, 'number');
  assert.equal(typeof s.lastActivityAt, 'number');
  assert.ok(s.lastActivityAt > 1_600_000_000_000, 'must be epoch ms, not seconds');
  assert.match(s.cliSessionId, /^[0-9a-f-]{36}$/);
  // The original reports an empty string here, not null.
  assert.equal(s.initialMessage, '');
});

test('start accepts a userSelectedFolders array', () => {
  const { kernel } = makeKernel();
  const s = kernel.start({ userSelectedFolders: ['C:\\a', 'C:\\b'] });
  assert.equal(s.cwd, 'C:\\a');
});

test('sendMessage streams a text delta and finishes', async () => {
  const { kernel, events } = makeKernel('HULLO');
  const s = kernel.start({});
  const result = await kernel.sendMessage(s.sessionId, 'hi');

  assert.equal(result.ok, true);
  assert.equal(result.text, 'HULLO');
  assert.equal(result.stopReason, 'end_turn');

  const types = events.map((e) => e.type);
  assert.ok(types.includes('turn_started'), types.join(','));
  assert.ok(types.includes('text_delta'), types.join(','));
  assert.ok(types.includes('turn_finished'), types.join(','));
});

test('sendMessage keeps conversation history across turns', async () => {
  const { kernel, agent } = makeKernel('A1');
  const s = kernel.start({});
  await kernel.sendMessage(s.sessionId, 'first');

  assert.equal(agent.seen.length, 1);
  assert.deepEqual(agent.seen[0].map((m) => m.role), ['user']);

  // Conversation content lives in the transcript, not on the session record.
  const transcript = kernel.getTranscript(s.sessionId);
  assert.equal(transcript.length, 2, 'one user entry plus one assistant entry');
  assert.equal(transcript[0].type, 'user');
  assert.equal(transcript[1].type, 'assistant');

  const session = kernel.getSession(s.sessionId);
  assert.equal(session.isRunning, false);
  assert.equal('messages' in session, false);
});

test('a second turn sees the first turn in its history', async () => {
  const { kernel, agent } = makeKernel('R1');
  const s = kernel.start({});
  await kernel.sendMessage(s.sessionId, 'first');
  await kernel.sendMessage(s.sessionId, 'second');

  assert.equal(agent.seen.length, 2);
  // The second call must include the earlier user and assistant turns.
  assert.equal(agent.seen[1].length, 3, 'user + assistant + new user');
  assert.equal(kernel.getTranscript(s.sessionId).length, 4);
});

test('sendMessage rejects an unknown session', async () => {
  const { kernel } = makeKernel();
  await assert.rejects(() => kernel.sendMessage('local_missing', 'x'), /unknown session/);
});

test('a failed turn clears the running flags and reports the error', async () => {
  const events = [];
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: () => ({ async run() { throw new Error('boom'); } }),
  });
  const s = kernel.start({});
  const result = await kernel.sendMessage(s.sessionId, 'x');

  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
  const after = kernel.getSession(s.sessionId);
  assert.equal(after.isRunning, false);
  assert.ok(events.some((e) => e.type === 'error'));
});

test('getAll lists created sessions', () => {
  const { kernel } = makeKernel();
  kernel.start({});
  kernel.start({});
  assert.equal(kernel.getAll().length, 2);
});

test('remove drops a session', () => {
  const { kernel } = makeKernel();
  const s = kernel.start({});
  assert.equal(kernel.remove(s.sessionId).ok, true);
  assert.equal(kernel.getSession(s.sessionId), null);
});

test('sessions persist across a restart when a store path is given', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kernel-'));
  const storePath = path.join(dir, 'sessions.json');

  const first = createSessionKernel({
    emit: () => {},
    createAgent: () => stubAgent('PERSISTED'),
    storePath,
  });
  const s = first.start({ cwd: 'C:\\work', title: 'kept' });
  await first.sendMessage(s.sessionId, 'hello');

  // A second kernel over the same file stands in for a process restart.
  const second = createSessionKernel({
    emit: () => {},
    createAgent: () => stubAgent('x'),
    storePath,
  });
  const all = second.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].sessionId, s.sessionId);
  assert.equal(all[0].title, 'kept');
  // A turn cannot still be running after a restart.
  assert.equal(all[0].isRunning, false);
  // The conversation survives too.
  assert.equal(second.getTranscript(s.sessionId).length, 2);
});

test('without a store path nothing is written and nothing is loaded', () => {
  const { kernel } = makeKernel();
  kernel.start({});
  assert.equal(kernel.getAll().length, 1);
  // No store path means no persistence, which is the previous behaviour.
});

test('remove is reflected in the persisted store', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kernel-'));
  const storePath = path.join(dir, 'sessions.json');
  const k = createSessionKernel({ emit: () => {}, createAgent: () => stubAgent(), storePath });
  const s = k.start({});
  k.remove(s.sessionId);

  const reloaded = createSessionKernel({ emit: () => {}, createAgent: () => stubAgent(), storePath });
  assert.equal(reloaded.getAll().length, 0);
});
