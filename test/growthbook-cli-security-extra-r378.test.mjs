import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createMainGrowthBookRuntime}=require('../desktop/main-growthbook-runtime.cjs');
const {createGrowthBookProvider}=require('../desktop/growthbook-provider.cjs');
const {createCliMcpGateSource}=require('../desktop/cli-mcp-host-sources.cjs');
const key='513873720';
const feature=on=>({on,value:on});
const reply=on=>({ok:true,json:async()=>({features:{[key]:feature(on)}})});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const timerOptions={setTimer:()=>1,clearTimer(){}};
test('static forced gate overrides the opposite retained remote result',async t=>{
 for(const remote of [false,true]) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gb-forced-gate-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let source={kind:'remote',identity:'remote',fetch:async()=>reply(remote)};
  const runtime=createMainGrowthBookRuntime({userData:dir,getContext:()=>({mode:'3p',source}),providerOptions:timerOptions});
  const gate=createCliMcpGateSource();gate.attach(runtime);
  await runtime.init();assert.equal((await gate.read()).featureEnabled,remote);
  source={kind:'static',identity:'local',features:{[key]:feature(!remote)},remoteAllowedKeys:[key]};
  gate.invalidate();await runtime.refreshSource();
  const actual=await gate.read();
  assert.equal(actual.complete,true);
  assert.equal(actual.featureEnabled,!remote);
  assert.equal(runtime.getFeatureValue(key,null),!remote);
  gate.dispose();runtime.dispose();
 }
});
test('overlapping same-source refreshes cannot certify an older pending response',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gb-multiple-refresh-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const pending=[];
 const runtime=createMainGrowthBookRuntime({userData:dir,providerOptions:timerOptions,
  getContext:()=>({mode:'3p',source:{kind:'remote',identity:'same',fetch:()=>{const d=deferred();pending.push(d);return d.promise;}}})});
 const gate=createCliMcpGateSource();gate.attach(runtime);
 const init=runtime.init();pending[0].resolve(reply(true));await init;
 const old=runtime.refresh({force:true});
 gate.invalidate();const first=runtime.refreshSource();
 gate.invalidate();const second=runtime.refreshSource();
 assert.equal((await gate.read()).complete,false);
 pending[1].resolve(reply(true));await old;await first;
 assert.equal((await gate.read()).complete,false);
 assert.equal(pending.length,3);
 pending[2].resolve(reply(false));await second;
 assert.deepEqual({complete:(await gate.read()).complete,on:(await gate.read()).featureEnabled},{complete:true,on:false});
 gate.dispose();runtime.dispose();
});
test('disposing during security notification prevents later authorization and tolerates reentry',async()=>{
 const provider=createGrowthBookProvider({getContext:()=>({mode:'3p',source:{kind:'static',identity:'one',features:{[key]:feature(true)}}}),...timerOptions});
 const gate=createCliMcpGateSource();gate.attach(provider);
 const notices=[],observed=[];
 provider.onSecurityFreshnessChange(fresh=>{
  notices.push(fresh);
  if(fresh) {observed.push(provider.isSecurityFreshForCurrentSource());provider.dispose();}
 });
 await provider.init();
 assert.deepEqual(notices,[true,false]);
 assert.deepEqual(observed,[true]);
 assert.equal(provider.isSecurityFreshForCurrentSource(),false);
 assert.equal((await gate.read()).complete,false);
 gate.dispose();
});
