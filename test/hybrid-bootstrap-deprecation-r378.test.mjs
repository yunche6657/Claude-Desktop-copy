import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {supportEndTime,crossedSupportEnd,createHybridBootstrapFetch}=require('../desktop/hybrid-bootstrap-fetch.cjs');
test('deprecation deadline and cached etag eligibility match extracted native functions',()=>{
 const src=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
 const a=src.indexOf('function Bs('),b=src.indexOf('function Vs(',a),c=src.indexOf('function Ttn('),d=src.indexOf('async function Etn(',c);
 assert.ok(a>0&&b>a&&c>0&&d>c);
 const native=vm.runInNewContext(`const vke=/^(\\d{4})-(\\d{2})-(\\d{2})$/,bke=new Map;${src.slice(a,b)}${src.slice(c,d)};({Bs,Ttn})`);
 for(const date of ['2026-03-07','2026-03-08','2026-11-01','2026-02-29','bad','2024-02-29']) {
  let expected,actual;try{expected=native.Bs(date)}catch{expected='invalid'}try{actual=supportEndTime(date)}catch{actual='invalid'}assert.equal(actual,expected,date);
 }
 const now=Date.now();
 for(const item of [{kind:'deprecated',deprecation:{supportEnds:'2020-01-01'}},{kind:'deprecated',deprecation:{supportEnds:'bad'}},{kind:'unknown'}]){
  for(const fetchedAt of [0,now]) {const entry={fetchedAt,keyedParseErrors:[item]};assert.equal(crossedSupportEnd(entry,now),native.Ttn(entry));}
 }
});
test('a crossed deadline suppresses conditional requests and rejects an unsolicited 304',async()=>{
 let sent;
 const service=createHybridBootstrapFetch({resolveAuth:async()=>({ok:true}),fetch:async(_url,options)=>{sent=options.headers.get('If-None-Match');return new Response(null,{status:304})},validate:()=>({ok:true}),now:()=>Date.UTC(2026,0,2)});
 const previous={etag:'old',fetchedAt:0,keyedParseErrors:[{kind:'deprecated',deprecation:{supportEnds:'2025-01-01'}}],value:{}};
 const result=await service.run('https://example.test/bootstrap',{previous});
 assert.equal(sent,null);assert.equal(result.ok,false);assert.equal(result.kind,'http');assert.equal(result.status,304);
});
