import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {createHybridMemberships}=require('../desktop/hybrid-memberships.cjs');
const file=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js');
function harness(fetcher) {
 const s=fs.readFileSync(file,'utf8'), a=s.indexOf('var RC,O5t,k5t,zC,BC,VC=0;'), b=s.indexOf('var GC="hybridIdentity"',a);
 assert.ok(a>=0&&b>a);
 const code=s.slice(a,b).replace('let{gatewayFetch3p:s}=await Promise.resolve().then((()=>Qb)),c=', 'let s=fetcher,c=')
 .replace('let{noteHybridBearerOwner:e,recordHybridIdentity:t}=await Promise.resolve().then((()=>KC));','let {noteHybridBearerOwner:e,recordHybridIdentity:t}=identity;');
 const events=[], owners=[], identity={noteHybridBearerOwner:(...args)=>owners.push(['owner',...args]),recordHybridIdentity:async(...args)=>owners.push(['record',args[0],args[1]])};
 const c={fetcher,identity,f:crypto,AbortSignal,E5t:10000,Al:(o,t)=>({Authorization:`Bearer ${t}`,...o.xAuthorization?{'X-Authorization':`Bearer ${t}`}:{}}),
 Gn:v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
 Ql:v=>typeof v==='string'&&v.length>0?v.slice(0,255):undefined,N:{info(){}},Xx:{},Hi:()=>'',P:()=>''};
 const native=vm.runInNewContext(code+';({prime:L5t,clear:H5t,invalidate:V5t,members:R5t,account:z5t,on:B5t})',c);
 const model=createHybridMemberships({fetch:fetcher,noteOwner:(...args)=>owners.push(['owner',...args]),recordIdentity:async(...args)=>owners.push(['record',args[0],args[1]])});
 native.on(()=>events.push('native'));model.onChange(()=>events.push('model'));
 return {native,model,events,owners};
}
const normalize=v=>JSON.parse(JSON.stringify(v??null));
const org='abcdefab-1234-1234-1234-abcdefabcdef';

test('native membership cache, account normalization, 401, clear, and failures match',async()=>{
 let response, calls=0;
 const fetcher=async()=>{calls++;if(response instanceof Error)throw response;return response;};
 const {native,model,events}=harness(fetcher);
 const sync=()=>{assert.deepEqual(normalize(model.getMemberships()),normalize(native.members()));assert.deepEqual(normalize(model.getAccount()),normalize(native.account()));};
 response={ok:true,json:async()=>({email_address:'x\u202ey@example.invalid',full_name:'Name',memberships:[{organization:{uuid:org.toUpperCase(),name:' A\u202eB ',capabilities:['chat','taint:hybrid_3p',3],settings:{desktop_deployment_required:true}}},{organization:{uuid:'invalid'}}]})};
 await native.prime('https://fixture.invalid','first');await model.prime('https://fixture.invalid','first');sync();
 assert.equal(model.getMemberships()[0].name,' AB ');assert.equal(model.getAccount().email,'xy@example.invalid');
 await native.prime('https://fixture.invalid','first');await model.prime('https://fixture.invalid','first');assert.equal(calls,2);
 native.invalidate();model.invalidate();sync();
 response=new Error('offline');await native.prime('https://fixture.invalid','second');await model.prime('https://fixture.invalid','second');sync();
 response={ok:false,status:403};await native.prime('https://fixture.invalid','third');await model.prime('https://fixture.invalid','third');sync();
 native.clear();model.clear();sync();
 assert.equal(events.filter(x=>x==='native').length,events.filter(x=>x==='model').length);
});

test('native concurrent same-bearer calls coalesce; newer generation defeats delayed old response',async()=>{
 const waits=[];const fetcher=()=>new Promise(resolve=>waits.push(resolve));const {native,model}=harness(fetcher);
 const n1=native.prime('https://fixture.invalid','old'),n2=native.prime('https://fixture.invalid','old');
 const m1=model.prime('https://fixture.invalid','old'),m2=model.prime('https://fixture.invalid','old');
 assert.equal(n1,n2);assert.equal(m1,m2);assert.equal(waits.length,2);
 const n3=native.prime('https://fixture.invalid','new'),m3=model.prime('https://fixture.invalid','new');assert.equal(waits.length,4);
 const ok=name=>({ok:true,json:async()=>({memberships:[{organization:{uuid:org,name,capabilities:[]}}]})});
 waits[2](ok('new'));waits[3](ok('new'));await Promise.all([n3,m3]);
 waits[0](ok('old'));waits[1](ok('old'));await Promise.all([n1,m1]);
 assert.deepEqual(normalize(model.getMemberships()),normalize(native.members()));assert.equal(model.getMemberships()[0].name,'new');
});

test('native owner hooks get matching raw account and bootstrap inputs after fetch',async()=>{
 const body={uuid:org.toUpperCase(),tagged_id:'fixture-tag',memberships:[]};const {native,model,owners}=harness(async()=>({ok:true,json:async()=>body}));
 await native.prime('https://fixture.invalid','bearer',true,{bootstrapUrl:'https://bootstrap.invalid'});
 await model.prime('https://fixture.invalid','bearer',true,{bootstrapUrl:'https://bootstrap.invalid'});
 assert.deepEqual(normalize(owners.slice(0,2)),normalize(owners.slice(2,4)));
});

test('native and implementation suppress identity callbacks when invalidated during async dependency load', async () => {
 const s=fs.readFileSync(file,'utf8'),a=s.indexOf('var RC,O5t,k5t,zC,BC,VC=0;'),b=s.indexOf('var GC="hybridIdentity"',a);
 const code=s.slice(a,b).replace('let{gatewayFetch3p:s}=await Promise.resolve().then((()=>Qb)),c=', 'let s=fetcher,c=')
  .replace('await Promise.resolve().then((()=>KC))','await loadKC()');
 const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r}),resolve}};
 const nativeGate=deferred(), modelGate=deferred(), nativeStarted=deferred(), modelStarted=deferred();
 const nativeCalls=[],modelCalls=[];
 const identity={noteHybridBearerOwner:(...x)=>nativeCalls.push(x),recordHybridIdentity:async(...x)=>nativeCalls.push(x)};
 const fetcher=async()=>({ok:true,json:async()=>({uuid:org,memberships:[]})});
 const context={fetcher,loadKC:()=>{nativeStarted.resolve();return nativeGate.promise},f:crypto,AbortSignal,E5t:10000,Al:(o,t)=>({Authorization:`Bearer ${t}`}),
 Gn:v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
 Ql:v=>typeof v==='string'&&v.length>0?v.slice(0,255):undefined,N:{info(){}},Xx:{},Hi:()=>'',P:()=>''};
 const native=vm.runInNewContext(code+';({prime:L5t,invalidate:V5t,members:R5t,account:z5t})',context);
 const model=createHybridMemberships({fetch:fetcher,loadIdentity:()=>{modelStarted.resolve();return modelGate.promise}});
 const owner={bootstrapUrl:'https://bootstrap.invalid'};
 const n=native.prime('https://fixture.invalid','token',false,owner),m=model.prime('https://fixture.invalid','token',false,owner);
 await Promise.all([nativeStarted.promise,modelStarted.promise]);
 assert.deepEqual(normalize(model.getMemberships()),normalize(native.members()));
 native.invalidate();model.invalidate();
 nativeGate.resolve(identity);modelGate.resolve({noteOwner:(...x)=>modelCalls.push(x),recordIdentity:async(...x)=>modelCalls.push(x)});
 await Promise.all([n,m]);
 assert.deepEqual(nativeCalls,[]);assert.deepEqual(modelCalls,[]);
 assert.deepEqual(normalize(model.getMemberships()),normalize(native.members()));
 assert.deepEqual(normalize(model.getAccount()),normalize(native.account()));
});
