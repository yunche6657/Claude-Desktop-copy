import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { discoverModels, TIMEOUT_MS, MAX_RESPONSE_BYTES } = require('../desktop/model-discovery.cjs');

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const json = (res, body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };

test('OpenAI and New API use GET and Bearer auth; normalize full endpoints and retain prefixes', async t => {
  const requests = [];
  const root = await serve(t, (req, res) => {
    requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, key: req.headers['x-api-key'] });
    json(res, { data: [{ id: 'gpt-a', name: 'GPT A' }] });
  });
  for (const suffix of ['', '/', '/v1', '/v1/', '/v1/chat/completions', '/chat/completions', '/v1/responses', '/responses', '/v1/models', '/v1/v1']) {
    assert.deepEqual(await discoverModels({ baseUrl: `${root}${suffix}?ignored=1#fragment`, apiKey: 'key-test', apiType: 'openai' }), {
      ok: true, models: [{ id: 'gpt-a', name: 'GPT A' }], error: null,
    });
    assert.deepEqual(requests.at(-1), { url: '/v1/models', method: 'GET', auth: 'Bearer key-test', key: undefined });
  }
  for (const suffix of ['/proxy', '/proxy/v1', '/proxy/v1/chat/completions', '/proxy/v1/responses', '/proxy/v1/messages']) {
    assert.equal((await discoverModels({ baseUrl: root + suffix, apiType: 'new-api' })).ok, true);
    assert.equal(requests.at(-1).url, '/proxy/v1/models');
    assert.equal(requests.at(-1).auth, undefined);
  }
});

test('Anthropic uses version and x-api-key with data or models and all endpoint forms', async t => {
  let shape = 'data';
  const root = await serve(t, (req, res) => {
    assert.equal(req.url, '/prefix/v1/models');
    assert.equal(req.method, 'GET');
    assert.equal(req.headers['x-api-key'], 'anthropic-key');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.headers.authorization, undefined);
    json(res, { [shape]: [{ id: 'claude-a', display_name: 'Claude A' }] });
  });
  for (const suffix of ['/prefix', '/prefix/v1', '/prefix/v1/messages', '/prefix/messages']) {
    assert.deepEqual(await discoverModels({ baseUrl: root + suffix, apiKey: 'anthropic-key', apiType: 'anthropic' }), {
      ok: true, models: [{ id: 'claude-a', name: 'Claude A' }], error: null,
    });
    shape = 'models';
  }
});

test('normalizes names, filters malformed rows, deduplicates ids, and accepts models for OpenAI', async t => {
  const root = await serve(t, (_req, res) => json(res, { models: [
    { id: ' m1 ', name: ' First ', display_name: 'Other' }, { id: 'm1', name: 'duplicate' },
    { id: 'm2', display_name: ' Second ' }, { id: 'm3', name: ' ' }, null, {}, { id: 5 }, { id: ' ' },
  ] }));
  assert.deepEqual(await discoverModels({ baseUrl: root }), {
    ok: true, models: [{ id: 'm1', name: 'First' }, { id: 'm2', name: 'Second' }, { id: 'm3', name: 'm3' }], error: null,
  });
});

test('empty, malformed and HTTP errors are explicit and never echo provider secrets', async t => {
  let mode;
  const secret = 'secret-key';
  const root = await serve(t, (_req, res) => {
    if (mode === 'http') { res.writeHead(401, `Denied ${secret}`); res.end(secret); }
    else if (mode === 'json') res.end(`bad ${secret}`);
    else if (mode === 'missing') json(res, { error: secret });
    else json(res, { data: mode === 'empty' ? [] : [{}] });
  });
  for (const [value, pattern] of [['http', /HTTP 401/], ['json', /invalid JSON/], ['missing', /no data or models array/], ['empty', /No available models/], ['invalid', /No available models/]]) {
    mode = value;
    const result = await discoverModels({ baseUrl: root, apiKey: secret });
    assert.equal(result.ok, false);
    assert.deepEqual(result.models, []);
    assert.match(result.error, pattern);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('2 MB response limit covers declared and streamed bodies', async t => {
  let declared = true;
  const root = await serve(t, (_req, res) => {
    if (declared) res.setHeader('content-length', MAX_RESPONSE_BYTES + 1);
    res.end('x'.repeat(MAX_RESPONSE_BYTES + 1));
  });
  for (const value of [true, false]) {
    declared = value;
    assert.match((await discoverModels({ baseUrl: root })).error, /2 MB limit/);
  }
});

test('redirects do not forward authentication and echoed model fields redact the key', async t => {
  let forwarded = false;
  const other = await serve(t, (_req, res) => { forwarded = true; json(res, { data: [] }); });
  let redirect = true;
  const root = await serve(t, (_req, res) => {
    if (redirect) { res.writeHead(302, { location: other }); res.end(); }
    else json(res, { data: [{ id: 'id-key-secret', name: 'name-key-secret' }] });
  });
  assert.match((await discoverModels({ baseUrl: root, apiKey: 'key-secret' })).error, /HTTP 302/);
  assert.equal(forwarded, false);
  redirect = false;
  const result = await discoverModels({ baseUrl: root, apiKey: 'key-secret' });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('key-secret'), false);
});

test('invalid URL, credentials and key headers return structured errors', async () => {
  for (const baseUrl of ['', 'broken', 'file:///tmp', 'http://user:password@localhost']) {
    const result = await discoverModels({ baseUrl });
    assert.equal(result.ok, false);
    assert.deepEqual(result.models, []);
    assert.match(result.error, /valid HTTP or HTTPS/);
  }
  assert.equal((await discoverModels({ baseUrl: 'http://127.0.0.1', apiKey: 'key\r\ninjected' })).ok, false);
  assert.equal((await discoverModels(null)).ok, false);
});

test('connection errors stay generic and requests have a 10-second wall-clock deadline', async t => {
  const broken = await serve(t, (req) => req.socket.destroy());
  assert.match((await discoverModels({ baseUrl: broken, apiKey: 'private-secret' })).error, /connection/);
  const root = await serve(t, (_req, res) => { res.writeHead(200); res.write('{'); });
  assert.equal(TIMEOUT_MS, 10_000);
  const start = Date.now();
  const result = await discoverModels({ baseUrl: root });
  assert.match(result.error, /timed out after 10 seconds/);
  assert.ok(Date.now() - start >= 9_900);
});

test('Custom3pSetup.discoverModels is registered through bridge-map and does not persist input', async t => {
  const root = await serve(t, (_req, res) => json(res, { data: [{ id: 'bridge-model' }] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map();
  const bridgeMap = require('../desktop/shim/bridge-map.json');
  assert.ok(bridgeMap['claude.settings'].Custom3pSetup.includes('discoverModels'));
  const settings = { dataDir: dir };
  require('../desktop/bridge-services.cjs').registerBridgeServices({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    bridgeMap, getMainWindow: () => null, settings, frontend: { root: process.cwd() },
  });
  const before = JSON.stringify(settings);
  const filesBefore = fs.readdirSync(dir);
  const channel = [...handlers.keys()].find(value => value.endsWith('_$_Custom3pSetup_$_discoverModels'));
  assert.ok(channel);
  assert.deepEqual(await handlers.get(channel)({}, { baseUrl: root, apiKey: 'temporary-secret', apiType: 'openai' }), {
    ok: true, models: [{ id: 'bridge-model', name: 'bridge-model' }], error: null,
  });
  assert.equal(JSON.stringify(settings), before);
  assert.deepEqual(fs.readdirSync(dir), filesBefore);
});
