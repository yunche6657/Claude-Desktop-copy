import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {createHybridBootstrapCandidate}=require('../desktop/hybrid-bootstrap-candidate.cjs');
const reference=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js');
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve}};
function original({fetch,consent,loadConsent}) {
 const text=fs.readFileSync(reference,'utf8'),a=text.indexOf('async resolveBootstrapOverlay(e){'),b=text.indexOf('scheduleBootstrapRepolls(){',a);assert.ok(a>=0&&b>a);
 const source=text.slice(a,b).replace('async resolveBootstrapOverlay(e){','async function native(e){')
  .replace('await Promise.resolve().then((()=>require("./index.chunk-xoZNrP6a.js")))','await loadConsent()');
 const events=[];
 const N={info(){},warn(){},error(){}};
 const stub={ytn:fetch,loadConsent:loadConsent ?? (async()=>({checkBootstrapConsent:consent})),gtn:()=>events.push('clearFetchCache'),Nvn:()=>({}),zw:v=>v,iGe:v=>events.push(['apply',v]),
  VHe(){},svn(){},ipn:()=>null,K:()=>({}),vtn:v=>events.push(['served',v.value]),es:JSON.stringify,
  Xx:{},N,P:()=>'',Yl:()=>false,jo:()=>false,wvn:()=>'',npn:()=>({ok:true}),kl:()=>false,Uu(){},Date,Set,Promise};
 const fn=vm.runInNewContext(source+';native',stub);
 const self={_overlayGen:0,_overlayAppliedGen:0,_bootstrapState:{},_overlayAppliedGen:0,creds:null,
  handOverServedUsageMetricsOptIn(){},persistAppliedBody:v=>events.push(['persist',v.value]),clearPendingServed(){},notifyOrgUuidOverrideChanged(){},
  syncRelaunch(){events.push('sync')},notifyBootstrapListeners(){events.push('notify')},settleAfterOverlayResolve(){events.push('settle')},
  resolveBootstrapOverlay(options){return fn.call(self,options)},_invalidateCcdBaseConfigCache(){},markServedRecordDeclared(){},cutDiskCopyIfForbidden(){},setConfigError(){}};
 return {self,events,run:options=>fn.call(self,options)};
}
const ok=value=>({ok:true,value,sourceUrl:'https://fixture.invalid',keyedParseErrors:[],trustedDelivery:false});

test('native permits older success to apply while newer request is still in flight',async()=>{
 const first=deferred(),second=deferred();let i=0;const {self,events,run}=original({fetch:()=>++i===1?first.promise:second.promise,consent:()=>({status:'consented'})});
 const a=run(),b=run();first.resolve(ok('old'));await a;assert.equal(self._overlayAppliedGen,1);assert.ok(events.some(x=>Array.isArray(x)&&x[0]==='apply'&&x[1]==='old'));
 second.resolve(ok('new'));await b;assert.equal(self._overlayAppliedGen,2);assert.deepEqual(events.filter(x=>Array.isArray(x)&&x[0]==='apply').map(x=>x[1]),['old','new']);
});

test('native discards late older success after newer accepted and clears fetch cache',async()=>{
 const first=deferred(),second=deferred();let i=0;const {self,events,run}=original({fetch:()=>++i===1?first.promise:second.promise,consent:()=>({status:'consented'})});
 const a=run(),b=run();second.resolve(ok('new'));await b;first.resolve(ok('old'));await a;
 assert.equal(self._overlayAppliedGen,2);assert.deepEqual(events.filter(x=>Array.isArray(x)&&x[0]==='apply').map(x=>x[1]),['new']);assert.ok(events.includes('clearFetchCache'));
});

test('native pending advances applied generation and callback reruns with preferCache',async()=>{
 let callback, calls=[];const {self,events,run}=original({fetch:async o=>{calls.push(o);return ok(calls.length)},consent:v=>v===1?{status:'pending',prompt:fn=>callback=fn}:{status:'consented'}});
 await run({gesture:true});assert.equal(self._overlayAppliedGen,1);assert.equal(self._servedChangeUnsettled,true);assert.equal(events.some(x=>Array.isArray(x)&&x[0]==='apply'),false);
 callback();await new Promise(r=>setImmediate(r));assert.equal(calls.length,2);assert.equal(calls[1].preferCache,true);assert.equal(self._overlayAppliedGen,2);
 assert.ok(events.some(x=>Array.isArray(x)&&x[0]==='apply'&&x[1]===2));assert.ok(events.includes('settle'));
});

test('candidate accepts older success before newer settles, matching native',async()=>{
 const first=deferred(),second=deferred();let n=0;const applied=[];
 const c=createHybridBootstrapCandidate({fetchCandidate:()=>++n===1?first.promise:second.promise,validateCandidate:async()=>true,checkConsent:async()=>({status:'consented'}),applyCandidate:async v=>applied.push(v.value),validateApplied:async()=>true,cacheCandidate:async()=>{}});
 const a=c.resolve(),b=c.resolve();first.resolve(ok('old'));assert.equal((await a).kind,'applied');second.resolve(ok('new'));await b;assert.deepEqual(applied,['old','new']);
});

test('native older suspended consent loader can overwrite newer applied generation',async()=>{
 const oldLoad=deferred(),oldStarted=deferred();let calls=0,loads=0;
 const {self,events,run}=original({fetch:async()=>ok(++calls),consent:()=>({status:'consented'}),loadConsent:()=>{if(++loads===1){oldStarted.resolve();return oldLoad.promise}return Promise.resolve({checkBootstrapConsent:()=>({status:'consented'})})}});
 const a=run();await oldStarted.promise;const b=run();await b;assert.equal(self._overlayAppliedGen,2);
 oldLoad.resolve({checkBootstrapConsent:()=>({status:'consented'})});await a;
 assert.equal(self._overlayAppliedGen,1);assert.deepEqual(events.filter(x=>Array.isArray(x)&&x[0]==='apply').map(x=>x[1]),[2,1]);
});

test('native auth/unconfigured and status parse advance settled generation; transient does not',async()=>{
 for(const [reply,expected] of [[{ok:false,kind:'auth'},1],[{ok:false,kind:'unconfigured'},1],[{ok:false,kind:'parse',status:400,detail:'invalid'},1],[{ok:false,kind:'unreachable'},0]]){
  const {self,run}=original({fetch:async()=>reply,consent:()=>({status:'consented'})});await run();assert.equal(self._overlayAppliedGen,expected,reply.kind);
 }
});

test('candidate discards late older success and calls fetch-cache invalidation',async()=>{
 const first=deferred(),second=deferred();let n=0,cleared=0;const applied=[];
 const c=createHybridBootstrapCandidate({fetchCandidate:()=>++n===1?first.promise:second.promise,validateCandidate:async()=>true,checkConsent:()=>({status:'consented'}),applyCandidate:async x=>applied.push(x.value),validateApplied:async()=>true,cacheCandidate:async()=>{},clearFetchCache:()=>cleared++});
 const a=c.resolve(),b=c.resolve();second.resolve(ok('new'));await b;first.resolve(ok('old'));assert.equal((await a).kind,'stale');assert.equal(cleared,1);assert.deepEqual(applied,['new']);
});

test('candidate follows native delayed consent-loader generation rollback',async()=>{
 const oldLoader=deferred(),started=deferred();let fetches=0,loads=0;const applied=[];
 const c=createHybridBootstrapCandidate({fetchCandidate:async()=>ok(++fetches),validateCandidate:async()=>true,
 loadConsent:()=>{if(++loads===1){started.resolve();return oldLoader.promise}return Promise.resolve(()=>({status:'consented'}))},
 applyCandidate:async v=>applied.push(v.value),validateApplied:async()=>true,cacheCandidate:async()=>{}});
 const a=c.resolve();await started.promise;const b=c.resolve();await b;oldLoader.resolve(()=>({status:'consented'}));await a;
 assert.deepEqual(applied,[2,1]);
});
