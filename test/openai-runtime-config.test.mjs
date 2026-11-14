import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { prepareCcbRuntime } = require('../desktop/ccb-runtime-config.cjs');
const { normaliseProfile, resolveGateway } = require('../desktop/gateway-source.cjs');

function fixture(t, apiType = 'openai-chat') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'local', 'Claude-3p', 'configLibrary');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, '_meta.json'), JSON.stringify({ appliedId: 'current' }));
  fs.writeFileSync(path.join(library, 'current.json'), JSON.stringify({ inferenceGatewayBaseUrl: 'https://provider.invalid/v1', inferenceGatewayApiKey: 'fixture-key', inferenceApiType: apiType, model: 'fixture-model' }));
  return { LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming'), USERPROFILE: root, CLAUDE_WORKSPACE: root };
}

for (const protocol of ['anthropic', 'openai-chat', 'openai-responses']) {
  test(`normaliseProfile retains ${protocol}`, () => {
    assert.equal(normaliseProfile({ inferenceApiType: protocol }).apiType, protocol);
  });
}
test('explicit selected model outranks model catalogue order', () => {
  assert.equal(normaliseProfile({ model: 'selected', inferenceModels: ['glm-first', 'selected'] }).model, 'selected');
  assert.equal(normaliseProfile({ defaultModel: 'default-selected', inferenceModels: [{ id: 'glm-first' }] }).model, 'default-selected');
  assert.equal(normaliseProfile({ inferenceModels: [{ id: 'fallback' }] }).model, 'fallback');
});

test('legacy profiles use anthropic and unknown protocols fail explicitly', () => {
  assert.equal(normaliseProfile({}).apiType, 'anthropic');
  assert.throws(() => normaliseProfile({ inferenceApiType: 'openai' }), /Unsupported inferenceApiType/);
});

for (const protocol of ['openai-chat', 'openai-responses']) {
  test(`default startup resolves applied ${protocol} profile and owns child transport`, async t => {
    const env = fixture(t, protocol);
    const original = { ...env };
    let stopped = 0;
    assert.equal(resolveGateway({ env }).apiType, protocol);
    const runtime = await prepareCcbRuntime({ env, startOpenAIGateway: async options => {
      assert.equal(typeof options.capabilityProfile, 'function');
      const { capabilityProfile, ...transport } = options;
      assert.deepEqual(transport, { upstreamBaseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-key', protocol });
      return { baseUrl: 'http://127.0.0.1:3456', authToken: 'local-token', stop: async () => stopped++ };
    }, startGateway: () => assert.fail('unexpected system-first gateway') });
    assert.equal(runtime.adapter, protocol);
    assert.equal(runtime.source, 'configLibrary');
    assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
    assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, 'local-token');
    assert.equal(runtime.env.CLAUDE_AGENT_MODEL, 'fixture-model');
    assert.deepEqual(env, original);
    await runtime.stop();
    assert.equal(stopped, 1);
  });
}

test('different environment base does not borrow profile protocol, key or model', async t => {
  const env = { ...fixture(t), ANTHROPIC_BASE_URL: 'https://different.invalid/v1' };
  const runtime = await prepareCcbRuntime({ env, startOpenAIGateway: () => assert.fail('stale profile protocol'), startGateway: () => assert.fail('unexpected gateway') });
  assert.equal(runtime.adapter, 'anthropic-effort');
  assert.match(runtime.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(runtime.env.CLAUDE_AGENT_MODEL, undefined);
  await runtime.stop();
});

test('different environment base with explicit protocol uses only environment credentials', async t => {
  const env = { ...fixture(t), ANTHROPIC_BASE_URL: 'https://different.invalid/v1', ANTHROPIC_API_TYPE: 'openai-responses' };
  const runtime = await prepareCcbRuntime({ env, startOpenAIGateway: async options => {
    assert.equal(typeof options.capabilityProfile, 'function');
      const { capabilityProfile, ...transport } = options;
      assert.deepEqual(transport, { upstreamBaseUrl: env.ANTHROPIC_BASE_URL, apiKey: '', protocol: 'openai-responses' });
    return { baseUrl: 'http://127.0.0.1:3456', stop: async () => {} };
  } });
  assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(runtime.env.CLAUDE_AGENT_MODEL, undefined);
  assert.equal(runtime.source, 'environment');
});

test('same normalized environment base permits profile protocol and environment key/model overrides', async t => {
  const env = { ...fixture(t), ANTHROPIC_BASE_URL: 'https://PROVIDER.invalid:443/v1/', ANTHROPIC_API_KEY: 'override-key', ANTHROPIC_MODEL: 'override-model' };
  const runtime = await prepareCcbRuntime({ env, startOpenAIGateway: async options => {
    assert.equal(typeof options.capabilityProfile, 'function');
      const { capabilityProfile, ...transport } = options;
      assert.deepEqual(transport, { upstreamBaseUrl: env.ANTHROPIC_BASE_URL, apiKey: 'override-key', protocol: 'openai-chat' });
    return { baseUrl: 'http://127.0.0.1:3456', stop: async () => {} };
  } });
  assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, 'override-key');
  assert.equal(runtime.env.ANTHROPIC_MODEL, 'override-model');
  assert.equal(runtime.env.CLAUDE_AGENT_MODEL, undefined);
});

test('explicit existing adapter override remains authoritative for OpenAI profiles', async t => {
  const env = { ...fixture(t), CLAUDE_CCB_GATEWAY_ADAPTER: 'none' };
  const runtime = await prepareCcbRuntime({ env, startOpenAIGateway: () => assert.fail('adapter disabled') });
  assert.equal(runtime.adapter, 'none');
  assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'https://provider.invalid/v1');
  env.CLAUDE_CCB_GATEWAY_ADAPTER = 'system-first';
  const adapted = await prepareCcbRuntime({ env, startGateway: async options => {
    assert.equal(options.upstreamBaseUrl, 'https://provider.invalid/v1');
    return { baseUrl: 'http://127.0.0.1:3456', stop: async () => {} };
  }, startOpenAIGateway: () => assert.fail('system-first override') });
  assert.equal(adapted.adapter, 'system-first');
});

test('OpenAI gateway startup errors propagate', async t => {
  const env = fixture(t);
  await assert.rejects(prepareCcbRuntime({ env, startOpenAIGateway: async () => { throw new Error('listen failed'); } }), /listen failed/);
});
