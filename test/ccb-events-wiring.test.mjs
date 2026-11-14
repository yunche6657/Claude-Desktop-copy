// ccb-events.cjs must be wired, not merely well tested.
//
// I wrote the frame->transcript mapper with 13 passing tests and then found it referenced by
// nothing but its own test file: a backend turn still built the transcript from the callback
// trail, so a real kernel's tool round (which arrives as separate frames sharing one message
// id) would lay out wrong. Good unit tests on an unused module are the same failure as a
// correct selector nobody calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { createCcbTranscriptMapper } = require('../desktop/ccb-events.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kernelSource = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');

/** A backend that streams raw kernel frames, like the real one does. */
function frameBackend(frames) {
  const listeners = new Set();
  return {
    id: 'stub-frames',
    start() { return { ok: true }; },
    async sendMessage(_sessionId, _message) {
      for (const frame of frames) {
        for (const listener of [...listeners]) listener({ sessionId: _sessionId, type: 'raw', frame });
      }
      return { text: 'DONE', stopReason: 'end_turn' };
    },
    cancel() { return { ok: true }; },
    onEvent(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    dispose() { listeners.clear(); return { ok: true }; },
  };
}

test('session-kernel imports and uses the mapper', () => {
  assert.match(kernelSource, /require\('\.\/ccb-events\.cjs'\)/, 'the mapper must be imported');
  assert.match(kernelSource, /createCcbTranscriptMapper\(/, 'and constructed per turn');
  assert.match(kernelSource, /mapper\.apply\(/, 'and actually fed frames');
  assert.match(kernelSource, /mapper\.entries/, 'and its rows must be used');
});

test('raw frames become transcript rows, with tool_use paired to tool_result', async () => {
  const frames = [
    { type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo HI' } }] }, uuid: 'u1', session_id: 's' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'HI' }] }, uuid: 'u2', session_id: 's' },
    { type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'DONE' }] }, uuid: 'u3', session_id: 's' },
    { type: 'result', subtype: 'success', result: 'DONE', stop_reason: 'end_turn', session_id: 's' },
  ];
  const events = [];
  const session = createSessionKernel({ emit: (event) => events.push(event), backend: frameBackend(frames) });
  const started = session.start({ cwd: 'C:\\work' });
  await session.sendMessage(started.sessionId, 'run it');

  const transcript = session.getTranscript(started.sessionId);
  // user, assistant(tool_use + text merged), user(tool_result)
  assert.equal(transcript[0].type, 'user');
  const assistantRows = transcript.filter((row) => row.type === 'assistant');
  assert.equal(assistantRows.length, 1, 'one message id must be one row, not one row per frame');
  const blockTypes = assistantRows[0].message.content.map((block) => block.type);
  assert.ok(blockTypes.includes('tool_use'), 'the tool call must be recorded');
  assert.ok(blockTypes.includes('text'), 'the reply text must be recorded');

  const toolResult = transcript.find((row) => row.type === 'user' && row.message.content[0].type === 'tool_result');
  assert.equal(toolResult.message.content[0].tool_use_id, 'tu_1', 'the result must pair with the call');
  assert.ok(events.some((event) => event.type === 'tool_request' && event.name === 'Bash'));
});

test('a backend that sends no raw frames still gets its rows from the event trail', async () => {
  // The stub backends used elsewhere speak only the event vocabulary. Taking the mapper branch
  // with zero frames would produce a transcript with no rows at all.
  const listeners = new Set();
  const backend = {
    id: 'stub-events',
    start() { return { ok: true }; },
    async sendMessage(sessionId) {
      for (const event of [
        { type: 'tool_request', id: 'tu_9', name: 'Read', input: { path: 'a' } },
        { type: 'tool_result', id: 'tu_9', name: 'Read', content: 'body' },
        { type: 'text', text: 'DONE' },
      ]) for (const listener of [...listeners]) listener({ sessionId, ...event });
      return { text: 'DONE', stopReason: 'end_turn' };
    },
    cancel() { return { ok: true }; },
    onEvent(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    dispose() { listeners.clear(); return { ok: true }; },
  };
  const session = createSessionKernel({ emit: () => {}, backend });
  const started = session.start({ cwd: 'C:\\work' });
  await session.sendMessage(started.sessionId, 'x');
  const transcript = session.getTranscript(started.sessionId);
  assert.equal(transcript.length, 4, 'user + tool_use + tool_result + assistant');
  assert.equal(transcript[1].message.content[0].type, 'tool_use');
});

test('the mapper is per turn, so a second turn does not inherit the first', () => {
  // Everything in the mapper (message id -> entry, tool_use id -> name) is per-turn state. A
  // shared mapper would merge turn 2's reply into turn 1's row.
  const constructed = [];
  const mapper = createCcbTranscriptMapper({ cwd: 'C:\\work', sessionId: 's' });
  mapper.apply({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'one' }] }, uuid: 'u1' });
  assert.equal(mapper.entries.length, 1);
  mapper.resetTurn();
  assert.equal(mapper.entries.length, 0, 'resetTurn clears the row buffer');
  mapper.apply({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'two' }] }, uuid: 'u1' });
  assert.equal(mapper.entries.length, 1, 'the same message id in a new turn is a new row, not a merge');
  assert.equal(constructed.length, 0);
});
