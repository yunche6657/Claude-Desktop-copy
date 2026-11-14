import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { importModelSubscription, parseModelSubscription } = require('../desktop/model-subscription-import.cjs');
const profile = { baseURL: 'https://gateway.example/v1', apiKey: 'fixture-key', models: [{ id: 'fixture-model', name: 'Fixture', contextWindow: 200000 }] };

async function fixture(t) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/slow')) return;
    if (req.url.startsWith('/headers-big')) { res.writeHead(200, { 'content-length': '1048577' }); res.end(); return; }
    if (req.url.startsWith('/stream-big')) { res.write('x'.repeat(150)); res.end('x'.repeat(150)); return; }
    if (req.url.startsWith('/bad-json')) { res.end('{"secret-key":'); return; }
    if (req.url.startsWith('/status')) { res.writeHead(403); res.end('private response'); return; }
    if (req.url.startsWith('/invalid-redirect')) { res.writeHead(302, { location: 'file:///private-key' }); res.end(); return; }
    if (req.url.startsWith('/loop')) { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: '/models' }); res.end(); return; }
    if (req.url.startsWith('/body-slow')) { res.write('{'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ providers: { fixture: { ...profile, displayName: 'Fixture gateway' } } }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('DSH providers dictionary and desktop configs normalize into preview profiles', () => {
  const dsh = parseModelSubscription({ providers: { route: { ...profile, displayName: 'DSH route' } } });
  assert.equal(dsh[0].name, 'DSH route');
  assert.equal(dsh[0].config.inferenceGatewayBaseUrl, profile.baseURL);
  assert.equal(dsh[0].config.inferenceGatewayApiKey, 'fixture-key');
  assert.deepEqual(dsh[0].config.inferenceModels, profile.models);
  assert.deepEqual(parseModelSubscription({ config: { providers: { route: profile } } })[0].name, 'route');
  const desktop = parseModelSubscription({ configs: [{ name: 'Desktop', config: dsh[0].config }] });
  assert.equal(desktop[0].name, 'Desktop');
  assert.equal(desktop[0].config.inferenceGatewayApiKey, 'fixture-key');
  assert.equal(parseModelSubscription([{ ...profile, models: ['model-a'] }])[0].config.inferenceModels[0].id, 'model-a');
  assert.equal(parseModelSubscription({ ...profile, models: { actual: { id: 'ignored', name: 'Actual' } } })[0].config.inferenceModels[0].id, 'actual');
});

test('saved desktop model names can be reimported without accepting display-only provider models', () => {
  const saved = require('../desktop/provider-config-contract.cjs').normalizeProviderConfig({
    inferenceProvider: 'gateway', inferenceGatewayBaseUrl: profile.baseURL, inferenceGatewayApiKey: 'fixture-key',
    inferenceModels: [{ id: 'saved-model', contextWindow: 64000, capabilities: { supportedEfforts: ['high'] } }],
  });
  const imported = parseModelSubscription({ configs: [{ name: 'Saved', config: saved }] })[0].config;
  assert.equal(imported.inferenceModels[0].id, 'saved-model');
  assert.equal(imported.inferenceModels[0].contextWindow, 64000);
  assert.deepEqual(imported.inferenceModels[0].capabilities, { supportedEfforts: ['high'] });
  assert.throws(() => parseModelSubscription({ ...profile, models: [{ name: 'Display only' }] }));
  assert.throws(() => parseModelSubscription({ ...saved, inferenceModels: [{ name: 'same' }, { id: 'same' }] }));
});

test('subscription preserves an explicitly selected default model through preview ordering', () => {
  for (const selector of ['model', 'defaultModel']) {
    const config = parseModelSubscription({ ...profile, models: ['first', { id: 'selected', contextWindow: 64000 }], [selector]: ' selected ' })[0].config;
    assert.equal(config.model, 'selected');
    assert.deepEqual(config.inferenceModels.map(row => row.id), ['selected', 'first']);
    assert.equal(config.inferenceModels[0].contextWindow, 64000);
    assert.equal(require('../desktop/gateway-source.cjs').normaliseProfile(config).model, 'selected');
  }
  assert.throws(() => parseModelSubscription({ ...profile, model: 'missing-model' }), /默认模型/);
  assert.equal(parseModelSubscription(profile)[0].config.inferenceModels[0].id, 'fixture-model');
});

test('desktop capability overrides survive subscription import with whitelist normalization', () => {
  const imported = parseModelSubscription({ ...profile, inferenceModels: ['off', 'custom', '__proto__'],
    inferenceModelCapabilities: JSON.parse('{"off":{"supportedEfforts":[],"secret":"discard"},"custom":{"supportedEfforts":["minimal","high"],"defaultEffort":"high","apiKey":"discard"},"__proto__":{"supportedEfforts":["low"]},"stale":{"supportedEfforts":["high"]}}'),
  })[0].config;
  assert.deepEqual(imported.inferenceModelCapabilities, JSON.parse('{"off":{"supportedEfforts":[]},"custom":{"supportedEfforts":["minimal","high"],"defaultEffort":"high"},"__proto__":{"supportedEfforts":["low"]}}'));
  const caps = require('../desktop/model-capabilities.cjs');
  assert.equal(caps.resolveModelCapabilities('off', imported).source, 'config');
  assert.equal(caps.modelThinking('custom', imported).effort_options[1].recommended, true);
  assert.deepEqual(caps.resolveModelCapabilities('__proto__', imported).supportedEfforts, ['low']);
});

test('model subscription preserves explicit reasoning metadata without arbitrary provider fields', () => {
  const configs = parseModelSubscription({ ...profile, models: [{ id: 'reasoner',
    reasoning: { supported_efforts: ['low', 'high'], default_effort: 'high', secret: 'discard' },
    apiKey: 'discard-model-key', contextWindow: 64000,
  }] });
  const model = configs[0].config.inferenceModels[0];
  assert.deepEqual(model.capabilities, { supportedEfforts: ['low', 'high'], defaultEffort: 'high' });
  assert.equal(require('../desktop/model-capabilities.cjs').modelThinking('reasoner', configs[0].config).effort_options.length, 2);
  assert.equal(model.contextWindow, 64000);
  assert.equal(Object.hasOwn(model, 'apiKey'), false);
  assert.equal(Object.hasOwn(model, 'reasoning'), false);
  const persisted = require('../desktop/provider-config-contract.cjs').normalizeProviderConfig(configs[0].config);
  assert.deepEqual(require('../desktop/model-capabilities.cjs').resolveModelCapabilities('reasoner', persisted).supportedEfforts, ['low', 'high']);
});

test('invalid subscription structure and unresolved credential references fail with fixed messages', () => {
  for (const value of [null, [], {}, { providers: [] }, { configs: [] }, { ...profile, apiKey: undefined, apiKeyEnv: 'REAL_KEY' },
    { ...profile, models: ['duplicate', 'duplicate'] }, { ...profile, models: [{ id: 'm', contextWindow: -1 }] },
    { ...profile, baseURL: 'file:///private' }, { ...profile, apiKey: 'key with space' }]) {
    assert.throws(() => parseModelSubscription(value));
  }
});

test('URL fixture fetch supports JSON and redirects, bounds headers/body/time, and redacts errors', async t => {
  const base = await fixture(t);
  for (const route of ['/models', '/redirect']) {
    const result = await importModelSubscription({ url: base + route });
    assert.equal(result.ok, true);
    assert.equal(result.configs[0].name, 'Fixture gateway');
  }
  for (const [route, options, message] of [
    ['/headers-big', {}, /大小/], ['/stream-big', { maxBytes: 200 }, /大小/], ['/slow', { timeoutMs: 40 }, /超时/],
    ['/body-slow', { timeoutMs: 40 }, /超时/], ['/bad-json', {}, /JSON/], ['/status', {}, /HTTP 403/],
    ['/invalid-redirect', {}, /HTTP\/HTTPS/], ['/loop', {}, /重定向/],
  ]) {
    const result = await importModelSubscription({ url: `${base}${route}?key=private-query-key` }, options);
    assert.equal(result.ok, false, route);
    assert.deepEqual(result.configs, []);
    assert.match(result.error, message, route);
    assert.doesNotMatch(result.error, /private-query-key|private response|secret-key|127\.0\.0\.1/);
  }
  for (const url of ['file:///private-query-key', 'not-a-url?key=private-query-key', 'http://user:private-query-key@localhost']) {
    const result = await importModelSubscription({ url });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /private-query-key/);
  }
  const failed = await importModelSubscription({ url: base }, { fetchImpl: async () => { throw new Error('订阅 private-query-key'); } });
  assert.doesNotMatch(failed.error, /private-query-key/);
});

test('bridge URL import previews without creating config library or changing active configuration', async t => {
  const base = await fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-subscription-'));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  try {
    const handlers = new Map();
    const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
    registerBridgeServices({ ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
      bridgeMap: require('../desktop/shim/bridge-map.json'), settings: { dataDir: root }, frontend: { root: process.cwd() }, getMainWindow: () => null });
    const key = [...handlers.keys()].find(key => key.endsWith('_$_Custom3pSetup_$_importModelSubscription'));
    assert.ok(key);
    const before = fs.readdirSync(root, { recursive: true }).sort();
    const result = await handlers.get(key)({}, { url: base + '/models' });
    assert.equal(result.ok, true);
    assert.equal(result.configs[0].config.inferenceModels[0].id, 'fixture-model');
    assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), before);
    const invalid = await handlers.get(key)({}, null);
    assert.equal(invalid.ok, false);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
