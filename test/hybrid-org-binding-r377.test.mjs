import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertTokenBoundToHybridOrg: verify, bindAndPersistHybridGrant, lookupHybridTokenProfile } = require('../desktop/hybrid-org-binding.cjs');
const org = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', account = '12345678-aaaa-bbbb-cccc-123456789abc', token = 'fixture-token';
const ref = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js');
const oidc = { apiOrigin: 'https://control.invalid', orgUuid: org, xAuthorization: true };

test('xQn/yQn differential across verification and mismatch cases', async () => {
  const source = fs.readFileSync(ref, 'utf8');
  const start = source.indexOf('async function yQn('), end = source.indexOf('var SQn=', start);
  assert.ok(start >= 0 && end > start);
  const code = source.slice(start, end).replace('let{gatewayFetch3p:r}=await Promise.resolve().then((()=>Qb)),i=', 'let r=fetcher,i=');
  let response;
  const fetcher = async () => { if (response instanceof Error) throw response; return response; };
  const context = { fetcher, pQn: 10000, AbortSignal, N: { info() {}, warn() {} }, P: () => '', X: () => ({ formatMessage: o => o.defaultMessage }),
    Al: (e,t) => ({ Authorization:`Bearer ${t}`, ...(e.xAuthorization ? { 'X-Authorization':`Bearer ${t}` } : {}) }),
    Gn: e => typeof e === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e) };
  const original = vm.runInNewContext(code + ';xQn', context);
  const cases = [
    { response: { ok: true, json: async () => ({ organization: { uuid: org.toUpperCase() }, account: { uuid: account.toUpperCase() } }) } },
    { response: { ok: true, json: async () => ({ organization: { uuid: org }, account: { uuid: 'bad' } }) } },
    { response: { ok: true, json: async () => ({ organization: { uuid: 'invalid' } }) } },
    { response: { ok: false } }, { response: new Error('offline') },
    { response: { ok: true, json: async () => { throw Error('bad JSON'); } } },
  ];
  const outcome = async fn => { try { return { ok: true, value: JSON.parse(JSON.stringify(await fn())) }; } catch (e) { return { ok: false, kind: e.kind }; } };
  for (const c of cases) { response = c.response;
    assert.deepEqual(await outcome(() => verify(oidc, token, { fetch: fetcher })), await outcome(() => original(oidc, token)));
  }
  let calls = 0;
  assert.deepEqual(await verify({ orgUuid: null }, token, { fetch: () => { calls++; } }), {});
  assert.equal(calls, 0);
});

test('profile fetch uses selected OIDC origin, bearer headers, 10s and optional caller abort', async () => {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push({ url: req.url, auth: req.headers.authorization, xauth: req.headers['x-authorization'] });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ organization: { uuid: org.toUpperCase() }, account: { uuid: account.toUpperCase() } })); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const originalTimeout = AbortSignal.timeout; let timeout, seenSignal;
  AbortSignal.timeout = ms => { timeout = ms; return originalTimeout(ms); };
  try {
    const control = new AbortController();
    const local = { ...oidc, apiOrigin: `http://127.0.0.1:${server.address().port}` };
    const result = await verify(local, token, { signal: control.signal, fetch: (url, init) => {
      assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); seenSignal = init.signal; return fetch(url, init);
    } });
    assert.deepEqual(result, { accountUuid: account }); assert.equal(timeout, 10000);
    assert.equal(seenSignal.aborted, false); control.abort(); assert.equal(seenSignal.aborted, true);
    assert.deepEqual(requests, [{ url: '/api/oauth/profile', auth: `Bearer ${token}`, xauth: `Bearer ${token}` }]);
  } finally { AbortSignal.timeout = originalTimeout; server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('persist runs only after successful bound org; invalid profile is mismatch, HTTP failure unverified', async () => {
  let persisted = 0, release, requestStarted;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { requestStarted = r; });
  const delayedFetch = async () => { requestStarted(); await gate; return { ok: true, json: async () => ({ organization: { uuid: org } }) }; };
  const run = bindAndPersistHybridGrant(oidc, { accessToken: token }, { fetch: delayedFetch, persist: async () => { persisted++; } });
  await started; assert.equal(persisted, 0); release(); await run; assert.equal(persisted, 1);
  for (const [fetch, kind] of [
    [async () => ({ ok: true, json: async () => ({ organization: { uuid: 'bad' } }) }), 'mismatch'],
    [async () => ({ ok: false }), 'unverified'],
  ]) {
    await assert.rejects(bindAndPersistHybridGrant(oidc, { accessToken: token }, { fetch, persist: async () => { persisted++; } }), e => e.kind === kind);
  }
  assert.equal(persisted, 1);
  assert.deepEqual(await lookupHybridTokenProfile(oidc, token, { fetch: async () => ({ ok: true, json: async () => ({}) }) }), { bound: null, accountUuid: undefined });
});
