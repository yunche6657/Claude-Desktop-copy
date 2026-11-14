import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isReservedCliMcpName, createReservedSource, createCliMcpGateSource } = require('../desktop/cli-mcp-host-sources.cjs');
const { createGrowthBookProvider } = require('../desktop/growthbook-provider.cjs');
const { createCliMcpDiscoveryProvider } = require('../desktop/cli-mcp-discovery-provider.cjs');

test('reserved server names match the shipped kA and its actual builtin lists', () => {
  const base = path.resolve('../ccd-ref/asar/.vite/build');
  const lza = fs.readFileSync(path.join(base, 'index.chunk-lzaSYO3Q.js'), 'utf8');
  const m6 = fs.readFileSync(path.join(base, 'index.chunk-M6SkuaH9.js'), 'utf8');
  const bn = fs.readFileSync(path.join(base, 'index.chunk-Bn6onBlX.js'), 'utf8');
  const builtinStart = lza.indexOf('HXe=');
  const builtinEnd = lza.indexOf(',UXe=', builtinStart);
  const definitions = lza.slice(lza.indexOf('var mri='), lza.indexOf('function EJ(', lza.indexOf('var mri=')));
  const helpers = m6.slice(m6.indexOf('function Ne('), m6.indexOf('function Ke(', m6.indexOf('function Ne(')));
  const prefix = lza.slice(lza.indexOf('function kii('), lza.indexOf('function Mii(', lza.indexOf('function kii(')));
  const matcher = bn.slice(bn.indexOf('var DA='), bn.indexOf('var AA=', bn.indexOf('var DA=')));
  const original = vm.runInNewContext(`(()=>{let ${lza.slice(builtinStart,builtinEnd)};let MS='cowork',NS='memory',kS='dispatch',CQt='scheduled-tasks',t$t='session_info';let t={kP:'remote-devices'};${definitions}${helpers}${prefix}let n={Yu:Ue,qu:We,Ju:Ge};Object.assign(t,{xv:TJ,yv:_ri,iv:HJ});${matcher}return kA})()`);
  for (const name of ['workspace','workspace-child','memory','memory-child','claude-for-chrome','Claude Browser-extra',
    'plugin:ccd_session','mcp__local_ccd_session__read','normal','plugin:ordinary','', '---', 'a b', 'a\nb',
    'x12345678-aaaa-bbbb-cccc-123456789abc', 'remote-devices-other']) {
    assert.equal(isReservedCliMcpName(name), original(name, []), name);
  }
});

test('gate follows GrowthBook on, freshness and change notifications without treating value as on', async () => {
  let map = { '513873720': { on: false, value: true } };
  const runtime = createGrowthBookProvider({ getContext: () => ({ mode:'x', source:{ kind:'static', features:map } }) });
  const gate = createCliMcpGateSource();
  let notices = 0;
  const stop = gate.subscribe(() => { notices++; });
  gate.attach(runtime);
  assert.equal((await gate.read()).complete, false);
  await runtime.init();
  const before = await gate.read();
  assert.deepEqual({ complete: before.complete, featureEnabled: before.featureEnabled }, { complete:true, featureEnabled:false });
  map = { '513873720': { on:true, value:false } };
  runtime.sourceChanged();
  const after = await gate.read();
  assert.equal(after.featureEnabled, true);
  assert.equal(gate.isCurrent(before), false);
  assert.ok(notices > 0);
  gate.dispose();
  assert.equal((await gate.read()).complete, false);
  stop(); runtime.dispose();
});

test('actual partial main sources remain incomplete when other sources are absent', async () => {
  const gate = createCliMcpGateSource();
  const provider = createCliMcpDiscoveryProvider({ gate, reserved: createReservedSource() });
  const stop = provider.subscribe(() => {});
  assert.equal((await provider.getSnapshot({ sessionId:'fixture' })).complete, false);
  stop(); gate.dispose();
});
