import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHybridOidcLogin } = require('../desktop/hybrid-oidc-login.cjs');
const source = fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
const start = source.indexOf('function Wu(){let e=new Map;');
const end = source.indexOf('var AGe=', start);
assert.ok(start >= 0 && end > start);
const nativeWu = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
const oidc = storeKey => ({ storeKey, authorizationUrl: 'https://example.test/authorize', tokenUrl: 'https://example.test/token', apiOrigin: 'https://example.test', clientId: 'fixture', scopes: 'test' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function waitFor(predicate) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw Error('fixture deadline');
}
function fixture() {
  const urls = [], writes = [], requests = [];
  const login = createHybridOidcLogin({
    openBrowser: async url => { urls.push(new URL(url)); },
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ access_token: 'fixture-access', expires_in: 60 }), { status: 200 });
    },
    slotStore: { write: (key, _grant, options) => { assert.equal(options.isCurrent(), true); writes.push(key); } },
    assertTokenBoundToHybridOrg: async () => ({}),
  });
  const callback = async index => {
    const url = urls[index];
    const callbackUrl = new URL(url.searchParams.get('redirect_uri'));
    callbackUrl.searchParams.set('state', url.searchParams.get('state'));
    callbackUrl.searchParams.set('code', 'fixture-code');
    assert.equal((await fetch(callbackUrl)).status, 200);
  };
  return { login, urls, writes, requests, callback };
}

test('actual login and native Wu coalesce same slot and settle both callers once', async () => {
  const flight = nativeWu(), gate = deferred(); let invoked = 0;
  const nativeA = flight.run('same', () => { invoked++; return gate.promise; });
  const nativeB = flight.run('same', () => { invoked++; return Promise.resolve(); });
  assert.equal(nativeA, nativeB);
  assert.equal(invoked, 1);
  gate.resolve('done');
  assert.equal(await nativeA, 'done');
  assert.equal(await nativeB, 'done');
  const f = fixture();
  try {
    const a = f.login.signIn(oidc('same'));
    const b = f.login.signIn(oidc('same'));
    assert.equal(a, b);
    await waitFor(() => f.urls.length === 1);
    await f.callback(0);
    assert.deepEqual(await a, { ok: true });
    assert.deepEqual(await b, { ok: true });
    assert.equal(f.urls.length, 1);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.writes, ['same']);
  } finally { f.login.invalidate(); }
});

test('different slots independently run real loopback callbacks', async () => {
  const f = fixture();
  try {
    const a = f.login.signIn(oidc('a'));
    const b = f.login.signIn(oidc('b'));
    assert.notEqual(a, b);
    await waitFor(() => f.urls.length === 2);
    await Promise.all([f.callback(0), f.callback(1)]);
    assert.deepEqual(await Promise.all([a, b]), [{ ok: true }, { ok: true }]);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.writes.sort(), ['a', 'b']);
  } finally { f.login.invalidate(); }
});

test('invalidation aborts old flight and old settle does not evict new generation', async () => {
  const f = fixture();
  try {
    const old = f.login.signIn(oidc('same'));
    const oldResult = assert.rejects(old, { name: 'AbortError' });
    await waitFor(() => f.urls.length === 1);
    f.login.invalidate();
    const fresh = f.login.signIn(oidc('same'));
    await oldResult;
    assert.equal(f.login.signIn(oidc('same')), fresh);
    await waitFor(() => f.urls.length === 2);
    await f.callback(1);
    assert.deepEqual(await fresh, { ok: true });
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.writes, ['same']);
  } finally { f.login.invalidate(); }
});
