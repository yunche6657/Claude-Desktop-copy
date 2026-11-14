import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createHybridIdentityState}=require('../desktop/hybrid-identity-state.cjs');
test('grant and bearer owner transitions match the extracted native KC functions',()=>{
 const src=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
 const start=src.indexOf('function Y5t('), end=src.indexOf('async function o7t(',start);
 assert.ok(start>0&&end>start);
 const native=vm.runInNewContext(`let qC='not-hybrid',JC={storeKey:'slot',account:{accountUuid:'abc'}},YC='',XC=false,ZC='unverified',QC,$C=new Set;const Wze=x=>x;const N={warn(){}};${src.slice(start,end)};({incoming:t7t,bearer:n7t,current:rw,heard:iw,matches:r7t,verified:i7t})`);
 const ours=createHybridIdentityState({launchSlot:'slot',launchAccount:{accountUuid:'abc'}});
 for(const [kind,id,slot] of [['incoming','ABC','slot'],['bearer','abc','slot'],['bearer','other','slot'],['bearer','abc','other'],['incoming',undefined,'slot']]){
  native[kind](id,slot);ours[kind==='incoming'?'noteIncomingHybridGrant':'noteHybridBearerOwner'](id,slot);
  assert.deepEqual([ours.current(),ours.heard(),ours.matchesLaunch(),ours.verified()],[native.current(),native.heard(),native.matches(),native.verified()]);
 }
});
