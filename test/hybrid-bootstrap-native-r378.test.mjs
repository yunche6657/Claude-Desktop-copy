import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {createHybridBootstrapFetch}=require('../desktop/hybrid-bootstrap-fetch.cjs');
const upstream=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');const etn=upstream.slice(upstream.indexOf('async function Etn('),upstream.indexOf('function Dtn('));
assert.match(etn,/\(await t\.text\(\)\)\.trim\(\)/);assert.match(etn,/kind:"unreachable"/);assert.match(etn,/JSON\.parse\(y\)/);
const make=fetch=>createHybridBootstrapFetch({resolveAuth:async()=>({ok:true,headers:{}}),fetch,validate:({json})=>({ok:true,value:json})});
test('native Etn distinguishes response body transport failure from malformed JSON',async()=>{
 const url='https://controlled.invalid/bootstrap';const badRead=make(async()=>({ok:true,status:200,text:async()=>{throw Error('stream disconnected')},headers:new Headers()}));
 assert.deepEqual(await badRead.run(url),{ok:false,kind:'unreachable'});
 const invalid=make(async()=>({ok:true,status:200,text:async()=>'{broken',headers:new Headers()}));assert.deepEqual(await invalid.run(url),{ok:false,kind:'parse',status:200,detail:'response is not a JSON object'});
 const valid=make(async()=>({ok:true,status:200,text:async()=> ' \n {"key":1} \n',headers:new Headers()}));assert.deepEqual(await valid.run(url),{ok:true,value:{key:1}});
});
