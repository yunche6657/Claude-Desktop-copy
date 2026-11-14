import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const native = fs.readFileSync(new URL('../full-replica/resources/app/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
function extract(start, end) {
  const first = native.indexOf(start), last = native.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `missing native function ${start}`);
  return native.slice(first, last);
}

test('native ordinary config write validates and writes without direct auth cleanup', async () => {
  const calls = [];
  const sandbox = {
    zF: async id => calls.push(['lookup', id]),
    ol: x => x, LLe: x => x, dl: x => x, sl: x => x,
    YLe: () => ({ issues: [] }), bl: () => false,
    FZn: async (id, config) => calls.push(['write', id, config]),
  };
  vm.createContext(sandbox);
  vm.runInContext(extract('async function BZn(', 'async function VZn('), sandbox);
  await sandbox.BZn('profile', { bootstrapUrl: 'fixture' });
  assert.deepEqual(calls, [['lookup', 'profile'], ['write', 'profile', { bootstrapUrl: 'fixture' }]]);
});

test('native selecting profile updates selection and persists 3p directly', async () => {
  const calls = [], meta = { appliedId: 'old', entries: [{ id: 'old' }, { id: 'new' }], hybridPointer: {} };
  const sandbox = { zF: async id => calls.push(['lookup', id]), RF: async fn => fn(meta),
    WF: async mode => calls.push(['mode', mode]) };
  vm.createContext(sandbox);
  vm.runInContext(extract('async function GZn(', 'async function KZn('), sandbox);
  vm.runInContext(extract('async function OMa(', 'function D8('), sandbox);
  await sandbox.OMa('new');
  assert.deepEqual(calls, [['lookup', 'new'], ['mode', '3p']]);
  assert.equal(meta.appliedId, 'new'); assert.equal('hybridPointer' in meta, false);
});

test('native explicit non-3p mode invokes full cleanup; 3p does not', async () => {
  for (const target of ['1p', '3p']) {
    const calls = [];
    const sandbox = { au: () => false, WF: async mode => calls.push(['mode', mode]),
      QZn: async () => calls.push(['cleanup']), T8: { relaunchApp: () => calls.push(['relaunch']) },
      uQn: async () => calls.push(['load']), N: { warn() {} }, P: () => 'fixture' };
    vm.createContext(sandbox);
    vm.runInContext(extract('async function lQn(', 'async function uQn('), sandbox);
    await sandbox.lQn(target, {});
    assert.deepEqual(calls, target === '1p' ? [['mode', '1p'], ['cleanup'], ['relaunch']] : [['mode', '3p']]);
  }
});

test('native token clear invalidates Lw and clears authentication state', async () => {
  const calls = [];
  const store = { delete: key => calls.push(['delete', key]) };
  const sandbox = { Promise, Njr: { resetLocalPairingIdentity: () => calls.push(['pairing']) },
    N: { error() {} }, Lw: { invalidate: () => calls.push(['generation']) },
    $tn: () => Promise.resolve('revoked'), Iw: { fixture: 1 }, Bw: 'old', Vw: 3,
    Fw: new Map([['old', 1]]), Aw: () => store, kw: 'fixture', Mw: {}, Nw: {},
    _tn: { clear: () => calls.push(['refresh-locks']) }, Pw: { clear: () => calls.push(['login-locks']) } };
  vm.createContext(sandbox);
  vm.runInContext(extract('function Xtn()', 'function Ztn()'), sandbox);
  assert.equal(await sandbox.Xtn(), 'revoked');
  assert.ok(calls.some(([kind]) => kind === 'generation'));
  assert.ok(calls.some(([kind]) => kind === 'delete'));
  assert.ok(calls.some(([kind]) => kind === 'refresh-locks'));
  assert.ok(calls.some(([kind]) => kind === 'login-locks'));
  assert.equal(sandbox.Mw, null); assert.equal(sandbox.Nw, undefined);
  assert.equal(sandbox.Fw.size, 0);
});

test('native QZn schedules controller, token and hybrid identity cleanup', async () => {
  const calls = [];
  const sandbox = { YZn: [], fO: { getDeploymentMode: () => ({
    cancelInteractiveAuth: () => calls.push('cancel'), revokeInteractiveAuth: async () => calls.push('revoke'),
  }) }, ctn: { clearBootstrapToken: async () => calls.push('token') },
  GF: { purgeHybridAnthropicState: async () => calls.push('state') },
  T5t: { clearHybridMemberships: async () => calls.push('memberships') },
  KC: { clearHybridIdentity: async () => calls.push('identity') },
  T6t: { clearHybridModelSelector: async () => calls.push('selector') },
  cQn: async () => calls.push('partial'), N: { warn() {} }, Xx: {}, P: () => 'fixture' };
  vm.createContext(sandbox);
  vm.runInContext(`var ${extract('XZn=[', 'async function eQn(')}`, sandbox);
  await sandbox.QZn();
  assert.deepEqual([...calls].sort(), ['cancel', 'identity', 'memberships', 'partial', 'revoke', 'selector', 'state', 'token']);
});
