import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
const bridgeCode = fs.readFileSync(new URL('../desktop/bridge-services.cjs', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('let hybridAuthSourceIdentity;'), main.indexOf('let windowState;'));
const auth = main.slice(main.indexOf('triggerBootstrapAuth: async args => {') + 'triggerBootstrapAuth: '.length,
  main.indexOf('\n    resetWindowBounds:')).trim().replace(/,$/, '');
const handlerSource = bridgeCode.slice(bridgeCode.indexOf("  define('claude.settings_$_Custom3pSetup_$_triggerBootstrapAuth'"),
  bridgeCode.indexOf('\n  // hybrid intl'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function setup(mode = '3p') {
  const requests = [], writes = [], effects = [];
  let config = { mode, bootstrap: { url: 'https://fixture.invalid' } };
  const context = vm.createContext({ Error, AggregateError, AbortController, bootstrapAuthAbort: null,
    hybridAuthResults: new Map(), hybridAuthRequests: new Map(),
    bridge: { getMainGrowthBookSourceConfig: () => config },
    hybridOidcSession: { invalidate: () => effects.push('session') },
    hybridLogin: { invalidate: () => effects.push('login'), signIn: (_oidc, options) => {
      const request = { ...deferred(), ...options }; requests.push(request); return request.promise;
    } },
    require: name => name.includes('growthbook-mode-backend') ? { hybridEnabled: () => true } : { deriveHybridOidc: () => ({ storeKey: 'fixture' }) },
    app: { isPackaged: true }, mainFeatures: { refreshSource: async () => effects.push('refresh') },
  });
  vm.runInContext(source, context);
  const sync = vm.runInContext('syncHybridAuthSource', context); sync();
  const triggerBootstrapAuth = vm.runInContext(`(${auth})`, context);
  let handler;
  vm.runInNewContext(handlerSource, { Error, define: (_name, fn) => { handler = fn; },
    opts: { triggerBootstrapAuth, onMainFeatureSourceChanged: sync },
    deploymentMode: { set: async mode => { writes.push(mode); config = { ...config, mode }; } },
  });
  return { requests, writes, effects, call: args => handler({}, args),
    change: () => { config = { ...config, bootstrap: { url: 'https://changed.invalid' } }; sync(); } };
}

test('shared controller survives first settlement and old finally does not clear a newer controller', async () => {
  const h = setup();
  const a = h.call({}), b = h.call({});
  assert.equal(h.requests[0].signal, h.requests[1].signal);
  assert.equal(h.requests[0].signal.aborted, false);
  h.requests[1].resolve(); await b;
  const c = h.call({});
  assert.notEqual(h.requests[0].signal, h.requests[2].signal);
  assert.equal(h.requests[0].isCurrent(), true);
  h.requests[0].resolve(); await a;
  const d = h.call({});
  assert.equal(h.requests[2].signal, h.requests[3].signal);
  h.change();
  assert.equal(h.requests[2].signal.aborted, true);
  assert.equal(h.requests[0].isCurrent(), false);
  h.requests[2].resolve(); h.requests[3].resolve();
  await Promise.all([c, d]);
  assert.equal(h.effects.filter(x => x === 'refresh').length, 2);
});

test('default completion writes 3p and invalidates concurrent requests when mode changes', async () => {
  const h = setup('1p');
  const a = h.call(undefined), b = h.call({});
  assert.equal(h.requests[0].signal, h.requests[1].signal);
  h.requests[0].resolve(); await a;
  assert.deepEqual(h.writes, ['3p']);
  assert.equal(h.requests[1].isCurrent(), false);
  h.requests[1].resolve(); await b;
  assert.equal(h.effects.filter(x => x === 'refresh').length, 0);
});
