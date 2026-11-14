import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startOpenAIGateway } = require('../desktop/openai-gateway.cjs');
const { transcriptUsage } = require('../desktop/transcript-usage.cjs');
const { createOpenAIUsageUpdater } = require('../desktop/openai-usage.cjs');

for (const protocol of ['openai-chat', 'openai-responses']) test(`${protocol} carries late cache usage across real HTTP SSE`, async t => {
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (protocol === 'openai-chat') {
      emit({ choices: [{ index: 0, delta: { content: 'cache fixture' }, finish_reason: 'stop' }] });
      emit({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } } });
      res.end('data: [DONE]\n\n');
    } else {
      emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'cache fixture' });
      emit({ type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 800 } } } });
      res.end();
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = await startOpenAIGateway({ upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, protocol, apiKey: 'fixture-only' });
  t.after(async () => { await gateway.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const response = await fetch(gateway.baseUrl + '/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'fixture', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(response.status, 200);
  const message = await response.json();
  assert.deepEqual(message.usage, { input_tokens: 200, output_tokens: 10, cache_read_input_tokens: 800 });
  const entries = [{ type: 'assistant', message }, { type: 'assistant', message: { ...message, content: [{ type: 'text', text: 'duplicate block' }] } }];
  const mapper = require('../desktop/ccb-events.cjs').createCcbTranscriptMapper({ sessionId: 'usage-fixture' });
  for (const [index, frame] of entries.entries()) mapper.apply({ ...frame, uuid: `row-${index}` });
  assert.equal(mapper.entries[0].message.id, message.id);
  assert.deepEqual(transcriptUsage(mapper.entries), transcriptUsage(entries));
  assert.deepEqual(transcriptUsage(entries), { inputTokens: 200, outputTokens: 10, cacheReadInputTokens: 800, cacheCreationInputTokens: 0, cacheReadTokens: 800, cacheWriteTokens: 0 });
});

test('real CCB ordering uses per-turn result usage instead of early zero or cumulative modelUsage', () => {
  const mapper = require('../desktop/ccb-events.cjs').createCcbTranscriptMapper({ sessionId: 'real-order' });
  const all = [];
  for (const [index, input] of [25270, 25083].entries()) {
    mapper.apply({ type: 'assistant', uuid: `assistant-${index}`, message: { id: `msg-${index}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 0, output_tokens: 0 } } });
    mapper.apply({ type: 'result', uuid: `result-${index}`, usage: { input_tokens: input, output_tokens: index ? 21 : 5, cache_read_input_tokens: index ? 800 : 0 }, modelUsage: { glm: { inputTokens: index ? 50353 : 25270 } } });
    all.push(...mapper.entries); mapper.resetTurn();
  }
  assert.deepEqual(transcriptUsage(all), { inputTokens: 50353, outputTokens: 26, cacheReadInputTokens: 800, cacheCreationInputTokens: 0, cacheReadTokens: 800, cacheWriteTokens: 0 });
});

test('same mapper accounts consecutive results and tool rounds without relabeling prior turns', () => {
  const mapper = require('../desktop/ccb-events.cjs').createCcbTranscriptMapper({ sessionId: 'same-mapper' });
  const assistant = (id, content) => ({ type: 'assistant', uuid: id, message: { id, role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 }, content } });
  mapper.apply(assistant('first', [{ type: 'text', text: 'one' }]));
  mapper.apply({ type: 'result', session_id: 'same-mapper', num_turns: 1, duration_ms: 10, usage: { input_tokens: 100, output_tokens: 2 } });
  const originalTurn = mapper.entries[0].ccdUsageTurnId;
  mapper.apply(assistant('tool', [{ type: 'tool_use', id: 'call', name: 'Read', input: {} }]));
  mapper.apply({ type: 'user', uuid: 'tool-result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }] } });
  mapper.apply(assistant('second', [{ type: 'text', text: 'two' }]));
  const result = { type: 'result', session_id: 'same-mapper', num_turns: 2, duration_ms: 20, usage: { input_tokens: 200, output_tokens: 4, cache_read_input_tokens: 50 } };
  mapper.apply(result); mapper.apply(result);
  assert.equal(mapper.entries[0].ccdUsageTurnId, originalTurn);
  assert.deepEqual(transcriptUsage(mapper.entries), { inputTokens: 300, outputTokens: 6, cacheReadInputTokens: 50, cacheCreationInputTokens: 0, cacheReadTokens: 50, cacheWriteTokens: 0 });
});

test('partial usage preserves totals and explicit zero, missing cache stays unknown', () => {
  const usage = { input_tokens: 0, output_tokens: 0 }, update = createOpenAIUsageUpdater(usage);
  update({ prompt_tokens: 1000 }); update({ prompt_tokens_details: { cached_tokens: 800 } }); update({ completion_tokens: 10 });
  assert.deepEqual(usage, { input_tokens: 200, output_tokens: 10, cache_read_input_tokens: 800 });
  update({ prompt_tokens_details: { cached_tokens: 0 } }); assert.equal(usage.input_tokens, 1000); assert.equal(usage.cache_read_input_tokens, 0);
  const unknown = {}; createOpenAIUsageUpdater(unknown)({ prompt_tokens: 100, completion_tokens: 2 });
  assert.deepEqual(unknown, { input_tokens: 100, output_tokens: 2 });
});
