import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createGrowthBookProvider,encodeFeatureCache}=require('../desktop/growthbook-provider.cjs');
const f=(value,extra={})=>({on:!!value,value,source:'defaultValue',...extra});
const reply=features=>({ok:true,json:async()=>({user:{id:'u'},features})});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(context,extra={}) { let clock=0, nextId=0; const timers=new Map(); const provider=createGrowthBookProvider({getContext:()=>context,now:()=>clock,monotonicNow:()=>clock,random:()=>0.5,setTimer:(fn,ms)=>{const id=++nextId;timers.set(id,{fn,ms,due:clock+ms});return id;},clearTimer:id=>timers.delete(id),...extra}); return {provider,timers,setClock:v=>clock=v,advance:async v=>{clock=v;const [id,t]=[...timers].sort((a,b)=>a[1].due-b[1].due)[0];timers.delete(id);t.fn();await new Promise(r=>setImmediate(r));}}; }

test('static loaded/fresh, two independent event streams and network time',async()=>{
 const ctx={mode:'3p',source:{kind:'static',features:{a:f(1)}}}; const {provider:p}=setup(ctx); const changes=[],gates=[],fresh=[];
 p.onFeatureChange('missing',v=>changes.push(v)); p.observeFeatureGate('a',v=>gates.push(v));p.onGrowthBookFreshChange(()=>fresh.push(1));
 assert.equal(p.areFeaturesLoaded(),false); await p.waitForGrowthBookReady(); assert.equal(p.areFeaturesLoaded(),true);assert.equal(p.isGrowthBookFreshForCurrentAccount(),true);
 assert.equal(p.isGrowthBookFreshWithin(0),true);assert.equal(p.getLastGrowthBookNetworkFetchAtMs(),undefined);assert.deepEqual(changes,[undefined]);assert.equal(gates.length,1);assert.equal(fresh.length,1);
 const immediate=[];p.onFeatureChange('a',v=>immediate.push(v.value));assert.deepEqual(immediate,[1]);
 ctx.source.features={}; await p.accountChanged(); assert.deepEqual(gates,[f(1),undefined]);assert.deepEqual(immediate,[1]);p.dispose();
});

test('disk is ready but not fresh; fresh transition reports deferred exposure once',async()=>{
 let resolve; const pending=new Promise(r=>resolve=r); const exp=[];const cache=await encodeFeatureCache({timestamp:0,mode:'3p',features:{a:f(5)}});
 const ctx={mode:'3p',accountKey:'one',source:{kind:'remote',fetch:async()=>{throw Error('offline')}}};const {provider:p}=setup(ctx,{cache:{read:async()=>cache},onExposure:e=>exp.push(e)});
 await p.init();assert.equal(p.areFeaturesLoaded(),true);assert.equal(p.isGrowthBookFreshForCurrentAccount(),false);assert.equal(p.getFeatureValue('a',0),5);assert.equal(exp.length,0);
 const transitions=[];p.onGrowthBookFreshChange(()=>transitions.push(1));ctx.source.fetch=()=>pending;const fetch=p.refresh({force:true}); resolve(reply({a:f(5)}));await fetch;
 assert.equal(p.isGrowthBookFreshForCurrentAccount(),true);assert.equal(transitions.length,1);assert.equal(exp.length,1);assert.equal(p.getLastGrowthBookNetworkFetchAtMs(),0);p.getFeatureValue('a',0);assert.equal(exp.length,1);p.dispose();
});

test('map fallback is usable for ready but not reported loaded and not exposed',async()=>{
 const exp=[];const ctx={mode:'x',source:{kind:'remote',fetch:async()=>{throw Error()},hardcodedFeatures:{a:f(3)}}};const {provider:p}=setup(ctx,{onExposure:e=>exp.push(e)});
 await p.init();assert.equal(p.areFeaturesLoaded(),false);await p.waitForGrowthBookReady();assert.equal(p.getFeatureValue('a',0),3);assert.deepEqual(exp,[]);p.dispose();
});

test('account change keeps old values stale, waits in-flight and settled awaits new response',async()=>{
 let d=deferred(),calls=0;const ctx={mode:'x',accountKey:'one',source:{kind:'remote',fetch:()=>{calls++;return d.promise;}}}; const {provider:p}=setup(ctx);
 let initial=p.init();d.resolve(reply({a:f('old')}));await initial; const seen=[];p.onGrowthBookNetworkFetch(()=>seen.push('network'));p.onGrowthBookFreshChange(()=>seen.push('fresh'));
 d=deferred();const prior=p.refresh({force:true});ctx.accountKey='two';const change=p.accountChanged();assert.equal(p.getFeatureValue('a',''), 'old');assert.equal(p.isGrowthBookFreshForCurrentAccount(),false);assert.equal(p.getLastGrowthBookNetworkFetchAtMs(),undefined);
 let settled=false;const wait=p.waitForGrowthBookSettled().then(()=>{settled=true;});const old=d;d=deferred();old.resolve(reply({a:f('stale')}));await prior;await new Promise(r=>setImmediate(r));assert.equal(calls,3);assert.equal(settled,false);assert.equal(p.getFeatureValue('a',''),'old');
 d.resolve(reply({a:f('new')}));await change;await wait;assert.equal(p.getFeatureValue('a',''),'new');assert.deepEqual(seen,['fresh','network']);p.dispose();
});

test('timer spreads early, defers a late wake, and network error retries after five minutes',async()=>{
 const ctx={mode:'x',source:{kind:'remote',fetch:async()=>{throw Error()}}};const x=setup(ctx);const p=x.provider;await p.init();let t=[...x.timers.values()][0];assert.equal(t.ms,3300000);
 await x.advance(t.due+6000);t=[...x.timers.values()][0];assert.equal(t.ms,10000);await x.advance(t.due);t=[...x.timers.values()][0];assert.equal(t.ms,300000);p.dispose();assert.equal(x.timers.size,0);
});

test('experiment exposure deduplicates and retries rejected queue',async()=>{
 let calls=0;const ctx={mode:'x',source:{kind:'static',features:{a:f(1,{experiment:{key:'exp'},experimentResult:{inExperiment:true,variationId:1}})}}};const {provider:p}=setup(ctx,{queueExperimentExposure:async()=>{calls++;if(calls===1)throw Error('retry');}});
 await p.init();p.getFeatureValue('a',0);await new Promise(r=>setImmediate(r));p.getFeatureValue('a',0);await new Promise(r=>setImmediate(r));p.getFeatureValue('a',0);await new Promise(r=>setImmediate(r));assert.equal(calls,2);p.dispose();
});

test('spread feature bounds and no late jitter for network errors',async()=>{
 const ctx={mode:'x',source:{kind:'remote',fetch:async()=>reply({'1087396298':f({earlyMaxMinutes:20,lateDelayMaxSeconds:30})})}};
 const x=setup(ctx),p=x.provider;await p.init();assert.deepEqual(p.backgroundRefreshSpread(),{earlyMs:1200000,lateDelayMs:30000});
 ctx.source.fetch=async()=>{throw Error('offline')};let t=[...x.timers.values()][0];await x.advance(t.due);t=[...x.timers.values()][0];assert.equal(t.ms,300000);await x.advance(t.due+6000);t=[...x.timers.values()][0];assert.equal(t.ms,300000);p.dispose();
});

test('gate observation never records exposure and source-only edits do not emit',async()=>{
 const ctx={mode:'x',source:{kind:'remote',fetch:async()=>reply({a:f(1)})}};const exp=[];const {provider:p}=setup(ctx,{onExposure:e=>exp.push(e)});let gate=0;p.observeFeatureGate('a',()=>gate++);await p.init();assert.equal(gate,1);assert.equal(exp.length,0);
 ctx.source.fetch=async()=>reply({a:f(1,{source:'force'})});await p.refresh({force:true});assert.equal(gate,1);assert.equal(exp.length,0);p.dispose();
});

test('explicit logout invalidates in-flight result, retains old value without refetch',async()=>{
 let calls=0,d=deferred();const ctx={mode:'x',accountKey:'one',source:{kind:'remote',fetch:()=>{calls++;return d.promise}}};const {provider:p}=setup(ctx);
 const first=p.init();d.resolve(reply({a:f('old')}));await first;d=deferred();const inFlight=p.refresh({force:true});ctx.accountKey=null;await p.accountChanged();assert.equal(calls,2);assert.equal(p.isGrowthBookFreshForCurrentAccount(),false);await p.waitForGrowthBookSettled();d.resolve(reply({a:f('wrong')}));await inFlight;assert.equal(p.getFeatureValue('a',''),'old');assert.equal(calls,2);p.dispose();
});
