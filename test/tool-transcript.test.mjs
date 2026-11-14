// Tool calls must reach the transcript, not just the model.
//
// The agent runs a tool and streams `tool_request`, but the kernel used to record
// only the user text and the final reply. Reopening the session therefore showed a
// conversation in which the assistant had answered without looking anything up —
// and the "Used <tool>" row never appeared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/**
 * An agent that makes one tool call, then answers. Mirrors the real event order:
 * tool_request -> tool_result -> text -> done.
 */
function toolAgent({ name = 'List', input = { path: '.' }, content = 'a\nb\n', fail = false } = {}) {
  return {
    model: 'stub',
    tools: [name],
    async run({ onEvent }) {
      onEvent({ type: 'tool_request', id: 'call-1', name, input });
      onEvent(fail
        ? { type: 'tool_error', id: 'call-1', name, message: 'boom' }
        : { type: 'tool_result', id: 'call-1', name, content });
      onEvent({ type: 'text', text: 'DONE' });
      return { text: 'DONE', stopReason: 'end_turn' };
    },
  };
}

function makeKernel(agent) {
  const events = [];
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: () => agent,
  });
  return { kernel, events };
}

test('a tool call is recorded as tool_use then tool_result', async () => {
  const { kernel } = makeKernel(toolAgent());
  const s = kernel.start({ cwd: 'C:\\w' });
  await kernel.sendMessage(s.sessionId, 'list the files');

  const entries = kernel.getTranscript(s.sessionId);
  const blocks = entries.flatMap((e) => (e.message?.content) || []);

  const use = blocks.find((b) => b.type === 'tool_use');
  assert.ok(use, 'the assistant turn must carry a tool_use block');
  assert.equal(use.name, 'List');
  assert.equal(use.id, 'call-1');

  const result = blocks.find((b) => b.type === 'tool_result');
  assert.ok(result, 'the following user turn must carry the tool_result');
  assert.equal(result.tool_use_id, 'call-1', 'results pair with their call by id');
  assert.equal(result.content, 'a\nb\n');
});

test('the transcript order is user, tool_use, tool_result, reply', async () => {
  // The transcript view walks this order; a tool_result before its tool_use (or a
  // reply between them) renders as an orphan row.
  const { kernel } = makeKernel(toolAgent());
  const s = kernel.start({ cwd: 'C:\\w' });
  await kernel.sendMessage(s.sessionId, 'go');

  const shape = kernel.getTranscript(s.sessionId).map((e) => {
    const first = (e.message?.content || [])[0] || {};
    if (first.type === 'tool_use') return 'tool_use';
    if (first.type === 'tool_result') return 'tool_result';
    return `${e.type}:${first.type || ''}`;
  });
  assert.deepEqual(shape, ['user:text', 'tool_use', 'tool_result', 'assistant:text']);
});

test('each tool_use has a parentUuid chain to its predecessor', async () => {
  // The stream-json entries form a linked list via parentUuid; a broken chain
  // makes the view treat rows as a separate thread.
  const { kernel } = makeKernel(toolAgent());
  const s = kernel.start({ cwd: 'C:\\w' });
  await kernel.sendMessage(s.sessionId, 'go');

  const entries = kernel.getTranscript(s.sessionId);
  for (let i = 1; i < entries.length; i += 1) {
    assert.equal(entries[i].parentUuid, entries[i - 1].uuid, `entry ${i} must chain to ${i - 1}`);
  }
});

test('tool entries are streamed as message events too', async () => {
  // The open view appends rows from `message` events; persistence alone would only
  // show the tool call after a reload. The payload nests the stream-json entry one
  // level down: the event is { type: "message", message: <entry> } and the entry
  // itself carries { message: { content: [...] } }.
  const { kernel, events } = makeKernel(toolAgent());
  const s = kernel.start({ cwd: 'C:\\w' });
  await kernel.sendMessage(s.sessionId, 'go');

  const streamed = events
    .filter((e) => e.type === 'message')
    .flatMap((e) => (e.message?.message?.content) || [])
    .map((b) => b.type);
  assert.ok(streamed.includes('tool_use'), 'the live view must receive the tool call');
  assert.ok(streamed.includes('tool_result'));
});

test('a failed tool records is_error rather than a silent success', async () => {
  const { kernel } = makeKernel(toolAgent({ fail: true }));
  const s = kernel.start({ cwd: 'C:\\w' });
  await kernel.sendMessage(s.sessionId, 'go');

  const result = kernel.getTranscript(s.sessionId)
    .flatMap((e) => (e.message?.content) || [])
    .find((b) => b.type === 'tool_result');
  assert.ok(result);
  assert.equal(result.is_error, true, 'a failure must not look like a success');
});

test('several tool calls in one turn are all recorded, in order', async () => {
  const agent = {
    model: 'stub',
    tools: ['List'],
    async run({ onEvent }) {
      onEvent({ type: 'tool_request', id: 'a', name: 'List', input: {} });
      onEvent({ type: 'tool_result', id: 'a', content: 'one' });
      onEvent({ type: 'tool_request', id: 'b', name: 'Read', input: {} });
      onEvent({ type: 'tool_result', id: 'b', content: 'two' });
      onEvent({ type: 'text', text: 'done' });
      return { text: 'done', stopReason: 'end_turn' };
    },
  };
  const { kernel } = makeKernel(agent);
  const s = kernel.start({ cwd: 'C:\\w' });
  await kernel.sendMessage(s.sessionId, 'go');

  const blocks = kernel.getTranscript(s.sessionId).flatMap((e) => (e.message?.content) || []);
  const uses = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id);
  const results = blocks.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
  assert.deepEqual(uses, ['a', 'b']);
  assert.deepEqual(results, ['a', 'b']);
});

test('a turn with no tool calls records no tool blocks', async () => {
  const agent = {
    model: 'stub',
    tools: [],
    async run({ onEvent }) {
      onEvent({ type: 'text', text: 'hi' });
      return { text: 'hi', stopReason: 'end_turn' };
    },
  };
  const { kernel } = makeKernel(agent);
  const s = kernel.start({ cwd: 'C:\\w' });
  await kernel.sendMessage(s.sessionId, 'go');

  const blocks = kernel.getTranscript(s.sessionId).flatMap((e) => (e.message?.content) || []);
  assert.equal(blocks.some((b) => b.type === 'tool_use'), false);
  assert.equal(kernel.getTranscript(s.sessionId).length, 2);
});
