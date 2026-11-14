import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createGrowthBookSource, growthBookHeaders } = require('../desktop/growthbook-source.cjs');
const { createGrowthBookProvider } = require('../desktop/growthbook-provider.cjs');
const ref = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js');
const fakeTimer = { setTimer: () => ({ unref() {} }), clearTimer() {} };
const options = { appVersion: '1.2.3-test', totalMemoryBytes: 8 * 1024 ** 3 };

test('headers match original Cv in VM at every device class threshold', () => {
  const source = fs.readFileSync(ref, 'utf8');
  const start = source.indexOf('function nzt(e){');
  const end = source.indexOf('var ozt=', start);
  assert.ok(start >= 0 && end > start);
  for (const total of [0, 5999999999, 6000000000, 11999999999, 12000000000, 19999999999, 20000000000]) {
    const ctx = { s: { default: { totalmem: () => total } }, a: { app: { getVersion: () => options.appVersion } } };
    const expected = vm.runInNewContext(source.slice(start, end) + ';Cv()', ctx);
    assert.deepEqual(growthBookHeaders({ appVersion: options.appVersion, totalMemoryBytes: total }), JSON.parse(JSON.stringify(expected)));
  }
});

test('static source is inert; consumer uses exact endpoint, headers, ready ordering and timeout', async () => {
  const staticSource = createGrowthBookSource({ kind: 'static', features: { x: { value: true } } });
  assert.equal(staticSource.kind, 'static'); assert.equal(staticSource.fetch, undefined);
  const requests = [];
  const server = http.createServer((req, res) => { requests.push({ url: req.url, headers: req.headers }); res.end(JSON.stringify({ features: { k: { value: 42 } } })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let runtime;
  try {
    const origin = `http://127.0.0.1:${server.address().port}/nested/`;
    let ready = false, signal, timeout;
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ms => { timeout = ms; return originalTimeout(ms); };
    try {
      const source = createGrowthBookSource({ kind: 'remote', origin, ...options,
        whenReady: async () => { ready = true; },
        netFetch: (url, init) => { assert.equal(ready, true); signal = init.signal; return fetch(url, init); },
      });
      runtime = createGrowthBookProvider({ getContext: () => ({ mode: '1p', source }), ...fakeTimer });
      assert.equal(await runtime.init(), 'success');
      assert.equal(runtime.getFeatureValue('k', null), 42);
      assert.equal(timeout, 30000); assert.ok(signal instanceof AbortSignal);
      assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/desktop/features');
      for (const [k, v] of Object.entries(growthBookHeaders(options))) assert.equal(requests[0].headers[k], v);
      assert.equal(requests[0].headers.authorization, undefined);
    } finally { AbortSignal.timeout = originalTimeout; }
  } finally { runtime?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('hybrid auth is injected, no bearer and anonymous response cannot apply values', async () => {
  let called = 0, behavior = 'missing';
  const source = createGrowthBookSource({ kind: 'remote', origin: 'https://control.invalid/base', ...options,
    netFetch: () => { throw Error('consumer must not be used'); },
    authedFetch: async (url, headers) => {
      called++; assert.equal(url, 'https://control.invalid/api/desktop/features');
      assert.deepEqual(headers, growthBookHeaders(options));
      if (behavior === 'missing') return null;
      if (behavior === 'anonymous') return { ok: true, json: async () => ({ features: { k: { value: 'bad' } } }) };
      return { ok: true, json: async () => ({ user: {}, features: { k: { value: 'ok' } } }) };
    },
  });
  const provider = createGrowthBookProvider({ getContext: () => ({ mode: '3p', source }), ...fakeTimer });
  try {
    assert.equal(await provider.init(), 'network-error'); assert.equal(provider.getFeatureValue('k', null), null);
    behavior = 'anonymous'; assert.equal(await provider.refresh({ force: true }), 'anon-refused'); assert.equal(provider.getFeatureValue('k', null), null);
    behavior = 'authenticated'; assert.equal(await provider.refresh({ force: true }), 'success'); assert.equal(provider.getFeatureValue('k', null), 'ok');
    assert.equal(called, 3);
  } finally { provider.dispose(); }
});

test('remote failure and malformed response stay provider outcomes', async () => {
  let result;
  const source = createGrowthBookSource({ kind: 'remote', origin: 'https://control.invalid', ...options,
    authedFetch: async () => result,
    hardcodedFeatures: {}, remoteAllowedKeys: new Set(['k']), previouslyAuthed: true,
  });
  assert.equal(source.previouslyAuthed, true);
  assert.deepEqual([...source.remoteAllowedKeys], ['k']);
  const provider = createGrowthBookProvider({ getContext: () => ({ mode: '3p', source }), ...fakeTimer });
  try {
    result = { ok: false, status: 503 };
    assert.equal(await provider.init(), 'http-error');
    result = { ok: true, json: async () => ({ features: { k: null } }) };
    assert.equal(await provider.refresh({ force: true }), 'parse-error');
    result = { ok: true, json: async () => { throw new SyntaxError('bad'); } };
    assert.equal(await provider.refresh({ force: true }), 'parse-error');
    result = { ok: true, json: async () => ({ features: {} }) };
    assert.equal(await provider.refresh({ force: true }), 'anon-refused');
  } finally { provider.dispose(); }
});
