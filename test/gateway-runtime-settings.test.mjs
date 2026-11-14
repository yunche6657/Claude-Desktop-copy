import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveGatewayRuntimeSettings, validateGatewayRuntimeConfig, normalizeBaseUrl } = require('../desktop/gateway-runtime-settings.cjs');
const { prepareCcbRuntime } = require('../desktop/ccb-runtime-config.cjs');

function fixture(t, rules) {
  const root = path.resolve('.tmp/gateway-runtime-tests');
  fs.mkdirSync(root, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.data'));
  const file = path.join(workspace, '.data', 'gateway-runtime.json');
  if (rules !== undefined) fs.writeFileSync(file, JSON.stringify(rules));
  return { workspace, file };
}
const rule = { baseURL: 'http://127.0.0.1:8080/v1', model: 'test-model', adapter: 'system-first', systemContextPrefix: 'System context:\n' };
const config = rules => ({ version: 1, rules });

test('exported pure validator returns normalized rules and rejects unknown fields without mutating input', () => {
  const input = config([{ ...rule, baseURL: 'HTTP://Example.COM:80/v1/' }]);
  const before = structuredClone(input);
  assert.deepEqual(validateGatewayRuntimeConfig(input), [{ ...rule, baseURL: 'http://example.com/v1' }]);
  assert.deepEqual(input, before);
  assert.throws(() => validateGatewayRuntimeConfig(config([{ ...rule, apiKey: 'fixture-only' }])), /Invalid/);
  assert.throws(() => validateGatewayRuntimeConfig({ ...input, extra: 'fixture-only' }), /Invalid/);
});

test('matching workspace rule starts adapter against actual selected upstream without changing parent', async t => {
  const { workspace } = fixture(t, config([rule]));
  const env = { CLAUDE_WORKSPACE: workspace, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080/v1/', CLAUDE_AGENT_MODEL: 'test-model', ANTHROPIC_API_KEY: 'fixture-key' };
  let stopped = 0;
  const runtime = await prepareCcbRuntime({ env, startGateway: async options => {
    assert.deepEqual(options, { upstreamBaseUrl: env.ANTHROPIC_BASE_URL, systemContextPrefix: 'System context:\n' });
    return { baseUrl: 'http://127.0.0.1:2345', stop: async () => stopped++ };
  } });
  assert.equal(runtime.source, 'workspace');
  assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:2345');
  assert.equal(runtime.env.ANTHROPIC_API_KEY, 'fixture-key');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8080/v1/');
  await runtime.stop(); assert.equal(stopped, 1);
});

test('URL and model must match exactly after URL normalization', t => {
  const { workspace } = fixture(t, config([rule]));
  for (const [base, model] of [['http://localhost:8080/v1','test-model'], ['http://127.0.0.1:8080/v1','other-model'], ['https://127.0.0.1:8080/v1','test-model']]) {
    assert.equal(resolveGatewayRuntimeSettings({ env: { CLAUDE_WORKSPACE: workspace, ANTHROPIC_BASE_URL: base, CLAUDE_AGENT_MODEL: model } }).adapter, 'none');
  }
  assert.equal(normalizeBaseUrl('HTTP://Example.COM:80/v1/'), 'http://example.com/v1');
  for (const base of ['http://user:pass@example.com', 'http://example.com/?x=1', 'http://example.com/#hash', 'file:///tmp/x', 'http://example.com/?']) assert.throws(() => normalizeBaseUrl(base), /Invalid/);
});

test('unknown model uses only a unique URL rule; ambiguity fails and does not borrow other gateway model', async t => {
  const { workspace, file } = fixture(t, config([rule]));
  const env = { CLAUDE_WORKSPACE: workspace, ANTHROPIC_BASE_URL: rule.baseURL };
  const settings = resolveGatewayRuntimeSettings({ env, gateway: { baseUrl: 'https://other.invalid', model: 'other-model' } });
  assert.equal(settings.model, 'test-model');
  const runtime = await prepareCcbRuntime({ env, startGateway: async () => ({ baseUrl: 'http://localhost:1', stop: async () => {} }) });
  assert.equal(runtime.env.CLAUDE_AGENT_MODEL, 'test-model');
  assert.equal(env.CLAUDE_AGENT_MODEL, undefined);
  fs.writeFileSync(file, JSON.stringify(config([rule, { ...rule, model: 'another' }])));
  assert.throws(() => resolveGatewayRuntimeSettings({ env }), /Ambiguous/);
});

test('explicit adapter and prefix overrides are authoritative', t => {
  const { workspace } = fixture(t, config([rule]));
  const env = { CLAUDE_WORKSPACE: workspace, ANTHROPIC_BASE_URL: rule.baseURL, CLAUDE_AGENT_MODEL: rule.model, CLAUDE_CCB_GATEWAY_ADAPTER: 'none' };
  assert.equal(resolveGatewayRuntimeSettings({ env }).adapter, 'none');
  assert.equal(resolveGatewayRuntimeSettings({ env }).source, 'environment');
  delete env.CLAUDE_CCB_GATEWAY_ADAPTER;
  env.CLAUDE_CCB_GATEWAY_SYSTEM_PREFIX = 'custom';
  assert.equal(resolveGatewayRuntimeSettings({ env }).systemContextPrefix, 'custom');
  assert.equal(resolveGatewayRuntimeSettings({ env }).source, 'environment');
});

test('deployment fallback is restricted to the actual packaged app and never overrides an existing workspace file', async t => {
  const { workspace, file } = fixture(t);
  const resourcesPath = path.join(workspace, 'resources');
  fs.mkdirSync(resourcesPath);
  fs.writeFileSync(path.join(resourcesPath, 'gateway-runtime.json'), JSON.stringify(config([rule])));
  const env = { CLAUDE_WORKSPACE: workspace, ANTHROPIC_BASE_URL: rule.baseURL, CLAUDE_AGENT_MODEL: rule.model };
  const options = { env, resourcesPath, appRoot: path.join(resourcesPath, 'app.asar') };
  assert.equal(resolveGatewayRuntimeSettings(options).source, 'deployment');
  assert.equal(resolveGatewayRuntimeSettings({ ...options, appRoot: path.join(resourcesPath, 'app') }).adapter, 'system-first');
  assert.equal(resolveGatewayRuntimeSettings({ ...options, appRoot: workspace }).adapter, 'none');
  assert.equal(resolveGatewayRuntimeSettings({ ...options, appRoot: path.join(resourcesPath, 'app.asar', 'nested') }).adapter, 'none');
  const runtime = await prepareCcbRuntime({ ...options, startGateway: async ({ upstreamBaseUrl }) => {
    assert.equal(upstreamBaseUrl, rule.baseURL);
    return { baseUrl: 'http://127.0.0.1:1234', stop: async () => {} };
  } });
  assert.equal(runtime.source, 'deployment');
  assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234');
  fs.writeFileSync(file, JSON.stringify(config([])));
  assert.equal(resolveGatewayRuntimeSettings(options).adapter, 'none');
  fs.writeFileSync(file, '{');
  assert.throws(() => resolveGatewayRuntimeSettings(options), /JSON/);
  fs.rmSync(file);
  fs.writeFileSync(path.join(resourcesPath, 'gateway-runtime.json'), '{');
  assert.throws(() => resolveGatewayRuntimeSettings(options), /JSON/);
});

test('unknown fields, secrets, invalid modes, duplicate rules and oversized prefix fail explicitly', t => {
  const { workspace, file } = fixture(t);
  const env = { CLAUDE_WORKSPACE: workspace, ANTHROPIC_BASE_URL: rule.baseURL, CLAUDE_AGENT_MODEL: rule.model };
  const invalid = [config([{ ...rule, apiKey: 'fixture-only' }]), config([{ ...rule, adapter: 'rewrite-everything' }]), config([{ ...rule, systemContextPrefix: 'x'.repeat(129) }]), config([rule, rule]), { ...config([]), token: 'fixture-only' }, { version: 2, rules: [] }];
  for (const value of invalid) { fs.writeFileSync(file, JSON.stringify(value)); assert.throws(() => resolveGatewayRuntimeSettings({ env })); }
  fs.writeFileSync(file, '{'); assert.throws(() => resolveGatewayRuntimeSettings({ env }), /JSON/);
  fs.rmSync(file); fs.mkdirSync(file); assert.throws(() => resolveGatewayRuntimeSettings({ env }), /Cannot read/);
});
