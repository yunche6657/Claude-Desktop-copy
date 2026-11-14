import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
function section(startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `missing native section ${startText}`);
  return source.slice(start, end);
}
const parts = [
  section('function Wu(){let e=new Map;', 'var AGe='),
  section('function Cl(e){', 'function Gze('),
  section('function Vyn(e,t){', 'var Hyn='),
  section('async function vQn(e){', 'async function yQn('),
  section('function Hw(e){', 'function Uw('),
  section('async function jtn(e,t){', 'async function Mtn('),
];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture() {
  const started = deferred(), grant = deferred();
  const config = { apiHost: 'https://api.anthropic.com', clientId: 'fixture', scope: 'user:profile' };
  const configs = { production: config };
  const calls = { lookup: 0, authorization: 0, usedClient: undefined };
  const context = {
    URL, Error, a: { app: { isPackaged: true } }, Byn: configs,
    Gn: () => false,
    _Qn: async () => 'https://claude.ai',
    Lw: { capture: () => () => false },
    Dw: options => { calls.authorization++; calls.usedClient = options.clientId; started.resolve(); return grant.promise; },
    rx: () => {}, Ww: () => {}, Mw: null, sx: class extends Error {},
    N: { warn() {}, info() {} }, P: () => '',
    T5t: { invalidateHybridAccount() {} },
    KC: { noteIncomingHybridGrant() {}, recordHybridIdentity: async () => {} },
  };
  vm.createContext(context);
  vm.runInContext(parts.join('\n'), context);
  context._O = { COWORK_3P_HYBRID_OAUTH_CONFIGS: configs, getOAuthEnvironment: () => 'production', hybridOAuthConfigForBootstrapUrl: context.Vyn };
  context.GF = { hybridOidcFor: context.vQn, assertTokenBoundToHybridOrg: async () => ({}), revokeHybridGrant() {} };
  const singleflight = context.Wu();
  context.Pw = { run: (key, run) => { calls.lookup++; return singleflight.run(key, run); } };
  return { context, config, calls, started: started.promise, grant };
}

test('native failed OIDC derivation rejects before joining existing slot', async () => {
  const f = await fixture();
  const bootstrap = 'https://api.anthropic.com/source';
  const first = f.context.jtn(bootstrap);
  await f.started;
  assert.equal(f.calls.lookup, 1);
  f.config.apiHost = 'not-a-url';
  await assert.rejects(f.context.jtn(bootstrap), { name: 'TypeError' });
  assert.equal(f.calls.lookup, 1);
  assert.equal(f.calls.authorization, 1);
  f.grant.resolve({ accessToken: 'fixture' });
  await first;
});

test('native derivation does not validate empty client and second same-slot call joins first', async () => {
  const f = await fixture();
  const bootstrap = 'https://api.anthropic.com/source';
  const first = f.context.jtn(bootstrap);
  await f.started;
  f.config.clientId = '';
  const derived = await f.context.vQn(bootstrap);
  assert.equal(derived.clientId, '');
  assert.equal(derived.storeKey, 'hybrid:https://api.anthropic.com:unknown');
  const second = f.context.jtn(bootstrap);
  for (let n = 0; n < 20 && f.calls.lookup < 2; n++) await new Promise(r => setImmediate(r));
  assert.equal(f.calls.lookup, 2);
  assert.equal(f.calls.authorization, 1);
  assert.equal(f.calls.usedClient, 'fixture');
  f.grant.resolve({ accessToken: 'fixture' });
  await Promise.all([first, second]);
});

test('native vQn falls back for an invalid bootstrap string before any upstream schema', async () => {
  const f = await fixture();
  const derived = await f.context.vQn('not-a-url');
  assert.equal(derived.storeKey, 'hybrid:unknown:unknown');
  assert.equal(derived.clientId, 'fixture');
});
