import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

test('desktop backend explicitly enables upstream partial stream messages', () => {
  const main = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  const kernel = fs.readFileSync(new URL('../desktop/ccb-kernel.cjs', import.meta.url), 'utf8');
  assert.match(main, /extraArgs:\s*\['--include-partial-messages'\]/);
  assert.match(kernel, /args\.push\(\.\.\.options\.extraArgs\)/);
});
const require = createRequire(import.meta.url);
const { createCcbTranscriptMapper } = require('../desktop/ccb-events.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const stream = (event, extra = {}) => ({ type: 'stream_event', session_id: 'native', parent_tool_use_id: null, event, ...extra });
const frames = [
  stream({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], model: 'provider' } }),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } }),
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
  stream({ type: 'content_block_stop', index: 0 }),
  stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hel' } }),
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } }),
  stream({ type: 'content_block_stop', index: 1 }),
  stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
  stream({ type: 'message_stop' }),
];
const assistant = { type: 'assistant', uuid: 'native-a', message: { id: 'm1', role: 'assistant', model: 'provider', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'reason', signature: 'sig' }, { type: 'text', text: 'hello' }] } };
const terminal = { type: 'result', uuid: 'result-a', subtype: 'success', session_id: 'native', result: 'hello', is_error: false, stop_reason: 'end_turn' };

test('native stream envelopes preserve provider thinking, signatures, indices and parent routing', () => {
  const mapper = createCcbTranscriptMapper({ sessionId: 'host' });
  const events = frames.flatMap(frame => mapper.apply(frame).events);
  assert.deepEqual(events.filter(e => e.type === 'message').map(e => e.message), frames);
  assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), 'hello');
  assert.equal(mapper.snapshot().unknownFrames, 0);
  assert.equal(mapper.entries.length, 0, 'stream transport is not a transcript row');
  const unscoped = { type: 'stream_event', event: { type: 'message_stop' } };
  const normalized = mapper.apply(unscoped).events[0].message;
  assert.equal(normalized.parent_tool_use_id, null, 'renderer requires explicit null for the root stream');
  assert.equal(normalized.session_id, 'host');
  assert.equal(mapper.apply(assistant).events.some(e => e.type === 'text_delta'), false, 'closed block must not replay streamed text');
  assert.equal(mapper.entries[0].message.stop_reason, 'end_turn');
  const child = stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child' } }, { parent_tool_use_id: 'tool-1' });
  assert.deepEqual(mapper.apply(child).events, [{ type: 'message', sessionId: 'host', message: child }]);
  mapper.resetTurn();
  assert.equal(mapper.apply(assistant).events.find(e => e.type === 'text_delta').text, 'hello');
});

test('session sends stream and committed assistant before backend resolves, then native terminal exactly once', async () => {
  const events = [], listeners = new Set();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const backend = {
    id: 'stream-contract', start() {}, cancel() {}, dispose() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async sendMessage(sessionId) {
      for (const frame of [...frames, assistant, terminal]) for (const fn of listeners) fn({ sessionId, type: 'raw', frame, primaryForNativeCycle: undefined });
      entered();
      await gate;
      return { text: 'hello', stopReason: 'end_turn' };
    },
  };
  const kernel = createSessionKernel({ backend, emit: event => events.push(event) });
  const { sessionId } = kernel.start({ cwd: 'C:\\work' });
  const pending = kernel.sendMessage(sessionId, 'hello?');
  await started;
  assert.deepEqual(events.filter(e => e.type === 'message' && e.message.type === 'stream_event').map(e => e.message), frames);
  const live = events.find(e => e.type === 'message' && e.message.type === 'assistant');
  assert.ok(live, 'closed blocks must reach renderer while backend turn is still running');
  assert.equal(kernel.getSession(sessionId).isRunning, true);
  assert.equal(events.some(e => e.type === 'message' && e.message.type === 'result'), false, 'terminal stays behind transcript commit');
  release();
  await pending;
  const results = events.filter(e => e.type === 'message' && e.message.type === 'result');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].message, terminal);
  assert.equal(kernel.getTranscript(sessionId).find(e => e.type === 'assistant').uuid, live.message.uuid);
  assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), 'hello');
  assert.equal(events.filter(e => e.type === 'turn_finished').length, 1);
  assert.equal(kernel.getSession(sessionId).isRunning, false);
});
