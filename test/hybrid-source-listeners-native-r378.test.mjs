import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const native = fs.readFileSync(new URL('../full-replica/resources/app/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
function extract(start, end) {
  const a = native.indexOf(start), b = native.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing ${start}`);
  return native.slice(a, b);
}

test('native rebuild dispatches the actual bootstrap and feature listeners', async () => {
  const calls = [], listeners = new Set();
  const context = {
    tGe: listeners, fUe: () => 'signature', UWe: () => calls.push('placement'), gWe: x => x,
    N: { error: (...args) => calls.push(['error', ...args]), info() {} }, Xx: {},
    Pv: 'network', Nv: { allowed: { value: 'fixture' } },
    G: () => ({ hardcodedMainGrowthBookFeatures: () => ({ forced: { value: true } }) }),
    Zzt: () => calls.push('projection'),
    rZt: () => {}, rd: () => {}, cvn: () => 'marketplaces', svn: () => calls.push('catalog'),
    JWe: () => ['bootstrap.url'], Oon: () => true,
  };
  vm.createContext(context);
  vm.runInContext(extract('function Hu(', 'function iGe('), context);
  vm.runInContext(extract('function nBt(', 'async function rBt('), context);
  const schedule = extract('scheduleBootstrapRepolls(){', 'armBootstrapPoll(){');
  const reconcile = extract('reconcileAfterRebuild(){', 'clearPendingServed(){');
  vm.runInContext(`class Fixture { ${schedule} ${reconcile} }; this.Fixture = Fixture`, context);
  const host = new context.Fixture();
  Object.assign(host, {
    _bootstrapState: { configured: false }, _policyDrift: [],
    publishBootstrapBundle: async () => calls.push('publish'),
    resyncMarketplacesIfChanged: () => calls.push('marketplaces'),
    armBootstrapPoll: () => calls.push('poll'),
    syncRelaunch: () => ({ relaunchDeadlineAt: undefined }),
    configRestartPending: () => false,
    notifyBootstrapListeners: () => calls.push('notify'),
  });
  context.Hu(context.nBt);
  host.scheduleBootstrapRepolls();
  calls.length = 0;
  context.rGe({ managedTier: {}, managedTierReports: [], source: {} });
  await Promise.resolve();
  assert.deepEqual(calls, ['placement', 'projection', 'notify', 'publish', 'catalog', 'marketplaces']);
  assert.equal(listeners.size, 2);
});

test('native response cache is keyed by source URL after a delayed old result', async () => {
  let config = { bootstrap: { url: 'https://old.invalid', enabled: true } }, resolveOld, requests = 0, epoch = 0;
  const context = { K: () => config, Mw: null, Nw: null, Date, dtn: 60000, enn: value => value,
    Lw: { capture: () => { const captured = epoch; return () => captured !== epoch; } },
    mtn: () => true, Etn: async url => {
      if (++requests === 1) await new Promise(resolve => { resolveOld = resolve; });
      return { ok: true, sourceUrl: url, value: {} };
    } };
  vm.createContext(context);
  vm.runInContext(extract('async function ytn(', 'function btn('), context);
  const old = context.ytn(); await Promise.resolve();
  config = { bootstrap: { url: 'https://new.invalid', enabled: true } };
  resolveOld(); await old;
  assert.equal(context.Mw.value.sourceUrl, 'https://old.invalid');
  await context.ytn();
  assert.equal(requests, 2);
  assert.equal(context.Mw.value.sourceUrl, 'https://new.invalid');
  assert.equal(epoch, 0);
});
