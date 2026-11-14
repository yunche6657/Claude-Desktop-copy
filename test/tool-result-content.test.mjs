// A tool result must reach the transcript WITH its output.
//
// The agent's event carries the outcome as `preview`; session-kernel read only
// `content`/`message`, so every tool result was recorded as an empty string. The model still
// received the real output (it answered from it), which is what made this invisible: the
// conversation looked like "the assistant used a tool and got nothing back".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/** A backend stub that reports a tool round the way agent.cjs does. */
function backendWith({ preview, content }) {
  const listeners = new Set();
  return {
    id: 'stub-tool',
    start() { return { ok: true }; },
    async sendMessage(sessionId) {
      const emit = (event) => { for (const l of [...listeners]) l({ sessionId, ...event }); };
      emit({ type: 'tool_request', id: 'tu_1', name: 'Read', input: { path: 'a.txt' } });
      emit({ type: 'tool_result', id: 'tu_1', name: 'Read', isError: false, ...(preview !== undefined ? { preview } : {}), ...(content !== undefined ? { content } : {}) });
      emit({ type: 'text', text: 'done' });
      return { text: 'done', stopReason: 'end_turn' };
    },
    cancel() { return { ok: true }; },
    onEvent(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    dispose() { listeners.clear(); return { ok: true }; },
  };
}

function run(backend) {
  const kernel = createSessionKernel({ emit: () => {}, backend });
  const started = kernel.start({ cwd: 'C:\\work' });
  return kernel.sendMessage(started.sessionId, 'read it').then(() => kernel.getTranscript(started.sessionId));
}

test('a tool result reported only as `preview` is recorded, not dropped', async () => {
  // This is the exact shape agent.cjs emits.
  const transcript = await run(backendWith({ preview: 'file body' }));
  const toolResult = transcript
    .flatMap((row) => (row.message && row.message.content) || [])
    .find((block) => block.type === 'tool_result');
  assert.ok(toolResult, 'the tool result must be in the transcript');
  assert.equal(toolResult.content, 'file body', 'its output must not be an empty string');
});

test('`content` still wins when both are present', async () => {
  const transcript = await run(backendWith({ content: 'full content', preview: 'truncated' }));
  const toolResult = transcript
    .flatMap((row) => (row.message && row.message.content) || [])
    .find((block) => block.type === 'tool_result');
  assert.equal(toolResult.content, 'full content');
});

test('an error result keeps its message', async () => {
  const transcript = await run(backendWith({ preview: 'Exit code 1', content: 'Exit code 1' }));
  const toolResult = transcript
    .flatMap((row) => (row.message && row.message.content) || [])
    .find((block) => block.type === 'tool_result');
  assert.match(toolResult.content, /Exit code 1/);
});
