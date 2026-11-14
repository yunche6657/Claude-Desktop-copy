import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createCowork3pIdentity, createCowork3pStartupIdentity} = require('../desktop/cowork-3p-identity.cjs');
const {createCoworkGlobalMemory} = require('../desktop/cowork-global-memory.cjs');
const install = '11111111-2222-4333-8444-555555555555';
const org = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const defaultOrg = '00000000-0000-4000-8000-000000000001';
const url = `https://example.test/v1/desktop/orgs/${org.toUpperCase()}/bootstrap`;

function native() {
  const source = fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
  const section = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a);
    return source.slice(a, b);
  };
  const box = {URL, JC: undefined, YC: '', qC: 'not-hybrid', SC: () => install,
    Gn: x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x),
    J5t: () => undefined};
  vm.createContext(box);
  vm.runInContext(section('function Cl(e){', 'function Gze('), box);
  vm.runInContext(section('function Z5t(e)', 'function ew()'), box);
  return (bootstrap, fallback) => box.Q5t(() => bootstrap, () => fallback);
}

test('fixed native Q5t and Cl match storage and organization IDs', async () => {
  for (const [bootstrap, fallback] of [[undefined, defaultOrg], [url, defaultOrg],
    ['https://example.test/v1/desktop/orgs/not-a-uuid/bootstrap', org],
    ['https://example.test/v1/desktop/orgs/%ZZ/bootstrap', org]]) {
    const original = native()(bootstrap, fallback);
    const get = createCowork3pIdentity({installId: install, getContext: () => ({mode: '3p', trustedHybridBootstrapUrl: bootstrap, organizationKey: fallback})});
    assert.deepEqual(await get(), {accountId: original.storageAccountUuid, orgId: original.orgUuid});
  }
  assert.throws(() => createCowork3pIdentity({installId: 'credential-or-profile', getContext() {}}), TypeError);
});

test('native SC installation file survives restart in isolated userData', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-native-install-'));
  try {
    const source = fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
    const start = source.indexOf('function SC(){'), end = source.indexOf('function q3t()', start);
    assert.ok(start >= 0 && end > start);
    function launch() {
      const box = {z3t: undefined, B3t: true, Buffer, o: {default: fs}, n: {default: path},
        a: {app: {getPath: () => dir}}, lBe: 'ant-did', f: {randomUUID: () => install},
        N: {error() {}}, R3t: 'fallback'};
      vm.createContext(box);
      vm.runInContext(source.slice(start, end), box);
      return box.SC();
    }
    const trustedId = launch();
    assert.equal(trustedId, install);
    assert.equal(launch(), trustedId);
    const get = createCowork3pIdentity({installId: trustedId, getContext: () => ({mode: '3p'})});
    assert.deepEqual(await get(), {accountId: trustedId, orgId: defaultOrg});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('isolated memory persists across recreation, mode and configuration switches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-3p-identity-'));
  let context = {mode: '3p', configId: 'profile-a'};
  const store = () => createCoworkGlobalMemory({userDataDir: dir, getAccountContext: createCowork3pIdentity({installId: install, getContext: () => context})});
  try {
    assert.equal(await store().writeGlobalMemory('shared'), true);
    context = {mode: '3p', configId: 'profile-b'};
    assert.equal(await store().readGlobalMemory(), 'shared');
    context = {mode: 'claude'};
    assert.equal(await store().readGlobalMemory(), null);
    assert.equal(await store().writeGlobalMemory('wrong mode'), false);
    context = {mode: '3p', organizationKey: org};
    assert.equal(await store().readGlobalMemory(), null);
    assert.equal(await store().writeGlobalMemory('other org'), true);
    context = {mode: '3p'};
    assert.equal(await store().readGlobalMemory(), 'shared');
    assert.equal(fs.readFileSync(path.join(dir, 'local-agent-mode-sessions', install, defaultOrg, 'memory', 'CLAUDE.md'), 'utf8'), 'shared');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('hybrid snapshot matches native launch caching; fallback remains dynamic', async () => {
  let context = {mode: '3p', trustedHybridBootstrapUrl: url};
  const get = createCowork3pIdentity({installId: install, getContext: () => context});
  const original = native();
  assert.equal((await get()).orgId, original(url, defaultOrg).orgUuid);
  context = {mode: '3p', organizationKey: defaultOrg};
  assert.equal((await get()).orgId, original(undefined, defaultOrg).orgUuid);
  context = {mode: 'claude'};
  assert.equal(await get(), null);
  context = {mode: '3p'};
  assert.equal((await get()).orgId, org);
  const fallbackGet = createCowork3pIdentity({installId: install, getContext: () => context});
  assert.equal((await fallbackGet()).orgId, defaultOrg);
  context = {mode: '3p', organizationKey: org};
  assert.equal((await fallbackGet()).orgId, org);
  context = {mode: '3p', organizationKey: '../invalid'};
  assert.equal(await fallbackGet(), null);
});

test('startup identity observes equivalent configuration and permanently invalidates on slot changes', () => {
  let current = {mode: '3p', hybrid: {url, trusted: true}, model: 'a'};
  const get = createCowork3pStartupIdentity({installId: install, launchContext: current, getCurrentContext: () => current});
  current = {mode: '3p', hybrid: {url: `https://EXAMPLE.test:443/v1/desktop/orgs/${org}/bootstrap/`, trusted: true}, model: 'b', name: 'renamed'};
  const identity = get();
  assert.equal(identity.accountId, install);
  assert.equal(identity.orgId, org);
  assert.equal(identity.isCurrent(), true);
  current = {mode: '3p', hybrid: {url: url.replace('example.test', 'other.test'), trusted: true}};
  assert.equal(get.observe(), false);
  current = {mode: '3p', hybrid: {url, trusted: true}};
  assert.equal(identity.isCurrent(), false);
  assert.equal(get(), null);
  const fresh = createCowork3pStartupIdentity({installId: install, launchContext: current, getCurrentContext: () => current});
  assert.equal(fresh().orgId, org);
  current = {mode: '1p'};
  assert.equal(fresh.observe(), false);
  current = {mode: '3p', hybrid: {url, trusted: true}};
  assert.equal(fresh(), null);
  const another = createCowork3pStartupIdentity({installId: install, launchContext: current, getCurrentContext: () => current});
  current = {mode: '3p', hybrid: {url: url.replace(org.toUpperCase(), defaultOrg), trusted: true}};
  assert.equal(another.observe(), false);
});

test('startup snapshot rejects changes before first access and never downgrades invalid hybrid', () => {
  let current = {mode: '3p', hybrid: {url, trusted: true}};
  const old = createCowork3pStartupIdentity({installId: install, launchContext: current, getCurrentContext: () => current});
  current = {mode: '3p'};
  assert.equal(old(), null);
  for (const hybrid of [
    {url, trusted: false}, {url}, {url: 'not a URL', trusted: true},
    {url: url.replace('https:', 'http:'), trusted: true},
    {url: url.replace(org.toUpperCase(), '%ZZ'), trusted: true},
    {url: url.replace('https://', 'https://user:pass@'), trusted: true}, {}, ''
  ]) {
    current = {mode: '3p', hybrid};
    const get = createCowork3pStartupIdentity({installId: install, launchContext: current, getCurrentContext: () => current});
    assert.equal(get(), null);
  }
  current = {mode: '3p'};
  const ordinary = createCowork3pStartupIdentity({installId: install, launchContext: current, getCurrentContext: () => current});
  assert.equal(ordinary().orgId, defaultOrg);
  current = {mode: '3p', hybrid: {url, trusted: false}};
  assert.equal(ordinary.observe(), false);
  current = {mode: '3p'};
  assert.equal(ordinary(), null);
});

test('startup identity fails closed on unavailable or asynchronous current source', () => {
  let source = () => { throw Error('unavailable'); };
  const get = createCowork3pStartupIdentity({installId: install, launchContext: {mode: '3p'}, getCurrentContext: () => source()});
  assert.equal(get(), null);
  source = () => ({mode: '3p'});
  assert.equal(get(), null);
  const asyncGet = createCowork3pStartupIdentity({installId: install, launchContext: {mode: '3p'}, getCurrentContext: async () => ({mode: '3p'})});
  assert.equal(asyncGet(), null);
});
