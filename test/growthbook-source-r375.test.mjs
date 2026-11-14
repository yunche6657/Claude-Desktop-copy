import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {createGrowthBookProvider}=require('../desktop/growthbook-provider.cjs');
const f=value=>({on:!!value,value,source:'defaultValue'});
const reply=features=>({ok:true,json:async()=>({features})});
function make(ctx){let clock=100;const provider=createGrowthBookProvider({getContext:()=>ctx,now:()=>clock,monotonicNow:()=>clock,random:()=>0,setTimer:()=>1,clearTimer:()=>{}});return {provider,setClock:v=>clock=v};}
const upstream=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const kzt=upstream.match(/function Kzt\(e\)\{.*?\}var qzt=null;/s)?.[0].replace(/var qzt=null;$/,'');
const nbt=upstream.match(/function nBt\(\)\{.*?\}async function rBt/s)?.[0].replace(/async function rBt$/,'');
assert.ok(kzt&&nbt);
function reference(initial,fixed,allowed,kind='network'){
 const sandbox={Nv:initial,Pv:kind, G:()=>({hardcodedMainGrowthBookFeatures:()=>fixed,growthBookRemoteAllowedKeys:()=>allowed})};
 vm.createContext(sandbox);vm.runInContext(`${kzt}; function Zzt(e,t){Nv=Kzt(e);Pv=t}; ${nbt}; nBt()`,sandbox);
 return JSON.parse(JSON.stringify({map:sandbox.Nv,state:sandbox.Pv}));
}

test('managed rebuild projects current map like original nBt and never resurrects filtered keys',async()=>{
 const original={a:f(1),b:f(2),c:f(3)};const ctx={mode:'one',source:{kind:'remote',fetch:async()=>reply(original)}};const x=make(ctx),p=x.provider;await p.init();const stamp=p.getLastGrowthBookNetworkFetchAtMs();let freshEvents=0,networkEvents=0;
 p.onGrowthBookFreshChange(()=>freshEvents++);p.onGrowthBookNetworkFetch(()=>networkEvents++);const gates=[];p.observeFeatureGate('a',v=>gates.push(v?.value));p.observeFeatureGate('c',v=>gates.push(v?.value));
 const fixed={a:f(7)}, allowed=['b'];ctx.mode='3p';ctx.source={kind:'static',features:fixed,remoteAllowedKeys:allowed};x.setClock(1000);assert.equal(p.reproject(),true);
 const expected=reference(original,fixed,allowed);for(const key of ['a','b','c'])assert.deepEqual(p.getFeatureValue(key,null),expected.map[key]?.value??null);
 assert.deepEqual(gates,[7,undefined]);assert.equal(p.getLastGrowthBookNetworkFetchAtMs(),stamp);assert.equal(p.isGrowthBookFreshForCurrentAccount(),true);assert.equal(freshEvents,0);assert.equal(networkEvents,0);
 const current=expected.map;ctx.source.remoteAllowedKeys=['c'];ctx.source.features={a:f(8)};assert.equal(p.sourceChanged(),true);const again=reference(current,ctx.source.features,['c']);assert.equal(p.getFeatureValue('c',null),again.map.c?.value??null);assert.equal(p.getFeatureValue('b',null),null);assert.equal(p.getFeatureValue('a',null),8);p.dispose();
});

test('no loaded state or absent hardcoded policy means no managed reproject',async()=>{
 const ctx={mode:'x',source:{kind:'static',features:{a:f(1)}}};const {provider:p}=make(ctx);assert.equal(p.reproject(),false);await p.init();ctx.source={kind:'remote',fetch:async()=>reply({b:f(2)})};assert.equal(p.reproject(),false);assert.equal(p.getFeatureValue('a',0),1);assert.equal(p.getFeatureValue('b',0),0);await p.refresh({force:true});assert.equal(p.getFeatureValue('b',0),2);p.dispose();
});

test('in-flight old source result cannot overwrite rebuilt source',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const ctx={mode:'x',source:{kind:'remote',fetch:()=>pending}};const {provider:p}=make(ctx);const first=p.init();ctx.mode='3p';ctx.source={kind:'static',features:{a:f(7)}};assert.equal(p.reproject(),false);resolve(reply({a:f(2)}));await first;assert.equal(p.getFeatureValue('a',0),0);await p.accountChanged();assert.equal(p.getFeatureValue('a',0),7);p.dispose();
});

test('same kind config rebuild preserves prior stale status and network timestamp',async()=>{
 const ctx={mode:'x',accountKey:'a',source:{kind:'remote',fetch:async()=>reply({v:f(1)}),hardcodedFeatures:{v:f(3)}}};const {provider:p}=make(ctx);await p.init();const t=p.getLastGrowthBookNetworkFetchAtMs();ctx.source.hardcodedFeatures={v:f(4)};assert.equal(p.reproject(),true);assert.equal(p.getFeatureValue('v',0),4);assert.equal(p.getLastGrowthBookNetworkFetchAtMs(),t);assert.equal(p.isGrowthBookFreshForCurrentAccount(),true);
 ctx.accountKey=null;await p.accountChanged();assert.equal(p.isGrowthBookFreshForCurrentAccount(),false);ctx.source.hardcodedFeatures={v:f(5)};p.reproject();assert.equal(p.getFeatureValue('v',0),5);assert.equal(p.isGrowthBookFreshForCurrentAccount(),false);assert.equal(p.getLastGrowthBookNetworkFetchAtMs(),undefined);p.dispose();
});
