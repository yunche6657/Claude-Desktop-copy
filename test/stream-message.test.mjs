import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMessageAccumulator } = require('../desktop/stream-message.cjs');
const start = { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture',
  content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 3 } } };
const stop = { type: 'message_stop' };
const block = (index, content_block) => ({ type: 'content_block_start', index, content_block });
const delta = (index, value) => ({ type: 'content_block_delta', index, delta: value });
const close = index => ({ type: 'content_block_stop', index });
const sse = (value, ending = '\n') => `event: ${value.type}${ending}data: ${JSON.stringify(value)}${ending}${ending}`;
const aggregate = frames => {
  const acc = createMessageAccumulator();
  for (const value of frames) acc.push(Buffer.from(sse(value)));
  return acc.finish();
};

test('aggregates UTF8 CRLF fragments, text, tools, thinking/signature, citations and usage', () => {
  const frames = [start,
    block(0, { type: 'thinking', thinking: '', signature: '' }),
    delta(0, { type: 'thinking_delta', thinking: 'fixture' }),
    delta(0, { type: 'signature_delta', signature: 'sig-' }),
    delta(0, { type: 'signature_delta', signature: 'fixture' }), close(0),
    block(1, { type: 'text', text: '' }), delta(1, { type: 'text_delta', text: '你好🙂' }),
    delta(1, { type: 'citations_delta', citation: { type: 'page_location', start_page_number: 1 } }), close(1),
    block(2, { type: 'tool_use', id: 'tool_fixture', name: 'Read', input: {} }),
    delta(2, { type: 'input_json_delta', partial_json: '{"file_' }),
    delta(2, { type: 'input_json_delta', partial_json: 'path":"fixture.txt"}' }), close(2),
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }, stop];
  const input = Buffer.from(': comment\r\n\r\n' + sse({ type: 'ping' }, '\r\n') + frames.map(frame => sse(frame, '\r\n')).join(''));
  const acc = createMessageAccumulator();
  // One-byte chunks force both CR/LF and multi-byte Unicode boundaries to split.
  for (let i = 0; i < input.length; i++) acc.push(input.subarray(i, i + 1));
  const result = acc.finish();
  assert.equal(result.id, 'msg_fixture');
  assert.equal(result.model, 'fixture');
  assert.equal(result.role, 'assistant');
  assert.equal(result.content.length, 3);
  assert.equal(result.content[0].thinking.length, 7);
  assert.equal(result.content[0].signature.length, 11);
  assert.equal(result.content[1].text, '你好🙂');
  assert.equal(result.content[1].citations[0].start_page_number, 1);
  assert.deepEqual(result.content[2], { type: 'tool_use', id: 'tool_fixture', name: 'Read', input: { file_path: 'fixture.txt' } });
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 9, cache_read_input_tokens: 3 });
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.stop_sequence, null);
});

test('supports multiline data fields and bare CR event boundaries', () => {
  const acc = createMessageAccumulator();
  const serialized = JSON.stringify(start);
  const split = serialized.indexOf(',');
  acc.push(Buffer.from(`event: message_start\rdata: ${serialized.slice(0, split + 1)}\rdata: ${serialized.slice(split + 1)}\r\r`));
  acc.push(Buffer.from(sse(stop, '\r')));
  assert.equal(acc.finish().id, 'msg_fixture');
});

test('preserves opaque redacted/server-result content blocks without fabricating deltas', () => {
  const value = { type: 'redacted_thinking', data: 'opaque-fixture' };
  const result = aggregate([start, block(0, value), close(0), stop]);
  assert.equal(result.content[0].type, value.type);
  assert.equal(result.content[0].data.length, value.data.length);
});

test('refuses missing start/stop and incomplete or sparse blocks', () => {
  for (const [frames, code] of [
    [[{ type: 'message_delta', delta: {}, usage: { output_tokens: 0 } }, stop], 'missing_message_start'],
    [[start], 'missing_message_stop'],
    [[start, block(0, { type: 'text', text: '' }), stop], 'incomplete_content_blocks'],
    [[start, block(1, { type: 'text', text: '' }), close(1), stop], 'incomplete_content_blocks'],
  ]) assert.throws(() => aggregate(frames), { code });
});

test('invalid tool JSON never produces a tool reply', () => {
  for (const partial_json of ['{"file":', 'not-json', 'null', '[]']) {
    assert.throws(() => aggregate([start, block(0, { type: 'tool_use', id: 't', name: 'Read', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json }), close(0), stop]),
    error => ['invalid_tool_json_delta', 'invalid_tool_input'].includes(error.code));
  }
});

test('rejects error frames, unknown deltas, duplicate start and events after stop', () => {
  assert.throws(() => aggregate([{ type: 'error', error: { type: 'overloaded_error', message: 'synthetic-upstream-error' } }]), { code: 'upstream_error_event' });
  assert.throws(() => aggregate([start, start]), { code: 'duplicate_message_start' });
  assert.throws(() => aggregate([start, block(0, { type: 'text', text: '' }), delta(0, { type: 'future_delta' })]), { code: 'unsupported_content_delta' });
  assert.throws(() => aggregate([start, stop, start]), { code: 'event_after_message_stop' });
});

test('truncated event, invalid JSON/UTF8 and mismatched SSE type fail explicitly', () => {
  const truncated = createMessageAccumulator();
  truncated.push(Buffer.from(sse(start) + 'event: message_stop\ndata: {"type":"message_stop"}\n'));
  assert.throws(() => truncated.finish(), { code: 'truncated_sse_event' });
  assert.throws(() => createMessageAccumulator().push(Buffer.from('data: nope\n\n')), { code: 'invalid_sse_json' });
  assert.throws(() => createMessageAccumulator().push(Buffer.from([0xff])), { code: 'invalid_sse_utf8' });
  assert.throws(() => createMessageAccumulator().push(Buffer.from(`event: ping\ndata: ${JSON.stringify(start)}\n\n`)), { code: 'sse_event_type_mismatch' });
});

test('bounds response bytes, event bytes and content block count', () => {
  const bytes = createMessageAccumulator({ maxBytes: 12 });
  assert.throws(() => bytes.push(Buffer.alloc(13, 32)), { code: 'sse_response_too_large' });
  const event = createMessageAccumulator({ maxEventBytes: 12 });
  assert.throws(() => event.push(Buffer.from('data: ' + 'x'.repeat(13))), { code: 'sse_event_too_large' });
  const blocks = createMessageAccumulator({ maxBlocks: 1 });
  blocks.push(Buffer.from(sse(start)));
  assert.throws(() => blocks.push(Buffer.from(sse(block(1, { type: 'text', text: '' })))), { code: 'invalid_content_block_index' });
});
