import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHybridControlFetch, CONTROL_PARTITION } = require('../desktop/hybrid-control-fetch.cjs');
const ref = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js');
const token = 'synthetic-hybrid-token';

function dependencies(overrides = {}) {
  return { electronSession: { fromPartition: () => ({ fetch: async () => ({ ok: true }) }) },
    oidcFor: async () => ({ xAuthorization: false }), resolveBearer: async () => ({ ok: true, bearer: token }), ...overrides };
}

test('isolated session receives normalized headers and native options after overlay and OIDC resolution', async () => {
  const events = [], calls = [];
  const originalTimeout = AbortSignal.timeout; let timeout;
  AbortSignal.timeout = ms => { timeout = ms; return originalTimeout(ms); };
  try {
    const oidc = { apiOrigin: 'https://issuer.invalid', xAuthorization: true };
    const run = createHybridControlFetch(dependencies({
      overlayApplied: async () => { events.push('overlay'); },
      oidcFor: async url => { events.push('oidc'); assert.equal(url, 'https://bootstrap.invalid/path'); return oidc; },
      resolveBearer: async input => { events.push('bearer'); assert.equal(input, oidc); return { ok: true, bearer: token }; },
      electronSession: { fromPartition: name => { events.push('partition'); assert.equal(name, 'custom3p-probe');
        return { fetch: async (url, init) => { events.push('fetch'); calls.push({ url, init }); return { ok: true }; } }; } },
      prepareSession: async (partition, session) => { events.push('proxy'); assert.equal(partition, CONTROL_PARTITION); assert.equal(typeof session.fetch, 'function'); },
    }));
    assert.equal((await run('https://bootstrap.invalid/path', 'https://bootstrap.invalid/api/desktop/features', { 'Anthropic-Client-App': 'desktop', authorization: 'discard-fixture' })).ok, true);
    assert.deepEqual(events, ['overlay', 'oidc', 'bearer', 'partition', 'proxy', 'fetch']);
    assert.equal(timeout, 30000); assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.deepEqual(calls[0].init.headers, { 'anthropic-client-app': 'desktop', authorization: `Bearer ${token}`, 'x-authorization': `Bearer ${token}` });
    assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.cache, 'no-store');
  } finally { AbortSignal.timeout = originalTimeout; }
});

test('auth failures and cross-origin targets do not access any session or forward credentials', async () => {
  let count = 0, resolution = { ok: false, kind: 'auth' }, overlayCount = 0;
  const run = createHybridControlFetch(dependencies({
    overlayApplied: async () => { overlayCount++; },
    resolveBearer: async () => resolution,
    electronSession: { fromPartition: () => { count++; throw Error('should not be called'); } },
  }));
  const base = 'https://bootstrap.invalid/path', url = 'https://bootstrap.invalid/api/desktop/features';
  assert.equal(await run(base, url, {}), null);
  resolution = { ok: false, kind: 'unreachable' };
  await assert.rejects(run(base, url, {}), /token refresh failed/);
  resolution = { ok: true, bearer: token };
  await assert.rejects(run(base, 'https://other.invalid/api/desktop/features', {}), /does not match/);
  await assert.rejects(run(base, 'https://user@bootstrap.invalid/api/desktop/features', {}), /does not match/);
  assert.equal(count, 0); assert.equal(overlayCount, 2);
});

test('plain Authorization matches native Al and session wrapper in VM', async () => {
  const s = fs.readFileSync(ref, 'utf8');
  const alStart = s.indexOf('function Al('), alEnd = s.indexOf('function aBe(', alStart);
  const wrapperStart = s.indexOf('function cKt('), wrapperEnd = s.indexOf('var rx=cKt(', wrapperStart);
  assert.ok(alStart >= 0 && alEnd > alStart && wrapperStart >= 0 && wrapperEnd > wrapperStart);
  let captured;
  const original = vm.runInNewContext(s.slice(alStart, alEnd) + s.slice(wrapperStart, wrapperEnd) + ';({Al,cKt})', {
    Headers, URLSearchParams, ArrayBuffer, a: { session: { fromPartition: () => ({ fetch: (url, init) => { captured = { url, init }; return { ok: true }; } }) } }, Lm: () => undefined,
  });
  const expectedHeaders = original.Al({ xAuthorization: false }, token);
  original.cKt('custom3p-probe')('https://bootstrap.invalid/api/desktop/features', { headers: { 'anthropic-client-app': 'desktop', ...expectedHeaders }, cache: 'no-store' });
  let actual;
  const run = createHybridControlFetch(dependencies({ electronSession: { fromPartition: () => ({ fetch: (url, init) => { actual = { url, init }; return { ok: true }; } }) } }));
  await run('https://bootstrap.invalid/path', 'https://bootstrap.invalid/api/desktop/features', { 'anthropic-client-app': 'desktop' });
  assert.deepEqual(actual.init.headers, JSON.parse(JSON.stringify(captured.init.headers)));
  assert.equal(actual.init.redirect, captured.init.redirect); assert.equal(actual.init.credentials, captured.init.credentials); assert.equal(actual.init.cache, captured.init.cache);
  assert.equal(actual.init.headers['x-authorization'], undefined);
});

test('isolated session loopback request rejects redirects and transmits no ambient credentials', async () => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/never' }); res.end(); }
    else { res.end('ok'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const run = createHybridControlFetch(dependencies({ electronSession: { fromPartition: () => ({ fetch }) } }));
    assert.equal((await run(base, `${base}/api/desktop/features`, {})).ok, true);
    await assert.rejects(run(base, `${base}/redirect`, {}));
    assert.deepEqual(seen.map(x => x.url), ['/api/desktop/features', '/redirect']);
    assert.ok(seen.every(x => x.cookie === undefined && x.authorization === `Bearer ${token}`));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
