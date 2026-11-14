import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { prepareCcbRuntime } = require('../desktop/ccb-runtime-config.cjs');

test('standard CCB gateways keep their original transport', async () => {
  const env = { ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: 'test-secret' };
  const runtime = await prepareCcbRuntime({ env, startGateway: () => assert.fail('unexpected adapter') });
  assert.match(runtime.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, 'test-secret');
  assert.equal(runtime.adapter, 'anthropic-effort');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://example.invalid');
  assert.notEqual(runtime.env, env);
  await runtime.stop();
});

test('system-first transport is child-local and owns its shutdown', async () => {
  const env = { CLAUDE_CCB_GATEWAY_ADAPTER: 'system-first', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3000', ANTHROPIC_API_KEY: 'test-secret' };
  let stopped = 0;
  const runtime = await prepareCcbRuntime({ env, startGateway: async options => {
    assert.equal(options.upstreamBaseUrl, env.ANTHROPIC_BASE_URL);
    assert.equal(typeof options.capabilityProfile, 'function');
    return { baseUrl: 'http://127.0.0.1:1234', stop: async () => stopped++ };
  } });
  assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234');
  assert.equal(runtime.env.ANTHROPIC_API_KEY, 'test-secret');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3000');
  await runtime.stop();
  assert.equal(stopped, 1);
});

test('runtime system-first passes selected model capabilities through the actual gateway', async t => {
  const bodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: fixture\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const gateway = { baseUrl, apiType: 'anthropic', raw: { inferenceModelCapabilities: { known: { supportedEfforts: ['high'] } } } };
  const runtime = await prepareCcbRuntime({ env: { ANTHROPIC_BASE_URL: baseUrl, CLAUDE_CCB_GATEWAY_ADAPTER: 'system-first' }, gateway });
  t.after(() => runtime.stop());
  const post = model => fetch(`${runtime.env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, system: 'sys', messages: [], output_config: { effort: 'high' } }),
  });
  assert.equal((await post('known')).status, 200);
  assert.equal(bodies[0].output_config.effort, 'high');
  assert.equal(bodies[0].messages[0].role, 'system');
  assert.equal((await post('unknown')).status, 200);
  assert.equal(bodies[1].output_config, undefined);
});

test('runtime profiles do not share model windows across gateways or overrides', async t => {
  const startGateway = async () => ({ baseUrl: 'http://127.0.0.1:4444', stop: async () => {} });
  const make = (baseUrl, contextWindow) => ({ baseUrl, apiKey: 'secret', apiType: 'anthropic', raw: {
    inferenceModels: [{ id: 'same', contextWindow }, { id: 'invalid', contextWindow: -1 }],
  } });
  const a = make('https://a.invalid', 10000);
  const b = make('https://b.invalid', 20000);
  const env = { CLAUDE_CCB_GATEWAY_ADAPTER: 'system-first' };
  const one = await prepareCcbRuntime({ env, gateway: a, startGateway });
  const two = await prepareCcbRuntime({ env, gateway: b, startGateway });
  const mismatch = await prepareCcbRuntime({ env: { ...env, ANTHROPIC_BASE_URL: b.baseUrl }, gateway: a, startGateway });
  t.after(async () => { await one.stop(); await two.stop(); await mismatch.stop(); });
  assert.deepEqual(one.contextWindows(one.env), [{ model: 'same', contextWindow: 10000 }]);
  assert.deepEqual(two.contextWindows(two.env), [{ model: 'same', contextWindow: 20000 }]);
  assert.deepEqual(mismatch.contextWindows(mismatch.env), []);
  assert.deepEqual(one.contextWindows({ ...one.env, ANTHROPIC_AUTH_TOKEN: 'other' }), []);
  assert.deepEqual(one.contextWindows({ ...one.env, ANTHROPIC_BASE_URL: 'https://b.invalid' }), []);
});

test('invalid adapter configuration and listen failures are explicit', async () => {
  await assert.rejects(prepareCcbRuntime({ env: { CLAUDE_CCB_GATEWAY_ADAPTER: 'unknown' } }), /Unsupported/);
  await assert.rejects(prepareCcbRuntime({ env: { CLAUDE_CCB_GATEWAY_ADAPTER: 'system-first' } }), /requires/);
  await assert.rejects(prepareCcbRuntime({ env: { CLAUDE_CCB_GATEWAY_ADAPTER: 'system-first', ANTHROPIC_BASE_URL: 'http://127.0.0.1' }, startGateway: async () => { throw new Error('listen failed'); } }), /listen failed/);
});
