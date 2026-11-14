import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {createHybridBootstrapCache}=createRequire(import.meta.url)('../desktop/hybrid-bootstrap-cache.cjs');
const ref=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js');
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve}};
function harness(fetcher) {
 const text=fs.readFileSync(ref,'utf8'),a=text.indexOf('function gtn(){Mw=null}'),b=text.indexOf('function btn(e)',a);assert.ok(a>=0&&b>a);
 const src=text.slice(a,b).replace('var Nw,_tn=Wu(),Pw=Wu(),Fw=new Map,Iw={},Lw=new qu;','var Nw;');
 let config={bootstrap:{url:'https://one.invalid/bootstrap',enabled:true,oidc:{id:'fixture'}}},time=1000000,gen=0;
 const log=[];const Etn=(...args)=>{log.push(args);return fetcher(...args)};
 const ctx={Mw:null,K:()=>config,Date:{now:()=>time},dtn:3600000,Lw:{capture:()=>{const at=gen;return()=>at!==gen}},mtn:url=>url.includes('one.invalid'),Etn,enn:e=>e<1e12?e*1000:e};
 const native=vm.runInNewContext(src+';({resolve:ytn,clear:gtn,set:vtn,get:Rw})',ctx);
 const model=createHybridBootstrapCache({getConfig:()=>config,now:()=>time,captureCredentialGeneration:()=>{const at=gen;return()=>at!==gen},trustedDelivery:url=>url.includes('one.invalid'),fetchBootstrap:Etn});
 return {native,model,log,setConfig:v=>config=v,setTime:v=>time=v,invalidate:()=>gen++};
}
const plain=v=>JSON.parse(JSON.stringify(v??null));

test('native and cache agree for expiry, preferCache, bypass, source and last-served conditional',async()=>{
 let num=0;const h=harness(async(url,_oidc,_t,previous)=>({ok:true,sourceUrl:url,value:{n:++num,expiresAt:1001},previous}));
 // Independent native/model transport calls return matched values by resetting counter.
 const pair=async opts=>{num=0;const x=await h.native.resolve(opts);num=0;const y=await h.model.resolve(opts);assert.deepEqual(plain(y),plain(x));return y};
 const served={sourceUrl:'https://one.invalid/bootstrap',etag:'fixture'};h.native.set(served);h.model.setLastServed(served);
 await pair();assert.equal(h.log[0][3].etag,'fixture');assert.equal(h.log[1][3].etag,'fixture');
 let before=h.log.length;await pair();assert.equal(h.log.length,before);
 h.setTime(1001000);before=h.log.length;await pair({preferCache:true});assert.equal(h.log.length,before);
 await pair({bypassCache:true,background:true});assert.equal(h.log.at(-1)[5],true);
 h.native.clear();h.model.clearFetchCache();assert.deepEqual(plain(h.native.get()),plain(h.model.getLastServed()));
 h.setConfig({bootstrap:{url:'https://two.invalid/bootstrap',enabled:true}});await pair();assert.equal(h.log.at(-1)[3],undefined);
 h.setConfig({bootstrap:{url:'',enabled:true}});assert.deepEqual(plain(await h.model.resolve()),plain(await h.native.resolve()));
});

test('native and cache do not store successful stale credential-generation response',async()=>{
 const pending=[];const h=harness(()=>{const d=defer();pending.push(d);return d.promise});
 const a=h.native.resolve(),b=h.model.resolve();assert.equal(pending.length,2);h.invalidate();
 const value={ok:true,sourceUrl:'https://one.invalid/bootstrap',value:{}};pending[0].resolve(value);pending[1].resolve(value);await Promise.all([a,b]);
 const c=h.native.resolve(),d=h.model.resolve();assert.equal(pending.length,4);pending[2].resolve(value);pending[3].resolve(value);await Promise.all([c,d]);
});

test('native default one hour and seconds/milliseconds expiry conversion match at boundary',async()=>{
 for(const expiresAt of [undefined,1002,1000000000001]){
  let count=0;const h=harness(async url=>({ok:true,sourceUrl:url,value:{expiresAt},id:++count}));
  await h.native.resolve();count=0;await h.model.resolve();h.setTime(expiresAt===undefined?4600000:expiresAt===1002?1002000:1000000000001);
  const before=h.log.length;const p=h.native.resolve(),q=h.model.resolve();await Promise.all([p,q]);assert.equal(h.log.length-before,2);
 }
});
