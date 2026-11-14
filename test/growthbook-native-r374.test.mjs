import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { createGrowthBookProvider, encodeFeatureCache } = require('../desktop/growthbook-provider.cjs');
const native = readFileSync(resolve('../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js'), 'utf8');
function original(start, end) {
  const a = native.indexOf(start), b = native.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing shipped source anchors ${start}`);
  return native.slice(a,b);
}
const terms = original('function Iv(){', 'var Rv,Azt,') + original('function Gv(){', 'function Kv(){') + original('function iy(){', 'function xBt(){');
function nativeState(state, stale, last, time=1000) {
  return runInNewContext(`let Pv=${JSON.stringify(state)}, Fv=${stale}, Rv=${last === undefined ? 'undefined' : last}; ${terms}; ({loaded:Gv(), fresh:iy(), within:ay(50), ready:Iv()})`, {performance:{now:()=>time}});
}
function provider(context, extra={}) {
  return createGrowthBookProvider({getContext:()=>context,setTimer:()=>({unref(){}}),clearTimer(){},now:()=>1000,monotonicNow:()=>1000,...extra});
}
test('native directly extracted states match provider static and disk readiness and freshness', async()=> {
  const stat=provider({mode:'3p',source:{kind:'static',features:{}}});
  await stat.init();
  const ns=nativeState('map-final',false,undefined);
  assert.equal(stat.areFeaturesLoaded(),ns.loaded);
  assert.equal(stat.isGrowthBookFreshForCurrentAccount(),ns.fresh);
  assert.equal(stat.isGrowthBookFreshWithin(50),ns.within);
  const cache=await encodeFeatureCache({timestamp:1000,mode:'1p',features:{}});
  const disk=provider({mode:'1p',source:{kind:'remote',fetch:async()=>{throw Error('offline')}}},{cache:{read:async()=>cache}});
  await disk.init();
  const nd=nativeState('disk',false,undefined);
  assert.equal(disk.areFeaturesLoaded(),nd.loaded);
  assert.equal(disk.isGrowthBookFreshForCurrentAccount(),nd.fresh);
  assert.equal(disk.isGrowthBookFreshWithin(50),nd.within);
  await disk.waitForGrowthBookReady();
  stat.dispose(); disk.dispose();
});
test('original czt spread and provider initial background timer agree on fixed randomness', async()=> {
  const src=original('var ozt={', 'var wv=');
  const delays=[];
  runInNewContext(`${src}; czt(()=>{},3600000,{earlyMs:600000,lateDelayMs:20000});`,{
    Math:{random:()=>0.5,min:Math.min}, Date:{now:()=>1000},
    setTimeout:(_fn,delay)=>{delays.push(delay);return 1}, clearTimeout(){}, N:{info(){}}
  });
  const ours=[];
  const p=provider({mode:'3p',source:{kind:'static',features:{}}},{random:()=>0.5,setTimer:(_fn,delay)=>{ours.push(delay);return {unref(){}}}});
  await p.init();
  assert.equal(ours[0],delays[0]);
  p.dispose();
});

test('native extracted Zzt and provider agree on changed and removed gate channels', async()=> {
  const { EventEmitter } = require('node:events');
  const body=original('function Yzt(', 'var Xzt=') + original('function Zzt(', 'function $zt(');
  const jv=new EventEmitter(), Ozt=new EventEmitter(), trace=[];
  jv.on('a', value=>trace.push(['change',value?.value]));
  Ozt.on('a', value=>trace.push(['gate',value?.value]));
  const nativeApply=runInNewContext(`let Pv='none', Nv={}; const kzt='fresh', Mv='network'; ${body}; Zzt`, {
    jv,Ozt,Kzt:x=>x,N:{info(){},isDebugEnabled:()=>false},G:()=>({mainGrowthBookFeaturesApplied(){}})
  });
  nativeApply({a:{on:true,value:1}},'network');
  nativeApply({},'network');
  let reads=0;
  const p=provider({mode:'1p',source:{kind:'remote',fetch:async()=>({ok:true,json:async()=>({features:++reads===1?{a:{on:true,value:1}}:{}})})}});
  const actual=[];
  p.onFeatureChange('a',x=>actual.push(['change',x?.value]));
  p.observeFeatureGate('a',x=>actual.push(['gate',x?.value]));
  await p.init(); await p.refresh({force:true});
  assert.deepEqual(actual,trace);
  p.dispose();
});
