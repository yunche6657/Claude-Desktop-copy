import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../desktop/bridge-services.cjs', import.meta.url), 'utf8');
const start = main.indexOf('triggerBootstrapAuth: async args => {');
const end = main.indexOf('\n    resetWindowBounds:', start);
assert.ok(start >= 0 && end > start);
const authSource = main.slice(start + 'triggerBootstrapAuth: '.length, end).trim().replace(/,$/, '');
const bridgeStart = bridge.indexOf("  define('claude.settings_$_Custom3pSetup_$_triggerBootstrapAuth'");
const bridgeEnd = bridge.indexOf('\n  // hybrid intl', bridgeStart);
assert.ok(bridgeStart >= 0 && bridgeEnd > bridgeStart);
const bridgeSource = bridge.slice(bridgeStart, bridgeEnd);

function harness(signIn) {
  const activity = { refresh: 0, invalidate: 0, writes: [], notifications: 0 };
  const context = {
    Error, AggregateError, AbortController, bootstrapAuthAbort: null, bootstrapAuthGeneration: 0,
    hybridLogin: { signIn },
    bridge: { getMainGrowthBookSourceConfig: () => ({ bootstrap: { url: 'https://example.test' }, mode: '3p' }) },
    require: name => name.includes('growthbook-mode-backend')
      ? { hybridEnabled: () => true }
      : { deriveHybridOidc: () => ({ storeKey: 'fixture' }) },
    app: { isPackaged: true },
    hybridOidcSession: { invalidate: () => activity.invalidate++ },
    hybridAuthResults: new Map(), hybridAuthRequests: new Map(),
    mainFeatures: { refreshSource: async () => { activity.refresh++; } },
  };
  const triggerBootstrapAuth = vm.runInNewContext(`(${authSource})`, context);
  let handler;
  vm.runInNewContext(bridgeSource, {
    Error,
    define: (_name, fn) => { handler = fn; },
    opts: { triggerBootstrapAuth, onMainFeatureSourceChanged: () => activity.notifications++ },
    deploymentMode: { set: async mode => { activity.writes.push(mode); } },
  });
  return { activity, call: async args => JSON.parse(JSON.stringify(await handler({}, args))),
    cancel: () => { context.bootstrapAuthGeneration++; context.bootstrapAuthAbort?.abort(); context.bootstrapAuthAbort = null; } };
}

test('cancelled default call writes 3p while explicit call does not, without success refresh', async () => {
  const h = harness(async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); });
  assert.deepEqual(await h.call(undefined), { ok: true });
  assert.deepEqual(h.activity.writes, ['3p']);
  assert.deepEqual(await h.call({ bootstrapUrl: 'https://example.test' }), { ok: true });
  assert.deepEqual(h.activity.writes, ['3p']);
  assert.equal(h.activity.refresh, 0);
  assert.equal(h.activity.invalidate, 0);
});

test('native cancellation messages are swallowed but unrelated errors propagate', async () => {
  for (const message of ['gateway SSO device grant cancelled', 'external IdP grant cancelled', 'Bedrock SSO grant cancelled', 'Foundry Entra device grant cancelled']) {
    const h = harness(async () => { throw new Error(message); });
    assert.deepEqual(await h.call({}), { ok: true });
    assert.equal(h.activity.refresh, 0);
  }
  const h = harness(async () => { throw new Error('fixture failure'); });
  assert.deepEqual(await h.call(undefined), { ok: false, error: 'fixture failure' });
  assert.deepEqual(h.activity.writes, []);
  assert.equal(h.activity.refresh, 0);
});

test('a cancelled request cannot refresh after late resolve or late non-abort rejection', async () => {
  for (const rejectOld of [false, true]) {
    let resolveOld, rejectOldPromise, firstSignal, calls = 0;
    const old = new Promise((resolve, reject) => { resolveOld = resolve; rejectOldPromise = reject; });
    const h = harness((_oidc, { signal }) => {
      if (++calls === 1) { firstSignal = signal; return old; }
      return Promise.resolve();
    });
    const first = h.call({});
    h.cancel();
    const second = h.call({});
    assert.equal(firstSignal.aborted, true);
    assert.deepEqual(await second, { ok: true });
    (rejectOld ? () => rejectOldPromise(new Error('late failure')) : resolveOld)();
    assert.deepEqual(await first, { ok: true });
    assert.equal(h.activity.refresh, 1);
    assert.equal(h.activity.invalidate, 1);
  }
});

test('success refreshes and bridge reports propagated AbortError as an error', async () => {
  const h = harness(async () => {});
  assert.deepEqual(await h.call({}), { ok: true });
  assert.equal(h.activity.refresh, 1);
  const failure = Object.assign(new Error('refresh failed'), { name: 'AbortError' });
  let handler;
  vm.runInNewContext(bridgeSource, {
    Error, define: (_name, fn) => { handler = fn; },
    opts: { triggerBootstrapAuth: async () => { throw failure; } },
    deploymentMode: { set: async () => {} },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await handler({}, {}))), { ok: false, error: 'refresh failed' });
});

test('cancelled login reports a failed slot rollback', async () => {
  let calls = 0;
  const h = harness((_oidc, { signal }) => {
    if (++calls > 1) return Promise.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      reject(new AggregateError([signal.reason, new Error('rollback failed')],
        'OAuth login failed and slot rollback failed'));
    }, { once: true }));
  });
  const old = h.call({});
  h.cancel();
  const replacement = h.call({});
  assert.deepEqual(await old, { ok: false, error: 'OAuth login failed and slot rollback failed' });
  assert.deepEqual(await replacement, { ok: true });
  assert.equal(h.activity.refresh, 1);
  assert.equal(h.activity.invalidate, 1);
});
