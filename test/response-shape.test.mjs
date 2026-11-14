// What the agent loop does with the response shapes this gateway actually returns.
//
// Measured against http://127.0.0.1:3000 (deepseek-v4.1-flash):
//
//   non-streaming POST /v1/messages -> content: [{"type":"thinking",...},{"type":"text",...}]
//   streaming (stream:true)          -> text/event-stream, but only TWO frames:
//                                       message_delta (output_tokens 0) and message_stop
//                                       no message_start, no content_block_delta
//
// Two consequences worth pinning:
//
// 1. Thinking blocks arrive and must NOT be shown as the answer, but they MUST be echoed
//    back on the next turn. Verified: sending [thinking, text] back and asking a follow-up
//    returns 200 and the right word. Dropping them, or printing them, would both be wrong.
// 2. Streaming cannot be implemented against this gateway: there is no text to render
//    progressively. Measured on the UI: the answer appears in one step (0 -> 331 chars,
//    no intermediate growth). That is the gateway, not the shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = require(path.join(ROOT, 'desktop', 'agent.cjs'));

test('assistantText never returns the contents of a thinking block', () => {
  // Measured shape from this gateway: a thinking block has ONLY {type, thinking} — it
  // has no `text` key at all. So the protection is the filter's whitelist, not the map.
  // Earlier mutations that merely broadened the filter changed nothing observable,
  // which is why the assertion below checks the thinking CONTENT, not the block count.
  const THINKING = 'internal reasoning that must not surface';
  const message = {
    type: 'message',
    content: [
      { type: 'thinking', thinking: THINKING },
      { type: 'text', text: 'Hello there friend' },
    ],
  };
  const text = agent.assistantText(message);
  assert.equal(text, 'Hello there friend');
  assert.equal(text.includes(THINKING), false, 'thinking content leaked into the answer');
  // And a message that is ONLY thinking must produce nothing at all.
  assert.equal(agent.assistantText({ content: [{ type: 'thinking', thinking: THINKING }] }), '');
});
test('assistantText concatenates multiple text blocks in order', () => {
  const message = {
    content: [
      { type: 'text', text: 'alpha ' },
      { type: 'thinking', thinking: 'ignored' },
      { type: 'text', text: 'beta' },
    ],
  };
  assert.equal(agent.assistantText(message), 'alpha beta');
});

test('toolRequests ignores thinking and text blocks', () => {
  // A thinking block has no id/name; treating one as a tool call would fire a phantom
  // tool with an empty input.
  const message = {
    content: [
      { type: 'thinking', thinking: 'x' },
      { type: 'text', text: 'let me check' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a.txt' } },
    ],
  };
  const requests = agent.toolRequests(message);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].name, 'Read');
  assert.equal(requests[0].id, 'tu_1');
});

test('the caller echoes the full assistant content, not just the text', () => {
  // Sending back only the text would drop the thinking block the gateway expects to see
  // again, and drop tool_use blocks so the follow-up tool_result has nothing to attach to.
  const src = require('node:fs').readFileSync(path.join(ROOT, 'desktop', 'agent.cjs'), 'utf8');
  assert.match(src, /messages\.push\(\{ role: 'assistant', content: message\.content \}\)/,
    'the loop must echo message.content verbatim');
});
