// Tests for the agent kernel backend contract, the LocalKernel adapter, and the
// session kernel's optional backend path (desktop/kernel-backend.cjs,
// desktop/local-kernel.cjs, desktop/session-kernel.cjs).
//
// The contract exists so the local agent loop and a claude-code-best child
// process can be swapped without the bridge noticing. That only holds if the two
// paths produce the same transcript, the same renderer events, and the same
// failure behaviour — which is what these tests pin down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  KERNEL_METHODS,
  isKernelBackend,
  assertKernelBackend,
  createKernelEventHub,
  normaliseTurnResult,
} = require('../desktop/kernel-backend.cjs');
const { createLocalKernel } = require('../desktop/local-kernel.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/** The stub agent desktop tests already use: streams one text event, returns it. */
function stubAgent(reply = 'STUB-OK') {
  const seen = [];
  return {
    model: 'stub-model',
    tools: ['Read'],
    seen,
    async run({ messages, onEvent }) {
      seen.push(messages);
      onEvent({ type: 'text', text: reply });
      return { text: reply, stopReason: 'end_turn' };
    },
  };
}

/** A backend stub that satisfies the contract and answers one turn. */
function stubBackend({ reply = 'BACKEND-OK', emitEvents = null, explode = null } = {}) {
  const emitted = [];
  const hub = createKernelEventHub();
  const calls = { start: [], sendMessage: [], cancel: [], dispose: 0 };
  const backend = {
    id: 'stub',
    start(opts) { calls.start.push(opts); return { id: 'stub' }; },
    async sendMessage(sessionId, message, opts) {
      calls.sendMessage.push({ sessionId, message, opts });
      if (explode) throw explode;
      const events = emitEvents || [{ type: 'text', text: reply }];
      for (const event of events) hub.emit({ sessionId, ...event });
      return { text: reply, stopReason: 'end_turn' };
    },
    cancel(sessionId) { calls.cancel.push(sessionId); return { ok: true }; },
    onEvent(cb) { return hub.onEvent(cb); },
    dispose() { calls.dispose += 1; return { ok: true }; },
  };
  return { backend, calls, emitted };
}

function collectEvents() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

// --- the contract itself ----------------------------------------------------

test('the contract names the five methods a backend must expose', () => {
  assert.deepEqual([...KERNEL_METHODS], ['start', 'sendMessage', 'cancel', 'onEvent', 'dispose']);
});

test('a well-formed backend passes validation and is returned unchanged', () => {
  const { backend } = stubBackend();
  assert.equal(isKernelBackend(backend), true);
  assert.equal(assertKernelBackend(backend), backend);
});

test('validation names the missing method instead of silently accepting', () => {
  // The failure mode this guards: a facade that no-ops a missing method turns
  // "the kernel is mis-wired" into "the UI is quiet".
  const { backend } = stubBackend();
  const broken = { ...backend, dispose: undefined };
  assert.equal(isKernelBackend(broken), false);
  assert.throws(() => assertKernelBackend(broken), /missing dispose\(\)/);
  assert.throws(() => assertKernelBackend({ ...backend, id: '' }), /non-empty string id/);
  assert.throws(() => assertKernelBackend(null), /must be an object/);
});

test('the event hub returns an unsubscribe function and survives a throwing listener', () => {
  const seen = [];
  const errors = [];
  const hub = createKernelEventHub({ onListenerError: (e) => errors.push(e.message) });
  const off = hub.onEvent((event) => seen.push(event.type));
  hub.onEvent(() => { throw new Error('listener blew up'); });

  hub.emit({ type: 'text' });
  assert.deepEqual(seen, ['text'], 'the good listener still ran');
  assert.match(errors[0], /listener blew up/);

  off();
  off(); // idempotent
  hub.emit({ type: 'tool_request' });
  assert.deepEqual(seen, ['text'], 'an unsubscribed listener receives nothing');
  assert.equal(hub.size, 1);
});

test('normaliseTurnResult fills the fields a caller is allowed to omit', () => {
  assert.deepEqual(normaliseTurnResult({ text: 'hi', stopReason: 'max_tokens' }), { text: 'hi', stopReason: 'max_tokens' });
  assert.deepEqual(normaliseTurnResult(null, 'fallback'), { text: 'fallback', stopReason: 'end_turn' });
  assert.deepEqual(normaliseTurnResult({}, ''), { text: '', stopReason: 'end_turn' });
});

// --- LocalKernel adapter ----------------------------------------------------

test('LocalKernel reports the backend id the session record records', () => {
  const kernel = createLocalKernel({ createAgent: () => stubAgent() });
  assert.equal(kernel.id, 'local');
  assert.equal(isKernelBackend(kernel), true);
});

test('LocalKernel streams the agent events with the session id attached', async () => {
  const kernel = createLocalKernel({ createAgent: () => stubAgent('LOCAL-TEXT') });
  const shown = [];
  kernel.onEvent((event) => shown.push(event));

  const result = await kernel.sendMessage('local_1', 'hi', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.text, 'LOCAL-TEXT');
  assert.equal(result.stopReason, 'end_turn');
  const text = shown.find((e) => e.type === 'text');
  assert.ok(text, 'a text event must reach the hub');
  assert.equal(text.sessionId, 'local_1');
});

test('LocalKernel refuses two concurrent turns in one session', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const kernel = createLocalKernel({
    createAgent: () => ({ async run() { await gate; return { text: 'x' }; } }),
  });
  const first = kernel.sendMessage('local_1', 'a', { messages: [] });
  await assert.rejects(() => kernel.sendMessage('local_1', 'b', { messages: [] }), /already running/);
  release();
  await first;
});

test('LocalKernel cancel aborts the signal the agent was given', async () => {
  let observed = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const kernel = createLocalKernel({
    createAgent: () => ({
      async run({ signal }) {
        observed = signal;
        await gate;
        return { text: 'late' };
      },
    }),
  });
  const turn = kernel.sendMessage('local_1', 'a', { messages: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(observed.aborted, false);
  assert.equal(kernel.cancel('local_1').ok, true);
  assert.equal(observed.aborted, true, 'the agent signal must be aborted');
  assert.equal(kernel.cancel('local_1').ok, false, 'cancel is idempotent, second call is a no-op');
  release();
  await turn;
});

test('LocalKernel dispose aborts in-flight turns and detaches listeners', async () => {
  let observed = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const kernel = createLocalKernel({
    createAgent: () => ({ async run({ signal }) { observed = signal; await gate; return { text: 'x' }; } }),
  });
  const shown = [];
  kernel.onEvent((e) => shown.push(e));
  const turn = kernel.sendMessage('local_1', 'a', { messages: [] });
  await new Promise((r) => setImmediate(r));

  assert.equal(kernel.dispose().ok, true);
  assert.equal(observed.aborted, true);
  assert.equal(kernel.dispose().alreadyDisposed, true);
  release();
  await turn;
  assert.deepEqual(shown, [], 'a disposed kernel keeps emitting nothing');
});

// --- session kernel over a backend ------------------------------------------

test('a backend-supplied session emits the same message and turn_finished events', async () => {
  // (b) of the task: the renderer's event switch reads `type: "message"` with a
  // stream-json entry and `turn_finished`; a backend path that skipped them
  // would create sessions that render blank even though the turn succeeded.
  const { backend } = stubBackend({ reply: 'FROM-BACKEND' });
  const { events, emit } = collectEvents();
  const kernel = createSessionKernel({ emit, backend });
  const s = kernel.start({ cwd: 'C:\\work' });

  const result = await kernel.sendMessage(s.sessionId, 'hello');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'FROM-BACKEND');

  const messages = events.filter((e) => e.type === 'message');
  assert.equal(messages.length, 2, 'one user entry plus one assistant entry');
  assert.equal(messages[0].message.type, 'user');
  assert.equal(messages[1].message.type, 'assistant');
  assert.equal(messages[1].message.message.content[0].text, 'FROM-BACKEND');

  const finished = events.find((e) => e.type === 'turn_finished');
  assert.ok(finished, 'turn_finished must be emitted');
  assert.equal(finished.text, 'FROM-BACKEND');
  assert.equal(finished.stopReason, 'end_turn');
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text === 'FROM-BACKEND'));
  assert.ok(events.some((e) => e.type === 'turn_started'));
});

test('the backend path produces the same transcript shape as the legacy path', async () => {
  // (a) of the task. Same turn, same input, two kernels: the stored transcript
  // must agree entry-for-entry on everything the transcript view reads.
  const { backend } = stubBackend({ reply: 'SAME-TEXT' });
  const legacyEvents = collectEvents();
  const legacy = createSessionKernel({ emit: legacyEvents.emit, createAgent: () => stubAgent('SAME-TEXT') });
  const backedEvents = collectEvents();
  const backed = createSessionKernel({ emit: backedEvents.emit, backend });

  const legacySession = legacy.start({ cwd: 'C:\\work' });
  const backedSession = backed.start({ cwd: 'C:\\work' });
  await legacy.sendMessage(legacySession.sessionId, 'same message');
  await backed.sendMessage(backedSession.sessionId, 'same message');

  const a = legacy.getTranscript(legacySession.sessionId);
  const b = backed.getTranscript(backedSession.sessionId);
  assert.equal(a.length, b.length, 'transcript entry count must match');
  assert.deepEqual(a.map((e) => e.type), b.map((e) => e.type));
  for (let i = 0; i < a.length; i += 1) {
    assert.equal(a[i].message.role, b[i].message.role, `entry ${i} role`);
    assert.equal(a[i].message.content[0].type, b[i].message.content[0].type, `entry ${i} content type`);
    assert.deepEqual(Object.keys(a[i]).sort(), Object.keys(b[i]).sort(), `entry ${i} keys`);
  }
  assert.equal(a[1].message.content[0].text, b[1].message.content[0].text);
});

test('tool calls streamed by a backend land in the transcript as tool_use/tool_result', async () => {
  const { backend } = stubBackend({
    reply: 'DONE',
    emitEvents: [
      { type: 'tool_request', id: 'tu_1', name: 'Read', input: { path: 'a.txt' } },
      { type: 'tool_result', id: 'tu_1', name: 'Read', content: 'file body' },
      { type: 'text', text: 'DONE' },
    ],
  });
  const { events, emit } = collectEvents();
  const kernel = createSessionKernel({ emit, backend });
  const s = kernel.start({ cwd: 'C:\\work' });
  await kernel.sendMessage(s.sessionId, 'read it');

  const transcript = kernel.getTranscript(s.sessionId);
  // user, assistant(tool_use), user(tool_result), assistant(text)
  assert.equal(transcript.length, 4);
  assert.equal(transcript[1].message.content[0].type, 'tool_use');
  assert.equal(transcript[1].message.content[0].name, 'Read');
  assert.equal(transcript[2].message.content[0].type, 'tool_result');
  assert.equal(transcript[2].message.content[0].tool_use_id, 'tu_1');
  assert.equal(transcript[2].message.content[0].content, 'file body');
  assert.ok(events.some((e) => e.type === 'tool_request' && e.name === 'Read'));
  assert.ok(events.some((e) => e.type === 'tool_request' && e.sessionId === s.sessionId));
});

test('a backend that only answers in its turn result still fills the transcript', async () => {
  // A backend is not obliged to stream every token: the CCB child process reports
  // the final assistant text on the `result` frame. If the turn result were
  // dropped, this reply would vanish and the transcript would hold an empty
  // assistant entry — the "answered without saying anything" failure.
  const { backend } = stubBackend({ reply: 'RESULT-ONLY', emitEvents: [] });
  const { events, emit } = collectEvents();
  const kernel = createSessionKernel({ emit, backend });
  const s = kernel.start({ cwd: 'C:\\work' });

  const result = await kernel.sendMessage(s.sessionId, 'x');
  assert.equal(result.text, 'RESULT-ONLY');
  assert.equal(result.stopReason, 'end_turn');

  const transcript = kernel.getTranscript(s.sessionId);
  assert.equal(transcript.length, 2);
  assert.equal(transcript[1].message.content[0].text, 'RESULT-ONLY', 'the turn result must reach the transcript');
  const finished = events.find((e) => e.type === 'turn_finished');
  assert.equal(finished.text, 'RESULT-ONLY');
  const assistantMessage = events.filter((e) => e.type === 'message').pop();
  assert.equal(assistantMessage.message.message.content[0].text, 'RESULT-ONLY');
});

test('a backend that throws resets isRunning and reports the error', async () => {
  // (c) of the task. A backend is a child process or a remote call; it can die
  // mid-turn. If the flag stayed set the session could never be sent to again.
  const { backend } = stubBackend({ explode: new Error('kernel died') });
  const { events, emit } = collectEvents();
  const kernel = createSessionKernel({ emit, backend });
  const s = kernel.start({ cwd: 'C:\\work' });

  const result = await kernel.sendMessage(s.sessionId, 'x');
  assert.equal(result.ok, false);
  assert.match(result.error, /kernel died/);
  assert.equal(kernel.getSession(s.sessionId).isRunning, false, 'isRunning must be reset');
  assert.ok(events.some((e) => e.type === 'error' && /kernel died/.test(e.message)));

  // And the session is usable again afterwards: the next turn goes through.
  const { backend: healthy } = stubBackend({ reply: 'RECOVERED' });
  const second = createSessionKernel({ emit: () => {}, backend: healthy });
  const s2 = second.start({ cwd: 'C:\\work' });
  const ok = await second.sendMessage(s2.sessionId, 'again');
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'RECOVERED');
});

test('start() is handed to the backend and recorded on the session', async () => {
  const { backend, calls } = stubBackend();
  const kernel = createSessionKernel({ emit: () => {}, backend });
  const s = kernel.start({ cwd: 'C:\\work', model: 'm1' });

  assert.equal(calls.start.length, 1);
  assert.equal(calls.start[0].sessionId, s.sessionId);
  assert.equal(calls.start[0].cwd, 'C:\\work');
  assert.equal(s.kernelBackend, 'stub', 'the session must record which kernel produced it');
});

test('cancel forwards to the backend and still clears the local turn', async () => {
  const { backend, calls } = stubBackend();
  const kernel = createSessionKernel({ emit: () => {}, backend });
  const s = kernel.start({ cwd: 'C:\\work' });
  await kernel.sendMessage(s.sessionId, 'x');
  assert.equal(calls.cancel.length, 0);

  // No turn running: nothing to cancel, and no backend call either.
  assert.equal(kernel.cancel(s.sessionId).ok, false);
  assert.equal(calls.cancel.length, 0);
});

test('an event for another session never reaches this turn', async () => {
  // The subscription is per turn. A backend that outlives a turn must not leak a
  // stale session's events into the transcript currently being built.
  const hub = createKernelEventHub();
  const backend = {
    id: 'leaky',
    start: () => ({ id: 'leaky' }),
    async sendMessage(sessionId) {
      hub.emit({ sessionId: 'someone-else', type: 'text', text: 'INTRUDER' });
      hub.emit({ sessionId, type: 'text', text: 'MINE' });
      return { text: 'MINE', stopReason: 'end_turn' };
    },
    cancel: () => ({ ok: true }),
    onEvent: (cb) => hub.onEvent(cb),
    dispose: () => ({ ok: true }),
  };
  const { events, emit } = collectEvents();
  const kernel = createSessionKernel({ emit, backend });
  const s = kernel.start({ cwd: 'C:\\work' });
  await kernel.sendMessage(s.sessionId, 'x');

  const deltas = events.filter((e) => e.type === 'text_delta');
  assert.deepEqual(deltas.map((e) => e.text), ['MINE'], 'the foreign-session event is dropped');
  assert.ok(deltas.every((e) => e.sessionId === s.sessionId));
  assert.ok(!events.some((e) => e.text === 'INTRUDER'), 'nothing from the other session leaks');
  const transcript = kernel.getTranscript(s.sessionId);
  assert.equal(transcript.length, 2);
  assert.equal(transcript[1].message.content[0].text, 'MINE');
});

test('the subscription is detached when the turn ends', async () => {
  const hub = createKernelEventHub();
  let unsubscribed = 0;
  const backend = {
    id: 'counting',
    start: () => ({ id: 'counting' }),
    async sendMessage() { return { text: 'ok', stopReason: 'end_turn' }; },
    cancel: () => ({ ok: true }),
    onEvent(cb) {
      const off = hub.onEvent(cb);
      return () => { unsubscribed += 1; off(); };
    },
    dispose: () => ({ ok: true }),
  };
  const kernel = createSessionKernel({ emit: () => {}, backend });
  const s = kernel.start({ cwd: 'C:\\work' });
  await kernel.sendMessage(s.sessionId, 'one');
  assert.equal(unsubscribed, 1);
  assert.equal(hub.size, 0);

  // A failed turn must detach too, otherwise a dead backend keeps a listener.
  const failing = {
    ...backend,
    async sendMessage() { throw new Error('boom'); },
  };
  const kernel2 = createSessionKernel({ emit: () => {}, backend: failing });
  const s2 = kernel2.start({ cwd: 'C:\\work' });
  await kernel2.sendMessage(s2.sessionId, 'two');
  assert.equal(unsubscribed, 2);
});

test('a backend session persists across a restart like a legacy one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kernel-backend-'));
  const storePath = path.join(dir, 'sessions.json');
  const { backend } = stubBackend({ reply: 'PERSISTED' });
  const first = createSessionKernel({ emit: () => {}, backend, storePath });
  const s = first.start({ cwd: 'C:\\work', title: 'kept' });
  await first.sendMessage(s.sessionId, 'hello');
  first.flush();

  const { backend: secondBackend } = stubBackend();
  const second = createSessionKernel({ emit: () => {}, backend: secondBackend, storePath });
  assert.equal(second.getAll().length, 1);
  assert.equal(second.getSession(s.sessionId).kernelBackend, 'stub');
  assert.equal(second.getTranscript(s.sessionId).length, 2);
});

test('a kernel built with neither createAgent nor backend is refused', () => {
  // Silently accepting this produced sessions whose turns resolved with an
  // empty reply and no error.
  assert.throws(() => createSessionKernel({ emit: () => {} }), /needs a createAgent\(\) or a backend/);
});

test('a kernel built with both createAgent and backend is refused', () => {
  // Preferring one silently is how a caller ends up believing it is driving CCB
  // while the local loop answers.
  const { backend } = stubBackend();
  assert.throws(
    () => createSessionKernel({ emit: () => {}, backend, createAgent: () => stubAgent() }),
    /not both/,
  );
});

test('a malformed backend is refused at construction, not mid-turn', () => {
  assert.throws(
    () => createSessionKernel({ emit: () => {}, backend: { id: 'half', start: () => {} } }),
    /missing sendMessage\(\)/,
  );
});
