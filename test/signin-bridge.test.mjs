// Bridge wiring for subscription sign-in.
//
//  * Custom3pSetup.signInWithAnthropicApi used to have no handler, so the generic fallback
//    answered null and the UI always said "Sign-in failed unexpectedly".
//  * The usage request used to go to ANTHROPIC_BASE_URL. Pointing the agent at a third-party
//    gateway would therefore have sent the user's subscription OAuth token to that gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { createAccountStore } = require('../desktop/account-store.cjs');

function makeBridge({ accountStore, openExternal } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-signin-'));
  const handlers = new Map();
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const store = accountStore || createAccountStore({ filePath: path.join(dir, 'accounts.json') });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  const api = registerBridgeServices({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel, dataDir: dir },
    frontend: { root: process.cwd() },
    accountStore: store,
    openExternal,
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find((c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`));
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { call, api, store, handlers, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const goodTokens = {
  accessToken: 'at-sub', refreshToken: 'rt-sub', expiresAt: 10_000_000_000,
  scopes: ['user:profile', 'user:inference'], account: { uuid: 'u1', email: 'me@example.com' }, organization: null,
};

// ---- signInWithAnthropicApi ---------------------------------------------------------------------

test('a successful sign-in answers {ok:true} and stores the account', async () => {
  const oauth = { startLoginFlow: async () => goodTokens, needsRefresh: () => false };
  const { call, store, dir, cleanup } = makeBridge({
    accountStore: createAccountStore({ filePath: path.join(os.tmpdir(), `fx-s-${Date.now()}.json`), oauth }),
    openExternal: async () => {},
  });
  try {
    const result = await call('Custom3pSetup', 'signInWithAnthropicApi');
    assert.deepEqual(result, { ok: true });
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].email, 'me@example.com');
  } finally { fs.rmSync(store.filePath, { force: true }); cleanup(); }
});

test('a failed sign-in answers an errorKind the UI understands, never null', async () => {
  const oauth = { startLoginFlow: async () => { const e = new Error('t'); e.kind = 'timeout'; throw e; }, needsRefresh: () => false };
  const { call, store, cleanup } = makeBridge({
    accountStore: createAccountStore({ filePath: path.join(os.tmpdir(), `fx-f-${Date.now()}.json`), oauth }),
    openExternal: async () => {},
  });
  try {
    const result = await call('Custom3pSetup', 'signInWithAnthropicApi');
    assert.deepEqual(result, { ok: false, errorKind: 'ERR_PKCE_CALLBACK_TIMEOUT' });
  } finally { fs.rmSync(store.filePath, { force: true }); cleanup(); }
});

test('the sign-in answer never carries a token', async () => {
  const oauth = { startLoginFlow: async () => goodTokens, needsRefresh: () => false };
  const { call, store, cleanup } = makeBridge({
    accountStore: createAccountStore({ filePath: path.join(os.tmpdir(), `fx-t-${Date.now()}.json`), oauth }),
    openExternal: async () => {},
  });
  try {
    assert.equal(/at-sub|rt-sub/.test(JSON.stringify(await call('Custom3pSetup', 'signInWithAnthropicApi'))), false);
  } finally { fs.rmSync(store.filePath, { force: true }); cleanup(); }
});

test('two sign-ins at once share one flow instead of opening two listeners', async () => {
  let started = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const oauth = { startLoginFlow: async () => { started += 1; await gate; return goodTokens; }, needsRefresh: () => false };
  const { call, store, cleanup } = makeBridge({
    accountStore: createAccountStore({ filePath: path.join(os.tmpdir(), `fx-c-${Date.now()}.json`), oauth }),
    openExternal: async () => {},
  });
  try {
    const a = call('Custom3pSetup', 'signInWithAnthropicApi');
    const b = call('Custom3pSetup', 'signInWithAnthropicApi');
    release();
    assert.deepEqual(await a, { ok: true });
    assert.deepEqual(await b, { ok: true });
    assert.equal(started, 1, 'a second click must not start a second flow');
    // ...and once finished, a later sign-in may start a new one.
    await call('Custom3pSetup', 'signInWithAnthropicApi');
    assert.equal(started, 2);
  } finally { fs.rmSync(store.filePath, { force: true }); cleanup(); }
});

test('without a way to open a browser the sign-in fails cleanly', async () => {
  // openBrowser throwing must surface as an errorKind, not hang waiting for a callback.
  const oauth = { startLoginFlow: async ({ openBrowser }) => { await openBrowser('https://claude.com/x'); return goodTokens; }, needsRefresh: () => false };
  const { call, store, cleanup } = makeBridge({
    accountStore: createAccountStore({ filePath: path.join(os.tmpdir(), `fx-n-${Date.now()}.json`), oauth }),
    openExternal: undefined,
  });
  try {
    const result = await call('Custom3pSetup', 'signInWithAnthropicApi');
    assert.equal(result.ok, false);
    assert.ok(result.errorKind.startsWith('ERR_'));
  } finally { fs.rmSync(store.filePath, { force: true }); cleanup(); }
});

test('only https URLs are ever handed to the browser', async () => {
  const opened = [];
  const oauth = { startLoginFlow: async ({ openBrowser }) => { await openBrowser('http://claude.com/insecure'); return goodTokens; }, needsRefresh: () => false };
  const { call, store, cleanup } = makeBridge({
    accountStore: createAccountStore({ filePath: path.join(os.tmpdir(), `fx-h-${Date.now()}.json`), oauth }),
    openExternal: async (u) => { opened.push(u); },
  });
  try {
    const result = await call('Custom3pSetup', 'signInWithAnthropicApi');
    assert.equal(result.ok, false);
    assert.deepEqual(opened, [], 'a non-https URL must never reach the browser');
  } finally { fs.rmSync(store.filePath, { force: true }); cleanup(); }
});

// ---- the token must only ever go to Anthropic -----------------------------------------------------

test('the usage request goes to Anthropic even when a third-party gateway is configured', async () => {
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.third-party.example';
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init && init.headers && init.headers.authorization });
    return { ok: true, async json() { return { five_hour: { utilization: 1, resets_at: 1 } }; } };
  };
  const oauth = { needsRefresh: () => false };
  const store = createAccountStore({ filePath: path.join(os.tmpdir(), `fx-g-${Date.now()}.json`), oauth });
  store.upsertFromTokens(goodTokens);
  const { call, cleanup } = makeBridge({ accountStore: store, openExternal: async () => {} });
  try {
    await call('ClaudeCode', 'getPeriodUsage');
    assert.equal(seen.length, 1);
    assert.equal(new URL(seen[0].url).hostname, 'api.anthropic.com',
      `the subscription token must not be sent to ${seen[0].url}`);
    assert.equal(seen[0].auth, 'Bearer at-sub');
  } finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = previous;
    fs.rmSync(store.filePath, { force: true });
    cleanup();
  }
});

test('the signed-in account feeds the usage request ahead of other token sources', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(init.headers.authorization); return { ok: false, async json() { return {}; } }; };
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token';
  const store = createAccountStore({ filePath: path.join(os.tmpdir(), `fx-p-${Date.now()}.json`), oauth: { needsRefresh: () => false } });
  store.upsertFromTokens(goodTokens);
  const { call, cleanup } = makeBridge({ accountStore: store, openExternal: async () => {} });
  try {
    await call('ClaudeCode', 'getPeriodUsage');
    assert.deepEqual(seen, ['Bearer at-sub']);
  } finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
    fs.rmSync(store.filePath, { force: true });
    cleanup();
  }
});

// ---- the multi-account surface is ours, not the shipped contract ----------------------------------

test('the account list/switch surface is NOT a bridge channel and NOT in bridge-map', () => {
  const { handlers, api, cleanup } = makeBridge({ openExternal: async () => {} });
  try {
    const leaked = [...handlers.keys()].filter((k) => /listAccounts|switchAccount|setActiveAccount|importTokens/i.test(k));
    assert.deepEqual(leaked, []);
    assert.equal(typeof api.accounts.list, 'function');
    assert.equal(typeof api.accounts.setActive, 'function');
    const map = require('../desktop/shim/bridge-map.json');
    const flat = JSON.stringify(map);
    assert.equal(/importTokens|switchAccount|listAccounts/.test(flat), false);
  } finally { cleanup(); }
});

test('imported tokens become an account and are listed without secrets', () => {
  const { api, cleanup } = makeBridge({ openExternal: async () => {} });
  try {
    const view = api.accounts.importTokens(goodTokens, { label: 'Work' });
    assert.equal(view.label, 'Work');
    assert.equal(view.source, 'import');
    assert.equal(/at-sub|rt-sub/.test(JSON.stringify(api.accounts.list())), false);
  } finally { cleanup(); }
});
