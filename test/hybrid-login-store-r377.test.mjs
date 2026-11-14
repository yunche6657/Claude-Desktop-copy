import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHybridOidcLogin } = require('../desktop/hybrid-oidc-login.cjs');
const { createHybridOidcStore } = require('../desktop/hybrid-oidc-store.cjs');
const { assertTokenBoundToHybridOrg } = require('../desktop/hybrid-org-binding.cjs');
const org = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const account = '12345678-aaaa-bbbb-cccc-123456789abc';
const key = crypto.randomBytes(32);
const cipher = { isEncryptionAvailable: () => true,
  encryptString: text => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
  decryptString: bytes => { const d = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); d.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString('utf8'); },
};
async function startServer() {
  const requests = []; const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/oauth/token') return res.end(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 600 }));
    if (req.url === '/api/oauth/profile') return res.end(JSON.stringify({ organization: { uuid: org.toUpperCase() }, account: { uuid: account.toUpperCase() } }));
    if (req.url === '/v1/oauth/token/revoke') return res.end('{}');
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
function makeOidc(origin) { return { storeKey: 'hybrid:fixture:org', clientId: 'fixture-client', scopes: 'user:profile org:desktop_config', authorizationUrl: 'https://identity.invalid/authorize', tokenUrl: `${origin}/v1/oauth/token`, apiOrigin: origin, orgUuid: org }; }
async function browser(url) { const auth = new URL(url), callback = new URL(auth.searchParams.get('redirect_uri')); callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code'); assert.equal((await fetch(callback)).status, 200); }

test('PKCE login, real org verification, encrypted store and reopened read form one chain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-store-r377-')), server = await startServer();
  const store = createHybridOidcStore({ userData: dir, safeStorage: cipher });
  const login = createHybridOidcLogin({ openBrowser: browser, fetch, slotStore: store, assertTokenBoundToHybridOrg, now: () => 1000 });
  try {
    const o = makeOidc(server.origin), result = await login.signIn(o);
    assert.deepEqual(result, { ok: true, accountUuid: account });
    assert.deepEqual(server.requests.map(x => x.url), ['/v1/oauth/token', '/api/oauth/profile']);
    assert.equal(server.requests[1].authorization, 'Bearer synthetic-access');
    const exchange = JSON.parse(server.requests[0].body); assert.equal(exchange.grant_type, 'authorization_code'); assert.ok(exchange.code_verifier);
    const file = fs.readFileSync(path.join(dir, 'custom3p-bootstrap-oidc.json'), 'utf8');
    assert.equal(file.includes('synthetic-access'), false); assert.equal(file.includes('synthetic-refresh'), false);
    const reopened = createHybridOidcStore({ userData: dir, safeStorage: cipher }).read(o.storeKey);
    assert.equal(reopened.accessToken, 'synthetic-access'); assert.equal(reopened.refreshToken, 'synthetic-refresh');
    assert.equal(reopened.expiresAt, 601000); assert.equal(reopened.clientId, o.clientId); assert.deepEqual(reopened.requestedScopes, ['user:profile', 'org:desktop_config']);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation during encryption keeps previous disk and memory slots, never commits new grant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-cancel-r377-'));
  let current = true, flip = false;
  const guardedCipher = { ...cipher, encryptString: text => { const out = cipher.encryptString(text); if (flip) current = false; return out; } };
  const store = createHybridOidcStore({ userData: dir, safeStorage: guardedCipher });
  try {
    store.write('same', { accessToken: 'previous' }); store.write('other', { accessToken: 'other' });
    const before = fs.readFileSync(path.join(dir, 'custom3p-bootstrap-oidc.json'));
    flip = true;
    assert.throws(() => store.write('same', { accessToken: 'stale-new' }, { isCurrent: () => current }), /context changed/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'custom3p-bootstrap-oidc.json')), before);
    assert.deepEqual(store.read('same'), { accessToken: 'previous' }); assert.deepEqual(store.read('other'), { accessToken: 'other' });
    const reopened = createHybridOidcStore({ userData: dir, safeStorage: cipher });
    assert.deepEqual(reopened.read('same'), { accessToken: 'previous' }); assert.deepEqual(reopened.read('other'), { accessToken: 'other' });
    assert.deepEqual(fs.readdirSync(dir), ['custom3p-bootstrap-oidc.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('locked encryption preserves current memory fallback and leaves disk intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-locked-r377-'));
  try {
    const store = createHybridOidcStore({ userData: dir, safeStorage: { ...cipher, isEncryptionAvailable: () => false } });
    assert.throws(() => store.write('slot', { accessToken: 'fixture' }, { isCurrent: () => true }), /encryption unavailable/);
    assert.deepEqual(store.read('slot'), { accessToken: 'fixture' }); assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation after temporary write but before rename removes temporary file and keeps old data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-prerename-r377-'));
  const store = createHybridOidcStore({ userData: dir, safeStorage: cipher });
  let current = true;
  const originalWrite = fs.writeFileSync;
  try {
    store.write('slot', { accessToken: 'old' });
    const file = path.join(dir, 'custom3p-bootstrap-oidc.json'), before = fs.readFileSync(file);
    fs.writeFileSync = (...args) => { const result = originalWrite(...args); if (String(args[0]).includes('.tmp-')) current = false; return result; };
    assert.throws(() => store.write('slot', { accessToken: 'not-committed' }, { isCurrent: () => current }), /context changed/);
    assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(store.read('slot'), { accessToken: 'old' });
    assert.deepEqual(fs.readdirSync(dir), ['custom3p-bootstrap-oidc.json']);
  } finally { fs.writeFileSync = originalWrite; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ordinary disk failure identifies retained memory and receipt removes it on cancellation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-iofailure-r377-'));
  const store = createHybridOidcStore({ userData: dir, safeStorage: cipher });
  const originalWrite = fs.writeFileSync;
  try {
    store.write('slot', { accessToken: 'old' }); store.write('other', { accessToken: 'other' });
    fs.writeFileSync = (...args) => { if (String(args[0]).includes('.tmp-')) throw Object.assign(new Error('synthetic IO'), { code: 'EIO' }); return originalWrite(...args); };
    let failure; try { store.write('slot', { accessToken: 'new' }); } catch (error) { failure = error; }
    fs.writeFileSync = originalWrite;
    assert.equal(failure.code, 'EIO'); assert.equal(failure.credentialRetained, true); assert.equal(failure.memoryOnly, true);
    assert.deepEqual(store.read('slot'), { accessToken: 'new' });
    assert.equal(failure.receipt.rollbackIfCurrent(), true);
    assert.deepEqual(store.read('slot'), { accessToken: 'old' }); assert.deepEqual(store.read('other'), { accessToken: 'other' });
    assert.deepEqual(createHybridOidcStore({ userData: dir, safeStorage: cipher }).read('slot'), { accessToken: 'old' });
  } finally { fs.writeFileSync = originalWrite; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('receipt restores own committed slot and never overwrites a later owner or other slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-receipt-r377-'));
  const store = createHybridOidcStore({ userData: dir, safeStorage: cipher });
  try {
    store.write('slot', { accessToken: 'old' }); store.write('other', { accessToken: 'other' });
    const receipt = store.write('slot', { accessToken: 'revoked' });
    store.write('other', { accessToken: 'other-new' });
    assert.equal(receipt.rollbackIfCurrent(), true);
    let reopened = createHybridOidcStore({ userData: dir, safeStorage: cipher });
    assert.deepEqual(reopened.read('slot'), { accessToken: 'old' }); assert.deepEqual(reopened.read('other'), { accessToken: 'other-new' });
    const stale = store.write('slot', { accessToken: 'older-operation' });
    store.write('slot', { accessToken: 'newer-operation' });
    assert.equal(stale.rollbackIfCurrent(), false);
    reopened = createHybridOidcStore({ userData: dir, safeStorage: cipher });
    assert.deepEqual(reopened.read('slot'), { accessToken: 'newer-operation' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unavailable encryption identifies retained memory and provides rollback receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-unavailable-r377-'));
  try {
    const store = createHybridOidcStore({ userData: dir, safeStorage: { ...cipher, isEncryptionAvailable: () => false } });
    let failure; try { store.write('slot', { accessToken: 'new' }); } catch (error) { failure = error; }
    assert.equal(failure.code, 'HYBRID_ENCRYPTION_UNAVAILABLE'); assert.equal(failure.memoryOnly, true); assert.equal(failure.credentialRetained, true);
    assert.equal(failure.receipt.rollbackIfCurrent(), true); assert.equal(store.read('slot'), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('receipt discards stale memory without overwriting another instance disk update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-cross-instance-r377-'));
  try {
    const first = createHybridOidcStore({ userData: dir, safeStorage: cipher });
    const second = createHybridOidcStore({ userData: dir, safeStorage: cipher });
    first.write('slot', { accessToken: 'old' });
    const receipt = first.write('slot', { accessToken: 'cancelled' });
    second.write('slot', { accessToken: 'new-owner' });
    assert.equal(receipt.rollbackIfCurrent(), true);
    assert.deepEqual(first.read('slot'), { accessToken: 'new-owner' });
    assert.deepEqual(second.read('slot'), { accessToken: 'new-owner' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('login retains usable in-memory grant without revocation on ordinary disk failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-memory-only-r377-')), server = await startServer();
  const originalWrite = fs.writeFileSync;
  const store = createHybridOidcStore({ userData: dir, safeStorage: cipher });
  const login = createHybridOidcLogin({ openBrowser: browser, fetch, slotStore: store, assertTokenBoundToHybridOrg });
  try {
    fs.writeFileSync = (...args) => { if (String(args[0]).startsWith(dir) && String(args[0]).includes('.tmp-')) throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' }); return originalWrite(...args); };
    const o = makeOidc(server.origin), result = await login.signIn(o);
    assert.equal(result.ok, true); assert.equal(store.read(o.storeKey).accessToken, 'synthetic-access');
    assert.equal(server.requests.filter(x => x.url.endsWith('/revoke')).length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'custom3p-bootstrap-oidc.json')), false);
  } finally { fs.writeFileSync = originalWrite; await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('login invalidated after successful commit rolls back owned grant before revocation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-rollback-r377-')), server = await startServer();
  let current = true;
  const store = createHybridOidcStore({ userData: dir, safeStorage: cipher });
  const wrapped = { write: (...args) => { const receipt = store.write(...args); current = false; return receipt; } };
  const login = createHybridOidcLogin({ openBrowser: browser, fetch, slotStore: wrapped, assertTokenBoundToHybridOrg });
  try {
    const o = makeOidc(server.origin); store.write(o.storeKey, { accessToken: 'previous' }); store.write('other', { accessToken: 'untouched' });
    await assert.rejects(login.signIn(o, { isCurrent: () => current }), /context changed/);
    assert.equal(server.requests.filter(x => x.url.endsWith('/revoke')).length, 2);
    assert.deepEqual(store.read(o.storeKey), { accessToken: 'previous' }); assert.deepEqual(store.read('other'), { accessToken: 'untouched' });
    const reopened = createHybridOidcStore({ userData: dir, safeStorage: cipher });
    assert.deepEqual(reopened.read(o.storeKey), { accessToken: 'previous' }); assert.deepEqual(reopened.read('other'), { accessToken: 'untouched' });
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('login with unavailable encryption returns error, retains valid memory and does not revoke', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-unavailable-r377-')), server = await startServer();
  const writable = createHybridOidcStore({ userData: dir, safeStorage: cipher });
  const o = makeOidc(server.origin); writable.write(o.storeKey, { accessToken: 'old-disk' }); writable.write('other', { accessToken: 'other' });
  const file = path.join(dir, 'custom3p-bootstrap-oidc.json'), before = fs.readFileSync(file);
  const store = createHybridOidcStore({ userData: dir, safeStorage: { ...cipher, isEncryptionAvailable: () => false } });
  const login = createHybridOidcLogin({ openBrowser: browser, fetch, slotStore: store, assertTokenBoundToHybridOrg });
  try {
    await assert.rejects(login.signIn(o), e => e.code === 'HYBRID_ENCRYPTION_UNAVAILABLE');
    assert.equal(store.read(o.storeKey).accessToken, 'synthetic-access');
    assert.equal(server.requests.filter(x => x.url.endsWith('/revoke')).length, 0);
    assert.deepEqual(fs.readFileSync(file), before);
    const reopened = createHybridOidcStore({ userData: dir, safeStorage: cipher });
    assert.deepEqual(reopened.read(o.storeKey), { accessToken: 'old-disk' });
    assert.deepEqual(reopened.read('other'), { accessToken: 'other' });
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('login invalidated during encryption leaves prior slot intact and revokes uncommitted grant', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-encrypt-cancel-r377-')), server = await startServer();
  let current = true, flip = false;
  const guardedCipher = { ...cipher, encryptString: text => { const encoded = cipher.encryptString(text); if (flip) current = false; return encoded; } };
  const store = createHybridOidcStore({ userData: dir, safeStorage: guardedCipher });
  const login = createHybridOidcLogin({ openBrowser: browser, fetch, slotStore: store, assertTokenBoundToHybridOrg });
  try {
    const o = makeOidc(server.origin);
    store.write(o.storeKey, { accessToken: 'previous' }); store.write('other', { accessToken: 'untouched' });
    const file = path.join(dir, 'custom3p-bootstrap-oidc.json'), before = fs.readFileSync(file);
    flip = true;
    await assert.rejects(login.signIn(o, { isCurrent: () => current }), e => e.slotUnchanged === true);
    assert.equal(server.requests.filter(x => x.url.endsWith('/revoke')).length, 2);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(store.read(o.storeKey), { accessToken: 'previous' }); assert.deepEqual(store.read('other'), { accessToken: 'untouched' });
    assert.deepEqual(createHybridOidcStore({ userData: dir, safeStorage: cipher }).read(o.storeKey), { accessToken: 'previous' });
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test('real local login binds organization before updating identity and requests relaunch only after encrypted slot commit', async () => {
 const {createHybridIdentityStore}=require('../desktop/hybrid-identity-store.cjs');
 const {createHybridIdentityController}=require('../desktop/hybrid-identity-controller.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hybrid-identity-chain-')),server=await startServer();
 const slotStore=createHybridOidcStore({userData:dir,safeStorage:cipher});
 const identityStore=createHybridIdentityStore({file:path.join(dir,'claude_desktop_config.json')});
 const oidc=makeOidc(server.origin), events=[];
 const controller=createHybridIdentityController({launchSlot:oidc.storeKey,store:identityStore,invalidateBearer:()=>events.push('invalidate'),relaunch:()=>{
   assert.equal(slotStore.read(oidc.storeKey).accessToken,'synthetic-access');
   assert.equal(identityStore.read(oidc.storeKey).accountUuid,account);events.push('relaunch');
 }});
 const login=createHybridOidcLogin({openBrowser:browser,fetch,slotStore,assertTokenBoundToHybridOrg,beforePersist:controller.beforePersist,afterPersist:controller.afterPersist});
 try {assert.deepEqual(await login.signIn(oidc),{ok:true,accountUuid:account});
  assert.deepEqual(server.requests.map(x=>x.url),['/v1/oauth/token','/api/oauth/profile']);assert.deepEqual(events,['invalidate','relaunch']);
  assert.equal(createHybridIdentityStore({file:path.join(dir,'claude_desktop_config.json')}).read(oidc.storeKey).accountUuid,account);
 } finally {login.invalidate();await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
