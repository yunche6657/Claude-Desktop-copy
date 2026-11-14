import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createHybridBootstrapCandidate}=require('../desktop/hybrid-bootstrap-candidate.cjs');
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r}),resolve}};

test('pending consent cannot apply/cache and approval re-resolves fresh candidate',async()=>{
 let consent='pending', approve, count=0;const events=[];const done=deferred();
 const lifecycle=createHybridBootstrapCandidate({
  fetchCandidate:async opts=>{events.push(['fetch',opts]);return {ok:true,value:++count}},
  validateCandidate:async c=>{events.push(['validate',c.value]);return true},
  checkConsent:async c=>{events.push(['consent',c]);return consent==='pending'?{status:'pending',prompt:fn=>{approve=fn}}:{status:'consented'}},
  applyCandidate:async c=>events.push(['apply',c.value]),validateApplied:async c=>{events.push(['validateApplied',c.value]);return true},
  cacheCandidate:async c=>{events.push(['cache',c.value]);done.resolve()},
 });
 assert.deepEqual(await lifecycle.resolve({gesture:true}),{kind:'pending'});
 assert.deepEqual(events.map(x=>x[0]),['fetch','validate','consent']);
 consent='accepted';approve();await done.promise;
 assert.deepEqual(events.slice(3),[['fetch',{preferCache:true}],['validate',2],['consent',2],['apply',2],['validateApplied',2],['cache',2]]);
});

test('stale validation is suppressed; consent callback still re-resolves after invalidation',async()=>{
 const gate=deferred();let approval, applied=0,cached=0,calls=0;
 const lifecycle=createHybridBootstrapCandidate({fetchCandidate:async()=>({ok:true,value:++calls}),
  validateCandidate:async c=>{if(c.value===1)await gate.promise;return true},
  checkConsent:async()=>({status:'pending',prompt:fn=>{approval=fn}}),applyCandidate:async()=>applied++,validateApplied:async()=>true,cacheCandidate:async()=>cached++});
 const first=lifecycle.resolve();assert.deepEqual(await lifecycle.resolve(),{kind:'pending'});gate.resolve();assert.deepEqual(await first,{kind:'stale'});
 lifecycle.invalidate();approval();await new Promise(r=>setImmediate(r));assert.equal(calls,3);assert.equal(applied,0);assert.equal(cached,0);
});

test('commit callback honors generation after asynchronous apply and failed post-validation does not cache',async()=>{
 const gate=deferred(),started=deferred();let state,cache=0,valid=true;
 const lifecycle=createHybridBootstrapCandidate({fetchCandidate:async()=>({ok:true,value:'candidate'}),validateCandidate:async()=>true,
  checkConsent:async()=>({status:'consented'}),applyCandidate:async(c,{isCurrent})=>{started.resolve();await gate.promise;if(isCurrent())state=c.value},
  validateApplied:async()=>valid,cacheCandidate:async(_c,{isCurrent})=>{if(isCurrent())cache++}});
 const pending=lifecycle.resolve();await started.promise;lifecycle.invalidate();gate.resolve();assert.deepEqual(await pending,{kind:'stale'});assert.equal(state,undefined);assert.equal(cache,0);
 valid=false;assert.deepEqual(await lifecycle.resolve(),{kind:'applied-invalid'});assert.equal(cache,0);
});

test('thrown applied validation keeps already applied state and prevents cache',async()=>{
 const events=[], failure=new Error('invalid applied config');
 const c=createHybridBootstrapCandidate({fetchCandidate:async()=>({ok:true}),validateCandidate:async()=>true,checkConsent:async()=>({status:'consented'}),
 applyCandidate:async()=>events.push('applied'),validateApplied:async()=>{throw failure},cacheCandidate:async()=>events.push('cached')});
 const result=await c.resolve();assert.equal(result.kind,'applied-invalid');assert.equal(result.error,failure);assert.deepEqual(events,['applied']);
});

test('failed fetch, rejected candidate and refused consent never apply or cache',async()=>{
 let phase='fetch',writes=0;
 const c=createHybridBootstrapCandidate({fetchCandidate:async()=>phase==='fetch'?{ok:false,kind:'auth'}:{ok:true},validateCandidate:async()=>phase!=='invalid',
 checkConsent:async()=>({status:'refused'}),applyCandidate:async()=>writes++,validateApplied:async()=>true,cacheCandidate:async()=>writes++});
 assert.equal((await c.resolve()).kind,'fetch-error');phase='invalid';assert.equal((await c.resolve()).kind,'invalid');phase='refused';assert.equal((await c.resolve()).kind,'refused');assert.equal(writes,0);
});

test('consent callbacks trigger re-resolution as native callback does',async()=>{
 let callback,fetches=0;const finished=deferred();
 const c=createHybridBootstrapCandidate({fetchCandidate:async()=>({ok:true,value:++fetches}),validateCandidate:async()=>true,
 checkConsent:async c=>c===1?{status:'pending',prompt:fn=>callback=fn}:{status:'consented'},
 applyCandidate:async()=>{},validateApplied:async()=>true,cacheCandidate:async()=>finished.resolve()});
 await c.resolve();callback();callback();await finished.promise;assert.equal(fetches,3);
});
