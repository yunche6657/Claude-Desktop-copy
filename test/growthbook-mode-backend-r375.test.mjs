import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hybridEnabled, createGrowthBookModeBackend } = require('../desktop/growthbook-mode-backend.cjs');
const { createMainGrowthBookRuntime } = require('../desktop/main-growthbook-runtime.cjs');
const common = { appVersion: '1.2.3-test', totalMemoryBytes: 8 * 1024 ** 3 };
const timer = { setTimer: () => ({ unref() {} }), clearTimer() {} };
const absent = Symbol('absent');

test('hybrid activation respects original host, authority, port, enabled and dev boundaries', () => {
  const cases = [
    ['https://api.anthropic.com/v1', {}, true], ['https://api-staging.anthropic.com', {}, true],
    ['https://api.claude.ai', {}, true], ['https://API.ANTHROPIC.COM:443/x', {}, true],
    ['http://api.anthropic.com:80', {}, true], ['https://api.anthropic.com:444', {}, false],
    ['https://api.anthropic.com.evil.invalid', {}, false], ['https://user@api.anthropic.com/', {}, false],
    ['https://user:pass@api.anthropic.com/', {}, false], ['https://api.anthropic.com\\@evil.invalid/', {}, false],
    ['https://api.anthropic.com\\evil.invalid/', {}, false], ['not a url', {}, false],
    ['https://localhost:3456/x', { packaged: false, developmentOrigin: 'https://localhost:3456' }, true],
    ['https://localhost:3456/x', { packaged: true, developmentOrigin: 'https://localhost:3456' }, false],
    ['https://localhost:3457/x', { packaged: false, developmentOrigin: 'https://localhost:3456' }, false],
  ];
  for (const [url, opts, expected] of cases) assert.equal(hybridEnabled({ url }, opts), expected, url);
  assert.equal(hybridEnabled({ url: 'https://api.anthropic.com', enabled: false }), false);
  assert.equal(hybridEnabled({ url: 'https://api.anthropic.com', enabled: true }), true);
  assert.equal(hybridEnabled({ enabled: true }), false);
});

test('consumer HTTP reaches runtime; switching to static retains only allowed remote and cannot resurrect filtered value', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mode-backend-r375-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url); res.end(JSON.stringify({ features: {
      '144321860': { value: 'allowed' }, '123929380': { value: false }, 'not-allowed': { value: 'secret-value' },
    } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let config = { mode: '1p' };
  const backend = createGrowthBookModeBackend({ ...common, getConfig: () => config, netFetch: fetch,
    consumerOrigin: `http://127.0.0.1:${server.address().port}` });
  const runtime = createMainGrowthBookRuntime({ getContext: backend.getContext, userData: dir, providerOptions: timer });
  try {
    assert.equal(await runtime.init(), 'success');
    assert.deepEqual(requests, ['/api/desktop/features']);
    assert.equal(runtime.getFeatureValue('144321860', absent), 'allowed');
    assert.equal(runtime.getFeatureValue('not-allowed', absent), 'secret-value');
    assert.equal(runtime.getFeatureValue('123929380', absent), false);
    config = { mode: '3p', builtinBrowserEnabled: false };
    await runtime.refreshSource(); await runtime.waitForSourceSettled();
    assert.equal(runtime.getFeatureValue('144321860', absent), 'allowed');
    assert.equal(runtime.getFeatureValue('123929380', absent), true);
    assert.equal(runtime.getFeatureValue('not-allowed', absent), absent);
    config = { mode: '3p', builtinBrowserEnabled: true };
    await runtime.refreshSource(); await runtime.waitForSourceSettled();
    assert.equal(runtime.getFeatureValue('17519066', absent), true);
    assert.equal(runtime.getFeatureValue('144321860', absent), 'allowed');
    assert.equal(runtime.getFeatureValue('not-allowed', absent), absent);
    assert.equal(requests.length, 1);
  } finally { runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('switch during first remote fetch settles static without waiting for remote and ignores late response', { timeout: 5000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mode-pending-r375-'));
  let release, started;
  const requested = new Promise(resolve => { started = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  let config = { mode: '1p' };
  const backend = createGrowthBookModeBackend({ ...common, getConfig: () => config,
    consumerOrigin: 'https://controlled.invalid', netFetch: async () => { started(); return delayed; } });
  const runtime = createMainGrowthBookRuntime({ getContext: backend.getContext, userData: dir, providerOptions: timer });
  try {
    const initial = runtime.init(); await requested;
    config = { mode: '3p', builtinBrowserEnabled: true };
    await runtime.refreshSource(); await runtime.waitForSourceSettled();
    assert.equal(runtime.getFeatureValue('17519066', absent), true);
    assert.equal(runtime.getFeatureValue('123929380', absent), true);
    release({ ok: true, json: async () => ({ features: { '123929380': { value: false }, late: { value: 'bad' } } }) });
    await initial; await runtime.waitForSourceSettled();
    assert.equal(runtime.getFeatureValue('123929380', absent), true);
    assert.equal(runtime.getFeatureValue('late', absent), absent);
  } finally { release?.(null); runtime.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('hybrid without OIDC never calls consumer fetch or uses inference credential', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mode-hybrid-r375-'));
  let count = 0;
  const backend = createGrowthBookModeBackend({ ...common,
    getConfig: () => ({ mode: '3p', bootstrap: { url: 'https://api.anthropic.com/test' }, inferenceGatewayApiKey: 'fixture-only-token' }),
    netFetch: () => { count++; throw Error('unexpected consumer transport'); },
  });
  const source = backend.getContext().source;
  const runtime = createMainGrowthBookRuntime({ getContext: backend.getContext, userData: dir, providerOptions: timer });
  try {
    assert.equal(source.kind, 'remote'); assert.equal(source.hybrid, true);
    assert.equal(await source.fetch(), null);
    assert.equal(await runtime.init(), 'network-error');
    assert.equal(count, 0);
  } finally { runtime.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});

function deferred() {
  let resolve; const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('hybrid projection change invalidates in-flight response with the same bootstrap URL', { timeout: 5000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mode-hybrid-projection-r375-'));
  const oldReply = deferred(), newReply = deferred(), startedOld = deferred(), startedNew = deferred();
  const bootstrap = { url: 'https://api.anthropic.com/bootstrap' };
  let config = { mode: '3p', bootstrap, builtinBrowserEnabled: false }, calls = 0;
  const backend = createGrowthBookModeBackend({ ...common, getConfig: () => config,
    hybridAuthedFetch: async () => { if (++calls === 1) { startedOld.resolve(); return oldReply.promise; } startedNew.resolve(); return newReply.promise; },
  });
  const runtime = createMainGrowthBookRuntime({ getContext: backend.getContext, userData: dir, providerOptions: timer });
  try {
    const oldInit = runtime.init(); await startedOld.promise;
    config = { ...config, builtinBrowserEnabled: true };
    const newer = runtime.refreshSource(); await startedNew.promise;
    newReply.resolve({ ok: true, json: async () => ({ user: {}, features: { '144321860': { value: 'new' } } }) });
    await newer; await runtime.waitForSourceSettled();
    assert.equal(runtime.getFeatureValue('17519066', absent), true);
    assert.equal(runtime.getFeatureValue('144321860', absent), 'new');
    oldReply.resolve({ ok: true, json: async () => ({ user: {}, features: { '144321860': { value: 'old' } } }) });
    await oldInit;
    assert.equal(runtime.getFeatureValue('17519066', absent), true);
    assert.equal(runtime.getFeatureValue('144321860', absent), 'new');
    assert.equal(calls, 2);
  } finally { oldReply.resolve(null); newReply.resolve(null); runtime.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('source settled barrier observes a new refresh started while awaiting account work', { timeout: 5000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mode-source-settled-r375-'));
  const accountReply = deferred(), sourceReply = deferred(), accountStarted = deferred(), sourceStarted = deferred();
  let config = { mode: '3p', builtinBrowserEnabled: false };
  const backend = createGrowthBookModeBackend({ ...common, getConfig: () => config,
    consumerOrigin: 'https://controlled.invalid',
    netFetch: async () => { accountStarted.resolve(); return accountReply.promise; },
    hybridAuthedFetch: async () => { sourceStarted.resolve(); return sourceReply.promise; },
  });
  const runtime = createMainGrowthBookRuntime({ getContext: backend.getContext, userData: dir, providerOptions: timer });
  try {
    assert.equal(await runtime.init(), 'static');
    config = { mode: '1p' };
    const accountWork = runtime.accountChanged(); await accountStarted.promise;
    let settled = false;
    const barrier = runtime.waitForSourceSettled().then(() => { settled = true; });
    // Let the barrier reach the pending account promise before starting source work.
    await new Promise(resolve => setImmediate(resolve));
    config = { mode: '3p', bootstrap: { url: 'https://api.anthropic.com/bootstrap' }, builtinBrowserEnabled: true };
    const sourceWork = runtime.refreshSource(); await sourceStarted.promise;
    accountReply.resolve({ ok: true, json: async () => ({ features: { '144321860': { value: 'old' } } }) });
    await accountWork;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'barrier must wait for the newer source work');
    sourceReply.resolve({ ok: true, json: async () => ({ user: {}, features: { '144321860': { value: 'new' } } }) });
    await sourceWork; await barrier;
    assert.equal(settled, true);
    assert.equal(runtime.getFeatureValue('17519066', absent), true);
    assert.equal(runtime.getFeatureValue('144321860', absent), 'new');
  } finally { accountReply.resolve(null); sourceReply.resolve(null); runtime.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});
