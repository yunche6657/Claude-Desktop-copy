import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startCcbGateway, rewriteMessageRequest, upstreamTarget } = require('../desktop/ccb-gateway.cjs');

async function fixture(t, handle, options = {}) {
  const upstream = http.createServer(handle);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const gateway = await startCcbGateway({ upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, ...options });
  t.after(() => gateway.stop());
  return gateway;
}
const body = { model: 'test-model', stream: true, system: 'instruction', messages: [{ role: 'user', content: 'hi' }] };
function post(url, value = body, extra = {}) {
  return new Promise((resolve, reject) => {
    const bytes = typeof value === 'string' ? value : JSON.stringify(value);
    const req = http.request(url, { method: 'POST', ...extra }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(parts) }));
      response.once('error', reject);
    });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('test request timeout')));
    req.end(bytes);
  });
}

test('system blocks and messages survive rewrite without mutating caller', () => {
  const value = { ...body, system: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }], tools: [{ name: 'Read' }] };
  const before = JSON.stringify(value);
  const rewritten = rewriteMessageRequest(value);
  assert.equal(JSON.stringify(value), before);
  assert.equal(rewritten.system, undefined);
  assert.deepEqual(rewritten.messages[0], { role: 'system', content: value.system });
  assert.deepEqual(rewritten.tools, value.tools);
  assert.equal(rewritten.messages[1], value.messages[0]);
  assert.equal(rewriteMessageRequest({ stream: true, messages: [] }).messages[0].content, '');
  assert.deepEqual(rewriteMessageRequest({ ...body, messages: [{ role: 'system', content: 'existing' }] }).messages[0].content,
    [{ type: 'text', text: 'instruction' }, { type: 'text', text: 'existing' }]);
});

test('upstream path preserves beta query and avoids duplicate v1', () => {
  for (const base of ['https://example.test', 'https://example.test/v1', 'https://example.test/v1/'])
    assert.equal(String(upstreamTarget(base, '/v1/messages?beta=true&x=2')), 'https://example.test/v1/messages?beta=true&x=2');
  assert.equal(upstreamTarget('https://example.test/prefix/v1', '/v1/messages').pathname, '/prefix/v1/messages');
  assert.throws(() => upstreamTarget('https://user:secret@example.test', '/v1/messages'));
});

test('streams exact SSE bytes incrementally, forwards auth and rewrites JSON', async t => {
  const first = Buffer.from('event: message_start\ndata: {"type":"message_start"}\n\n');
  const last = Buffer.from('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  let observed;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gateway = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(first);
    await gate;
    res.end(last);
  });
  await new Promise((resolve, reject) => {
    const req = http.request(`${gateway.baseUrl}/v1/messages?beta=true`, { method: 'POST', headers: { 'x-api-key': 'synthetic-test-key', 'anthropic-beta': 'test-beta' } }, res => {
      const pieces = [];
      res.on('data', chunk => { pieces.push(chunk); if (Buffer.concat(pieces).length >= first.length) release(); });
      res.once('end', () => { try { assert.deepEqual(Buffer.concat(pieces), Buffer.concat([first, last])); resolve(); } catch (e) { reject(e); } });
      res.once('error', reject);
    });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('incremental stream blocked')));
    req.end(JSON.stringify(body));
  });
  assert.equal(observed.url, '/v1/messages?beta=true');
  assert.equal(observed.headers['x-api-key'], 'synthetic-test-key');
  assert.equal(observed.headers['anthropic-beta'], 'test-beta');
  assert.equal(observed.body.messages[0].role, 'system');
  assert.equal(observed.body.system, undefined);
});

test('system-first applies current per-model effort capabilities before forwarding', async t => {
  const seen = [];
  let profile = { inferenceModelCapabilities: { known: { supportedEfforts: ['low', 'high'] } } };
  const gateway = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: fixture\n\n');
  }, { capabilityProfile: () => profile, systemContextPrefix: 'prefix: ' });
  const url = `${gateway.baseUrl}/v1/messages`;
  const request = { ...body, model: 'unknown', output_config: { effort: 'high', format: { type: 'json_schema' } } };
  assert.equal((await post(url, request)).status, 200);
  assert.deepEqual(seen[0].output_config, { format: { type: 'json_schema' } });
  assert.equal(seen[0].messages[0].content, 'prefix: instruction');
  assert.equal((await post(url, { ...request, model: 'known', output_config: { effort: 'medium' } })).status, 400);
  assert.equal(seen.length, 1);
  assert.equal((await post(url, { ...request, model: 'known' })).status, 200);
  assert.equal(seen[1].output_config.effort, 'high');
  profile = { inferenceModelCapabilities: { known: { supportedEfforts: [] } } };
  assert.equal((await post(url, { ...request, model: 'known' })).status, 200);
  assert.deepEqual(seen[2].output_config, { format: { type: 'json_schema' } });
});

test('invalid stream option, malformed JSON, other paths, method and oversized body never reach upstream', async t => {
  let calls = 0;
  const gateway = await fixture(t, (req, res) => { calls++; res.end(); }, { maxBodyBytes: 1024 });
  assert.equal((await post(`${gateway.baseUrl}/v1/messages`, { ...body, stream: null })).status, 400);
  assert.equal((await post(`${gateway.baseUrl}/v1/messages`, '{')).status, 400);
  assert.equal((await post(`${gateway.baseUrl}/v1/other`)).status, 404);
  assert.equal((await post(`${gateway.baseUrl}/v1/messages`, body, { method: 'GET' })).status, 405);
  assert.equal((await post(`${gateway.baseUrl}/v1/messages`, 'x'.repeat(1025))).status, 413);
  assert.equal(calls, 0);
});

test('upstream error status and body pass through unchanged', async t => {
  const gateway = await fixture(t, (req, res) => { req.resume(); res.writeHead(429, { 'retry-after': '9', 'content-type': 'application/json' }); res.end('{"error":"limited"}'); });
  const result = await post(`${gateway.baseUrl}/v1/messages`);
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '9');
  assert.equal(result.bytes.toString(), '{"error":"limited"}');
});

test('downstream disconnect aborts live upstream stream', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const gateway = await fixture(t, (req, res) => {
    req.resume();
    res.once('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  });
  await new Promise((resolve, reject) => {
    const req = http.request(`${gateway.baseUrl}/v1/messages`, { method: 'POST' }, res => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.once('error', reject);
    req.end(JSON.stringify(body));
  });
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('upstream did not abort')), 1500); timer.unref(); })]);
});

test('timeout aborts upstream and returns explicit adapter status', async t => {
  const gateway = await fixture(t, req => req.resume(), { timeoutMs: 30 });
  assert.equal((await post(`${gateway.baseUrl}/v1/messages`)).status, 504);
});

test('truncated upstream SSE fails the downstream body instead of claiming clean completion', async t => {
  const gateway = await fixture(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial\n\n');
    setTimeout(() => res.destroy(), 15);
  });
  await assert.rejects(post(`${gateway.baseUrl}/v1/messages`));
});

test('stop aborts in-flight requests, is idempotent, and releases listener', async t => {
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const gateway = await fixture(t, (req, res) => { req.resume(); res.write('data: first\n\n'); started(); });
  const request = post(`${gateway.baseUrl}/v1/messages`).catch(() => null);
  await start;
  const first = gateway.stop();
  assert.equal(gateway.stop(), first);
  await first;
  await request;
  await assert.rejects(post(`${gateway.baseUrl}/v1/messages`));
});

test('refuses nonloopback listeners and propagates bind failures', async t => {
  await assert.rejects(startCcbGateway({ upstreamBaseUrl: 'http://localhost:1', host: '0.0.0.0' }), /loopback/);
  const blocker = http.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  await assert.rejects(startCcbGateway({ upstreamBaseUrl: 'http://localhost:1', port: blocker.address().port }), { code: 'EADDRINUSE' });
});

const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const messageStart = { type: 'message_start', message: { type: 'message', id: 'msg_fixture', role: 'assistant',
  model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } };
const messageEvents = [messageStart,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply-fixture' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' }];

test('nonstream and omitted stream request true upstream but return standard JSON after complete SSE', async t => {
  const observed = [];
  const gateway = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed.push({ body: JSON.parse(Buffer.concat(chunks)), encoding: req.headers['accept-encoding'] });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'fixture-request' });
    for (const value of messageEvents) res.write(event(value));
    res.end();
  });
  for (const stream of [false, undefined]) {
    const result = await post(`${gateway.baseUrl}/v1/messages`, { ...body, stream });
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.equal(Number(result.headers['content-length']), result.bytes.length);
    assert.equal(result.headers['request-id'], 'fixture-request');
    const message = JSON.parse(result.bytes);
    assert.equal(message.id, 'msg_fixture');
    assert.equal(message.content[0].text, 'reply-fixture');
    assert.equal(message.stop_reason, 'end_turn');
    assert.deepEqual(message.usage, { input_tokens: 7, output_tokens: 5 });
  }
  assert.equal(observed.length, 2);
  assert.ok(observed.every(request => request.body.stream === true && request.body.messages[0].role === 'system' && request.encoding === 'identity'));
});

test('nonstream cannot synthesize a success from startless, truncated or error SSE', async t => {
  let current;
  const gateway = await fixture(t, (req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(current); });
  for (const [frames, code] of [
    [[messageEvents[4], messageEvents[5]], 'missing_message_start'],
    [[messageStart], 'missing_message_stop'],
    [[messageStart, { type: 'error', error: { type: 'overloaded_error', message: 'synthetic' } }], 'upstream_error_event'],
  ]) {
    current = frames.map(event).join('');
    const result = await post(`${gateway.baseUrl}/v1/messages`, { ...body, stream: false });
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.bytes).error.message, code);
    assert.equal(result.bytes.includes(Buffer.from('synthetic')), false);
  }
});

test('nonstream timeout and response-byte limit return explicit errors without partial JSON', async t => {
  const slow = await fixture(t, (req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(event(messageStart)); }, { timeoutMs: 30 });
  const timeout = await post(`${slow.baseUrl}/v1/messages`, { ...body, stream: false });
  assert.equal(timeout.status, 504);
  assert.equal(JSON.parse(timeout.bytes).error.message, 'upstream_timeout');
  const large = await fixture(t, (req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(messageEvents.map(event).join('')); }, { maxResponseBytes: 30 });
  const result = await post(`${large.baseUrl}/v1/messages`, { ...body, stream: false });
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.bytes).error.message, 'sse_response_too_large');
});

test('nonstream downstream cancellation aborts upstream before aggregated headers are sent', async t => {
  let upstreamStarted;
  const started = new Promise(resolve => { upstreamStarted = resolve; });
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const gateway = await fixture(t, (req, res) => {
    req.resume(); res.once('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(event(messageStart));
    upstreamStarted();
  });
  const req = http.request(`${gateway.baseUrl}/v1/messages`, { method: 'POST' });
  req.on('error', () => {});
  req.end(JSON.stringify({ ...body, stream: false }));
  await started;
  req.destroy();
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('nonstream upstream not cancelled')), 1500); timer.unref(); })]);
});

test('nonstream HTTP errors still pass through and invalid success MIME does not masquerade as Message JSON', async t => {
  let status = 429;
  const gateway = await fixture(t, (req, res) => { req.resume(); res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"limited"}'); });
  const error = await post(`${gateway.baseUrl}/v1/messages`, { ...body, stream: false });
  assert.equal(error.status, 429);
  assert.equal(error.bytes.toString(), '{"error":"limited"}');
  status = 200;
  const invalid = await post(`${gateway.baseUrl}/v1/messages`, { ...body, stream: false });
  assert.equal(invalid.status, 502);
  assert.equal(JSON.parse(invalid.bytes).error.message, 'upstream_not_event_stream');
});


test('explicit context prefix preserves every system byte, cache block and tool without mutating input', () => {
  const input = { ...body, system: [{type:'text',text:'native header',cache_control:{type:'ephemeral'}}, {type:'text',text:'complete system prompt'}], tools:[{name:'Read'}] };
  const before = structuredClone(input);
  const output = rewriteMessageRequest(input, 'System context:\n');
  assert.equal(output.messages[0].content[0].text, 'System context:\nnative header');
  assert.deepEqual(output.messages[0].content.slice(1), input.system.slice(1));
  assert.deepEqual(output.messages[0].content[0].cache_control, input.system[0].cache_control);
  assert.deepEqual(output.tools, input.tools);
  assert.deepEqual(input, before);
  assert.deepEqual(rewriteMessageRequest(input).messages[0].content, input.system);
  assert.throws(() => rewriteMessageRequest(input, 'x'.repeat(129)), /prefix/);
});
