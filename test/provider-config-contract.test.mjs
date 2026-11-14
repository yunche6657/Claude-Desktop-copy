import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const require = createRequire(import.meta.url);
const { normalizeProviderConfig, providerConfigIssues } = require('../desktop/provider-config-contract.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

const sample = () => ({ inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'https://example.invalid/v1', inferenceGatewayApiKey: 'fixture-secret', inferenceApiType: 'openai-chat', inferenceModels: [{ id: 'model-a', supports1m: true }], customField: { untouched: true } });
function bridge(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-contract-'));
  const id = 'a394db4e-023a-4e0f-b4b1-4d28cad74fea';
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ entries: [{ id, name: 'Fixture' }], appliedId: id }));
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(config));
  const previous = process.env.CLAUDE_RECONSTRUCTION_CONFIG_DIR;
  process.env.CLAUDE_RECONSTRUCTION_CONFIG_DIR = dir;
  const handlers = new Map();
  const kernel = createSessionKernel({ emit() {}, createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }) });
  registerBridgeServices({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) }, bridgeMap: require('../desktop/shim/bridge-map.json'), getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }), settings: { kernelFactory: () => kernel }, frontend: { root: process.cwd() } });
  return { id, file, call(method, ...args) { const channel = [...handlers.keys()].find(channel => channel.includes('_$_Custom3pSetup_$_') && channel.endsWith(`_$_${method}`)); assert.ok(channel); return handlers.get(channel)({}, ...args); }, restore() { if (previous === undefined) delete process.env.CLAUDE_RECONSTRUCTION_CONFIG_DIR; else process.env.CLAUDE_RECONSTRUCTION_CONFIG_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('model migration matches shipped name contract without changing credentials or metadata', () => {
  const original = sample();
  const normalized = normalizeProviderConfig(original);
  assert.deepEqual(normalized.inferenceModels, [{ name: 'model-a', supports1m: true }]);
  assert.equal(normalized.inferenceGatewayApiKey, original.inferenceGatewayApiKey);
  assert.deepEqual(normalized.customField, original.customField);
  assert.deepEqual(original.inferenceModels, [{ id: 'model-a', supports1m: true }]);
  assert.deepEqual(providerConfigIssues(normalized), []);
  assert.deepEqual(normalizeProviderConfig(normalized), normalized);
});

test('discovery identity survives normalization and valid name-only rows remain valid', () => {
  const original = { inferenceModels: [
    { id: ' remote ', name: 'Remote', contextWindow: 128000, capabilities: { supportedEfforts: ['high'] } },
    { name: ' name-only ' }, { id: ' ', name: ' fallback ' }, { model: 'legacy', name: 'Legacy label' },
  ] };
  const normalized = normalizeProviderConfig(original);
  assert.deepEqual(normalized.inferenceModels, [
    { name: 'remote', contextWindow: 128000, capabilities: { supportedEfforts: ['high'] } },
    { name: 'name-only' }, { name: 'fallback' }, { name: 'legacy' },
  ]);
  assert.deepEqual(providerConfigIssues(normalized), []);
  assert.deepEqual(normalizeProviderConfig(normalized), normalized);
  assert.equal(original.inferenceModels[0].id, ' remote ');
});

test('legacy model identity agrees with gateway resolution before and after migration', () => {
  const raw = { inferenceGatewayBaseUrl: 'https://fixture.test', inferenceModels: [
    { model: 'legacy-id', name: 'Display name', capabilities: { supportedEfforts: ['high'] } },
  ] };
  const normalize = require('../desktop/gateway-source.cjs').normaliseProfile;
  assert.equal(normalize(raw).model, 'legacy-id');
  const migrated = normalizeProviderConfig(raw);
  assert.equal(normalize(migrated).model, 'legacy-id');
  assert.deepEqual(require('../desktop/model-capabilities.cjs').resolveModelCapabilities('legacy-id', migrated).supportedEfforts, ['high']);
});

test('discovered row written through bridge retains model identity and context', async () => {
  const fixture = bridge(sample());
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/models');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'remote', name: 'Remote', context_window: 128000, supportedEfforts: ['high'] }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const discovery = await fixture.call('discoverModels', { baseUrl: `http://127.0.0.1:${server.address().port}`, apiType: 'openai-chat' });
    assert.equal(discovery.ok, true);
    const [discoveredRow] = discovery.models;
    assert.equal(discoveredRow.id, 'remote');
    assert.equal(discoveredRow.name, 'Remote');
    assert.equal((await fixture.call('writeConfig', fixture.id, { ...sample(), model: 'remote', inferenceModels: [discoveredRow] })).ok, true);
    const config = (await fixture.call('readConfig', fixture.id)).config;
    assert.deepEqual(config.inferenceModels, [{ name: 'remote', contextWindow: 128000, capabilities: { supportedEfforts: ['high'] } }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file)).inferenceModels, config.inferenceModels);
    assert.deepEqual(require('../desktop/model-capabilities.cjs').resolveModelCapabilities('remote', config), { supportedEfforts: ['high'], source: 'provider' });
    assert.equal(config.inferenceModels.find(row => row.name === config.model).contextWindow, 128000);
  } finally { await new Promise(resolve => server.close(resolve)); fixture.restore(); }
});

test('credential and API discriminators are validated without exposing their values', () => {
  const base = normalizeProviderConfig(sample());
  assert.ok(providerConfigIssues({ ...base, inferenceApiType: 'wrong' }).some(issue => issue.path === 'inferenceApiType'));
  assert.ok(providerConfigIssues({ ...base, inferenceCredentialKind: 'wrong' }).some(issue => issue.path === 'inferenceCredentialKind'));
  assert.ok(providerConfigIssues({ ...base, inferenceCredentialKind: 'helper-script' }).some(issue => issue.path === 'inferenceCredentialHelper'));
  assert.deepEqual(providerConfigIssues({ ...base, inferenceGatewayApiKey: undefined, inferenceCredentialKind: 'helper-script', inferenceCredentialHelper: '/fixture/helper' }), []);
  assert.deepEqual(providerConfigIssues({ ...base, inferenceGatewayApiKey: undefined, inferenceCredentialKind: 'interactive' }), []);
});

test('opening a legacy profile migrates disk and all read surfaces before renderer validation', async () => {
  const fixture = bridge(sample());
  try {
    const result = await fixture.call('readConfig', fixture.id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.inferenceModels, [{ name: 'model-a', supports1m: true }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file)).inferenceModels, result.config.inferenceModels);
    const merged = await fixture.call('getMergedConfig');
    assert.deepEqual(merged.inferenceModels, result.config.inferenceModels);
    assert.equal((await fixture.call('getConfigHealth')).state, 'healthy');
    assert.equal((await fixture.call('listConfigs')).appliedId, fixture.id);
  } finally { fixture.restore(); }
});

test('write roundtrip persists canonical model names and rejects malformed edits atomically', async () => {
  const fixture = bridge(sample());
  try {
    const edited = { ...sample(), inferenceModels: [{ id: 'model-b' }, 'model-c'] };
    assert.equal((await fixture.call('writeConfig', fixture.id, edited)).ok, true);
    const saved = JSON.parse(fs.readFileSync(fixture.file));
    assert.deepEqual(saved.inferenceModels, [{ name: 'model-b' }, 'model-c']);
    assert.equal(saved.inferenceGatewayApiKey, edited.inferenceGatewayApiKey);
    const previous = fs.readFileSync(fixture.file, 'utf8');
    for (const invalid of [{ ...edited, inferenceGatewayBaseUrl: 'file:///local' }, { ...edited, inferenceGatewayApiKey: '' }, { ...edited, inferenceModels: [{}] }]) {
      const result = await fixture.call('writeConfig', fixture.id, invalid);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'validation');
      assert.ok(result.issues.length);
      assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
      assert.equal(fs.readFileSync(fixture.file, 'utf8'), previous);
    }
  } finally { fixture.restore(); }
});

test('create follows the same canonical write contract', async () => {
  const fixture = bridge(sample());
  try {
    const result = await fixture.call('createConfig', { name: 'Second', config: sample() });
    assert.equal(result.ok, true);
    assert.deepEqual((await fixture.call('readConfig', result.id)).config.inferenceModels, [{ name: 'model-a', supports1m: true }]);
    const bad = await fixture.call('createConfig', { name: 'Bad', config: { ...sample(), inferenceGatewayBaseUrl: '' } });
    assert.equal(bad.ok, false);
    assert.equal((await fixture.call('listConfigs')).entries.length, 2);
  } finally { fixture.restore(); }
});

test('imported OAuth credentials pass health and write validation without a duplicated API key', async () => {
  const imported = require('../desktop/subscription-import.cjs').parseSubscription({ input: 'fixture-oauth-token' });
  const config = normalizeProviderConfig(imported.config);
  assert.deepEqual(providerConfigIssues(config), []);
  const fixture = bridge(config);
  try {
    assert.equal((await fixture.call('getConfigHealth')).state, 'healthy');
    assert.equal((await fixture.call('writeConfig', fixture.id, config)).ok, true);
    assert.equal((await fixture.call('readConfig', fixture.id)).config.credentials.accessToken, 'fixture-oauth-token');
  } finally { fixture.restore(); }
  assert.ok(providerConfigIssues({ ...config, credentials: { accessToken: ' ' } }).some(issue => issue.code === 'credential_required'));
});

test('nested gateway endpoint and API type use runtime precedence in health and writes', async () => {
  const config = { inferenceProvider: 'gateway', inferenceGatewayBaseUrl: ' ', inferenceApiType: ' ',
    credentials: { baseUrl: 'https://nested.fixture.test/v1', apiKey: 'fixture-nested', apiType: 'openai-chat' }, inferenceModels: ['m'] };
  assert.deepEqual(providerConfigIssues(config), []);
  const fixture = bridge(config);
  try {
    assert.equal((await fixture.call('getConfigHealth')).state, 'healthy');
    assert.equal((await fixture.call('writeConfig', fixture.id, config)).ok, true);
  } finally { fixture.restore(); }
  const invalid = { ...config, credentials: { ...config.credentials, apiType: 'invalid', baseUrl: 'file:///fixture' } };
  const issues = providerConfigIssues(invalid);
  assert.ok(issues.some(issue => issue.code === 'unsupported_api_type'));
  assert.ok(issues.some(issue => issue.code === 'http_url_required'));
  assert.equal(JSON.stringify(issues).includes('fixture-nested'), false);
});

test('health reports invalid config for malformed gateway instead of hiding the warning', async () => {
  const fixture = bridge({ ...sample(), inferenceGatewayApiKey: '' });
  try {
    const health = await fixture.call('getConfigHealth');
    assert.equal(health.state, 'invalid_config');
    assert.ok(health.issues.some(issue => issue.path === 'inferenceCredentialKind'));
    assert.equal((await fixture.call('recheckConfigHealth')).state, health.state);
  } finally { fixture.restore(); }
});
