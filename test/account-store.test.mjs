// Subscription account store + sign-in glue (desktop/account-store.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createAccountStore, errorKindFor } = require('../desktop/account-store.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fx-acct-'));
const tokens = (n, extra = {}) => ({
  accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: 10_000_000_000,
  scopes: ['user:profile', 'user:inference'],
  account: { uuid: `uuid-${n}`, email: `u${n}@example.com` },
  organization: { uuid: `org-${n}`, name: `Org ${n}` },
  ...extra,
});

function make(overrides = {}) {
  const dir = tmp();
  const filePath = path.join(dir, 'accounts.json');
  const store = createAccountStore({ filePath, ...overrides });
  return { store, dir, filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---- error mapping: the contract with the shipped sign-in UI ------------------------------

test('every OAuth failure maps to an errorKind the UI actually switches on', () => {
  const cases = [
    [{ kind: 'timeout' }, 'ERR_PKCE_CALLBACK_TIMEOUT'],
    [{ kind: 'refused', message: 'authorization refused: access_denied' }, 'ERR_PKCE_ACCESS_DENIED'],
    [{ kind: 'refused', message: 'authorization refused: server_error' }, 'ERR_PKCE_AUTHORIZE_ERROR'],
    [{ kind: 'state_mismatch' }, 'ERR_PKCE_NO_CODE'],
    [{ kind: 'invalid_code' }, 'ERR_FAILED'],
    [{ kind: 'http_error' }, 'ERR_NETWORK'],
    [{ kind: 'cancelled' }, 'ERR_CANCELLED'],
    [{ code: 'EADDRINUSE' }, 'ERR_SIGN_IN_PORT_IN_USE'],
    [{ code: 'EACCES' }, 'ERR_SIGN_IN_PORT_UNAVAILABLE'],
    [{ code: 'ENOTFOUND' }, 'ERR_NETWORK'],
    [new Error('who knows'), 'ERR_FAILED'],
    [null, 'ERR_FAILED'],
  ];
  for (const [err, expected] of cases) assert.equal(errorKindFor(err), expected, JSON.stringify(err));
});

test('the user closing the flow is "cancelled", never a displayed failure', () => {
  // The UI returns undefined (no message) for ERR_CANCELLED -- mapping a cancel to a generic
  // failure would pop an error at someone who just changed their mind.
  assert.equal(errorKindFor({ kind: 'cancelled' }), 'ERR_CANCELLED');
});

test('the kinds we emit all exist in the frontend switch', () => {
  // Read straight from the shipped bundle so a typo here cannot pass silently.
  //
  // The bundle FILE NAME contains a build hash and changes on every app update (the installed
  // app moved 3.1623.1.0 -> 3.6556.2.0 during one session). A hard-coded name turns an app
  // update into a red test that says nothing about our code, so discover it instead — and if
  // the assets are missing entirely, skip with a reason that names the real problem.
  const assetsDir = path.join(process.cwd(), 'resources', 'ion-dist', 'assets');
  const findBundle = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findBundle(full);
        if (found) return found;
      } else if (/^shared-1-.*\.js$/.test(entry.name)) {
        return full;
      }
    }
    return null;
  };
  const bundlePath = findBundle(assetsDir);
  assert.ok(bundlePath,
    'no shared-1 bundle under resources/ion-dist/assets — the ion-dist junction is probably stale '
    + '(repoint it at the currently installed Claude app)');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const emitted = ['ERR_PKCE_CALLBACK_TIMEOUT', 'ERR_PKCE_ACCESS_DENIED', 'ERR_PKCE_AUTHORIZE_ERROR', 'ERR_PKCE_NO_CODE',
    'ERR_FAILED', 'ERR_NETWORK', 'ERR_CANCELLED', 'ERR_SIGN_IN_PORT_IN_USE', 'ERR_SIGN_IN_PORT_UNAVAILABLE'];
  for (const k of emitted) assert.ok(bundle.includes(`"${k}"`), `${k} is not handled by the shipped UI`);
});

// ---- multi-account bookkeeping ---------------------------------------------------------------

test('the first account becomes active; later ones do not steal it unless asked', () => {
  const { store, cleanup } = make();
  try {
    store.upsertFromTokens(tokens(1));
    store.upsertFromTokens(tokens(2), { makeActive: false });
    const list = store.list();
    assert.equal(list.length, 2);
    assert.equal(list.filter((a) => a.active).length, 1, 'exactly one account is active');
    assert.equal(list.find((a) => a.active).email, 'u1@example.com');
  } finally { cleanup(); }
});

test('signing in again with the same account updates it instead of duplicating', () => {
  const { store, cleanup } = make();
  try {
    const a = store.upsertFromTokens(tokens(1));
    const b = store.upsertFromTokens(tokens(1, { accessToken: 'at-new' }));
    assert.equal(a.id, b.id);
    assert.equal(store.list().length, 1);
  } finally { cleanup(); }
});

test('a first UUID binds the matching email-only account without losing its organization or omitted credentials', () => {
  const { store, filePath, cleanup } = make();
  try {
    const original = store.upsertFromTokens(tokens(1, {account:{email:'fixture@example.invalid'}}));
    const updated = store.upsertFromTokens({account:{uuid:'fixture-uuid',email:'fixture@example.invalid'}});
    assert.equal(updated.id, original.id);
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.getActiveIdentity(), {accountId:'fixture-uuid',orgId:'org-1'});
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts[0];
    assert.equal(saved.accessToken, 'at-1');
    assert.equal(saved.refreshToken, 'rt-1');
    assert.equal(saved.expiresAt, 10_000_000_000);
    assert.deepEqual(saved.scopes, ['user:profile', 'user:inference']);
    assert.equal(saved.organizationName, 'Org 1');
  } finally { cleanup(); }
});

test('UUID match wins over an email-only record and different UUIDs do not merge', () => {
  const { store, cleanup } = make();
  try {
    const anonymous = store.upsertFromTokens(tokens(1, {account:{email:'shared@example.invalid'}}));
    const a = store.upsertFromTokens(tokens(2, {account:{uuid:'uuid-a',email:'other@example.invalid'}}));
    const again = store.upsertFromTokens(tokens(3, {account:{uuid:'uuid-a',email:'shared@example.invalid'}}));
    assert.equal(again.id, a.id);
    assert.notEqual(again.id, anonymous.id);
    const b = store.upsertFromTokens(tokens(4, {account:{uuid:'uuid-b',email:'shared@example.invalid'}}));
    assert.equal(b.id, anonymous.id);
    const c = store.upsertFromTokens(tokens(5, {account:{uuid:'uuid-c',email:'shared@example.invalid'}}));
    assert.notEqual(c.id, a.id);
    assert.notEqual(c.id, b.id);
    assert.equal(store.list().length, 3);
  } finally { cleanup(); }
});

test('a new access token without a refresh token cannot reuse the previous grant', () => {
  const {store, filePath, cleanup} = make();
  try {
    store.upsertFromTokens(tokens(1));
    const account = {uuid:'uuid-1',email:'u1@example.com'};
    store.upsertFromTokens({account, accessToken:'at-1'});
    let saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts[0];
    assert.equal(saved.refreshToken, 'rt-1');
    store.upsertFromTokens({account});
    saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts[0];
    assert.equal(saved.refreshToken, 'rt-1');
    store.upsertFromTokens({account, accessToken:'at-new'});
    saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts[0];
    assert.equal(saved.accessToken, 'at-new');
    assert.equal(saved.refreshToken, null);
    store.upsertFromTokens({account, accessToken:'at-next', refreshToken:'rt-next'});
    saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts[0];
    assert.equal(saved.refreshToken, 'rt-next');
  } finally { cleanup(); }
});

test('organization selection only updates local state and does not establish token authorization', () => {
  const {store, filePath, cleanup} = make();
  try {
    store.upsertFromTokens(tokens(1));
    store.upsertFromTokens(tokens(1, {organization:{uuid:'org-2', name:'Org 2'}}));
    const before = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts[0];
    assert.equal(store.setActiveOrganization('uuid-1', 'org-1'), true);
    const after = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts[0];
    assert.equal(after.activeOrganizationUuid, 'org-1');
    assert.equal(after.accessToken, before.accessToken);
    assert.equal(after.refreshToken, before.refreshToken);
    assert.equal(Object.hasOwn(after, 'tokenOrganizationUuid'), false);
  } finally { cleanup(); }
});

test('setActive switches the active account and rejects unknown ids', () => {
  const { store, cleanup } = make();
  try {
    store.upsertFromTokens(tokens(1));
    const second = store.upsertFromTokens(tokens(2), { makeActive: false });
    assert.equal(store.setActive(second.id), true);
    assert.equal(store.list().find((a) => a.active).email, 'u2@example.com');
    assert.equal(store.setActive('acct_nope'), false);
    assert.equal(store.list().filter((a) => a.active).length, 1);
  } finally { cleanup(); }
});

test('removing the active account falls back to another, never to nothing', () => {
  const { store, cleanup } = make();
  try {
    const first = store.upsertFromTokens(tokens(1));
    store.upsertFromTokens(tokens(2), { makeActive: false });
    assert.equal(store.remove(first.id), true);
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].active, true, 'a remaining account must become active');
  } finally { cleanup(); }
});

test('removing the last account leaves no active id, and unknown ids are refused', () => {
  const { store, cleanup } = make();
  try {
    const only = store.upsertFromTokens(tokens(1));
    assert.equal(store.remove('acct_nope'), false);
    assert.equal(store.remove(only.id), true);
    assert.deepEqual(store.list(), []);
  } finally { cleanup(); }
});

// ---- secrecy -----------------------------------------------------------------------------------

test('the public view never contains a token', () => {
  const { store, cleanup } = make();
  try {
    store.upsertFromTokens(tokens(1));
    const json = JSON.stringify(store.list());
    assert.equal(/at-1|rt-1|accessToken|refreshToken/.test(json), false, json);
  } finally { cleanup(); }
});

test('the file on disk is written atomically and leaves no temp files', () => {
  const { store, dir, filePath, cleanup } = make();
  try {
    store.upsertFromTokens(tokens(1));
    store.upsertFromTokens(tokens(2));
    assert.deepEqual(fs.readdirSync(dir), ['accounts.json'], 'no leftover .tmp files');
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts.length, 2);
  } finally { cleanup(); }
});

test('a corrupt store file is treated as empty, not as a crash', () => {
  const { store, filePath, cleanup } = make();
  try {
    fs.writeFileSync(filePath, '{ not json');
    assert.deepEqual(store.list(), []);
    // ...and it can recover by writing a fresh one.
    store.upsertFromTokens(tokens(1));
    assert.equal(store.list().length, 1);
  } finally { cleanup(); }
});

// ---- token handout and refresh ---------------------------------------------------------------------

test('a valid token is returned without calling the network', async () => {
  let calls = 0;
  const { store, cleanup } = make({ fetchImpl: async () => { calls += 1; throw new Error('should not be called'); }, now: () => 1000 });
  try {
    store.upsertFromTokens(tokens(1, { expiresAt: 1000 + 60 * 60 * 1000 }));
    assert.equal(await store.getActiveAccessToken(), 'at-1');
    assert.equal(calls, 0);
  } finally { cleanup(); }
});

test('an expiring token is refreshed, persisted, and the new refresh token kept', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { status: 200, ok: true, async json() { return { access_token: 'at-fresh', refresh_token: 'rt-rotated', expires_in: 3600 }; } };
  };
  const { store, filePath, cleanup } = make({ fetchImpl, now: () => 5_000_000 });
  try {
    store.upsertFromTokens(tokens(1, { expiresAt: 5_000_000 + 60_000 }));   // inside the 5 min margin
    assert.equal(await store.getActiveAccessToken(), 'at-fresh');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].grant_type, 'refresh_token');
    assert.equal(calls[0].refresh_token, 'rt-1');
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts[0];
    assert.equal(saved.accessToken, 'at-fresh');
    assert.equal(saved.refreshToken, 'rt-rotated', 'the rotated refresh token must be persisted');
  } finally { cleanup(); }
});

test('a rejected refresh token yields null, never the stale access token', async () => {
  const fetchImpl = async () => ({ status: 400, ok: false, async json() { return {}; } });
  const { store, cleanup } = make({ fetchImpl, now: () => 5_000_000 });
  try {
    store.upsertFromTokens(tokens(1, { expiresAt: 5_000_000 - 1 }));
    assert.equal(await store.getActiveAccessToken(), null);
    assert.equal(store.list().length, 1, 'the account is kept so the UI can ask the user to sign in again');
  } finally { cleanup(); }
});

test('an expired token with no refresh token yields null', async () => {
  const { store, cleanup } = make({ now: () => 5_000_000 });
  try {
    store.upsertFromTokens(tokens(1, { expiresAt: 1, refreshToken: null }));
    assert.equal(await store.getActiveAccessToken(), null);
  } finally { cleanup(); }
});

test('no active account yields null', async () => {
  const { store, cleanup } = make();
  try { assert.equal(await store.getActiveAccessToken(), null); } finally { cleanup(); }
});

test('a refresh does not clobber changes made while it was in flight', async () => {
  // While the network call is pending another account is added; the refreshed write must be
  // merged into the CURRENT file, not into the snapshot taken before the await.
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async () => { await gate; return { status: 200, ok: true, async json() { return { access_token: 'at-fresh', expires_in: 3600 }; } }; };
  const { store, cleanup } = make({ fetchImpl, now: () => 5_000_000 });
  try {
    store.upsertFromTokens(tokens(1, { expiresAt: 5_000_000 + 1000 }));
    const pending = store.getActiveAccessToken();
    store.upsertFromTokens(tokens(2), { makeActive: false });   // happens during the refresh
    release();
    assert.equal(await pending, 'at-fresh');
    assert.equal(store.list().length, 2, 'the account added mid-refresh must survive');
  } finally { cleanup(); }
});

test('a refresh cannot return a token after an account switch and switch back', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const fetchImpl = async () => { await gate; return { status: 200, ok: true, async json() { return { access_token:'old-result', refresh_token:'rotated', expires_in:3600 }; } }; };
  const {store, filePath, cleanup} = make({fetchImpl, now:() => 5_000_000});
  try {
    const a = store.upsertFromTokens(tokens(1, {expiresAt: 1}));
    const b = store.upsertFromTokens(tokens(2), {makeActive:false});
    const pending = store.getActiveAccessToken();
    store.setActive(b.id);
    store.setActive(a.id);
    release();
    assert.equal(await pending, null);
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts.find(x => x.id === a.id);
    assert.equal(saved.accessToken, 'old-result');
    assert.equal(saved.refreshToken, 'rotated');
  } finally { cleanup(); }
});

test('concurrent callers share one rotating refresh and failure can be retried', async () => {
  let release;
  let calls = 0;
  const gate = new Promise(r => { release = r; });
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { status: 400, ok: false, async json() { return {}; } };
    await gate;
    return { status: 200, ok: true, async json() { return { access_token:'fresh', refresh_token:'rotated', expires_in:3600 }; } };
  };
  const {store, filePath, cleanup} = make({fetchImpl, now:() => 5_000_000});
  try {
    store.upsertFromTokens(tokens(1, {expiresAt:1}));
    assert.equal(await store.getActiveAccessToken(), null);
    const requests = Array.from({length:10}, () => store.getActiveAccessToken());
    assert.equal(calls, 2);
    release();
    assert.deepEqual(await Promise.all(requests), Array(10).fill('fresh'));
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts[0];
    assert.equal(saved.refreshToken, 'rotated');
  } finally { cleanup(); }
});

test('callers on either side of a selection change share rotation but retain their own guard', async () => {
  let release;
  let calls = 0;
  const gate = new Promise(r => { release = r; });
  const fetchImpl = async () => { calls++; await gate; return {status:200, ok:true, async json() { return {access_token:'fresh', refresh_token:'rotated', expires_in:3600}; }}; };
  const {store, cleanup} = make({fetchImpl, now:() => 5_000_000});
  try {
    const a = store.upsertFromTokens(tokens(1, {expiresAt:1}));
    const b = store.upsertFromTokens(tokens(2), {makeActive:false});
    const first = store.getActiveAccessToken();
    store.setActive(b.id);
    store.setActive(a.id);
    const second = store.getActiveAccessToken();
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), [null, 'fresh']);
  } finally { cleanup(); }
});

test('a delayed refresh cannot overwrite a newly authorised token for the same account', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const fetchImpl = async () => { await gate; return { status: 200, ok: true, async json() { return { access_token:'old-result', refresh_token:'old-rotated', expires_in:3600 }; } }; };
  const {store, filePath, cleanup} = make({fetchImpl, now:() => 5_000_000});
  try {
    store.upsertFromTokens(tokens(1, {expiresAt:1}));
    const pending = store.getActiveAccessToken();
    store.upsertFromTokens(tokens(1, {accessToken:'new-token', refreshToken:'new-refresh', expiresAt:9_000_000}));
    release();
    assert.equal(await pending, null);
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).accounts[0];
    assert.equal(saved.accessToken, 'new-token');
    assert.equal(saved.refreshToken, 'new-refresh');
  } finally { cleanup(); }
});

// ---- sign in ---------------------------------------------------------------------------------------

test('signIn stores the account and reports it without tokens', async () => {
  const oauth = { startLoginFlow: async () => tokens(7), needsRefresh: () => false };
  const { store, cleanup } = make({ oauth });
  try {
    const r = await store.signIn({ openBrowser: async () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.account.email, 'u7@example.com');
    assert.equal(/at-7|rt-7/.test(JSON.stringify(r)), false);
    assert.equal(store.list().length, 1);
  } finally { cleanup(); }
});

test('signIn maps a failed flow to an errorKind and stores nothing', async () => {
  const oauth = { startLoginFlow: async () => { const e = new Error('x'); e.kind = 'timeout'; throw e; }, needsRefresh: () => false };
  const { store, cleanup } = make({ oauth });
  try {
    const r = await store.signIn({ openBrowser: async () => {} });
    assert.deepEqual(r, { ok: false, errorKind: 'ERR_PKCE_CALLBACK_TIMEOUT' });
    assert.deepEqual(store.list(), []);
  } finally { cleanup(); }
});
