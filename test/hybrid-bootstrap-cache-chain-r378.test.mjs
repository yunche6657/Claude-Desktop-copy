import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createHybridBootstrapCache}=require('../desktop/hybrid-bootstrap-cache.cjs'),{createHybridBootstrapCandidate}=require('../desktop/hybrid-bootstrap-candidate.cjs');
test('pending consent retains fetch cache but does not publish last-served until approved',async()=>{
 let calls=0,approval,allowed=false,release;const done=new Promise(r=>release=r),events=[];
 const cache=createHybridBootstrapCache({getConfig:()=>({bootstrap:{url:'https://fixture.invalid/bootstrap',enabled:true}}),fetchBootstrap:async url=>{calls++;return {ok:true,value:{setting:'original'},sourceUrl:url,fetchedAt:10}},captureCredentialGeneration:()=>()=>false,trustedDelivery:()=>false,now:()=>100});
 const candidate=createHybridBootstrapCandidate({fetchCandidate:opts=>cache.resolve(opts),validateCandidate:()=>true,checkConsent:()=>allowed?{status:'consented'}:{status:'pending',prompt:cb=>approval=cb},applyCandidate:async c=>events.push(c.value.setting),validateApplied:()=>true,cacheCandidate:async c=>{cache.setLastServed(c);release()}});
 assert.equal((await candidate.resolve()).kind,'pending');assert.equal(calls,1);assert.equal(cache.getLastServed(),undefined);assert.deepEqual(events,[]);allowed=true;approval();await done;assert.equal(calls,1);assert.equal(cache.getLastServed().value.setting,'original');assert.deepEqual(events,['original']);
});
