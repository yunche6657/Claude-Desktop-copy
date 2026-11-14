import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {createHybridOidcSession}=require('../desktop/hybrid-oidc-session.cjs');
const source=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const ptn=source.slice(source.indexOf('function Ptn('),source.indexOf('async function Ftn(',source.indexOf('function Ptn(')));const ltn=source.slice(source.indexOf('async function Ltn('),source.indexOf('async function ztn(',source.indexOf('async function Ltn(')));const jtn=source.slice(source.indexOf('function Jtn('),source.indexOf('function Ytn(',source.indexOf('function Jtn(')));assert.ok(ptn&&ltn&&jtn);
function native(){let slot={accessToken:'old',refreshToken:'refresh',expiresAt:10},calls=0;const sandbox={Hw:()=> 'slot',Uw:()=>slot,Ww:(_k,c)=>{slot=c},Ytn:()=>{slot=undefined},Lw:{capture:()=>()=>false},_tn:{run:(_k,fn)=>fn()},Date:{now:()=>100},ftn:60000,Fw:new Map,tS:()=>false,qen:async()=>{calls++;return {ok:true,cred:{accessToken:'new',refreshToken:'refresh',expiresAt:3600100}}},N:{warn(){}},P:()=>'',Htn:undefined,rx:()=>{},eS:()=>({waitMs:0}),jw:class extends Error{},htn:class extends Error{},Bw:undefined,Vw:0,Itn:300000};vm.createContext(sandbox);vm.runInContext(`${jtn};${ptn};async function Ftn(e){try{return{ok:true,bearer:await Ptn(e,true)}}catch(e){return{ok:false,kind:e instanceof jw?'auth':'unreachable'}}};${ltn}`,sandbox);return {sandbox,get:()=>slot,calls:()=>calls};}
test('original Jtn followed by Ltn rejects empty access but Ptn refreshes; adapter matches both',async()=>{
 const n=native();n.sandbox.Jtn('slot');assert.equal(n.get().accessToken,'');const result=await n.sandbox.Ltn({storeKey:'slot',anthropicTokenEndpoint:true});assert.deepEqual(JSON.parse(JSON.stringify(result)),{ok:false,kind:'auth'});assert.equal(n.calls(),0);assert.equal(await n.sandbox.Ptn({storeKey:'slot',anthropicTokenEndpoint:true},true),'new');assert.equal(n.calls(),1);
 let stored={accessToken:'',refreshToken:'refresh',tokenUrl:'https://fixture.invalid/token',clientId:'fixture'},calls=0;const session=createHybridOidcSession({storage:{read:()=>stored,write:(_k,v)=>{stored=v}},now:()=>100,fetch:async()=>{calls++;return new Response(JSON.stringify({access_token:'new',expires_in:3600}),{status:200})}});const oidc={storeKey:'slot'};
 assert.deepEqual(await session.getBearer(oidc),{ok:false,kind:'auth'});assert.equal(calls,0);assert.deepEqual(await session.getBootstrapBearer(oidc),{ok:true,bearer:'new'});assert.equal(calls,1);assert.equal(stored.accessToken,'new');
});
test('Ptn bootstrap refresh reports transient versus auth without requiring old access',async()=>{
 for(const [response,expected] of [[()=>{throw Error('offline')},'unreachable'],[()=>new Response('{"error":"invalid_grant"}',{status:400}),'auth']]){let stored={accessToken:'',refreshToken:'r',tokenUrl:'https://fixture.invalid',clientId:'c'};const s=createHybridOidcSession({storage:{read:()=>stored,write:(_k,v)=>stored=v},fetch:response,now:()=>100});assert.deepEqual(await s.getBootstrapBearer({storeKey:'slot'},{background:true}),{ok:false,kind:expected});}
});

test('native Ptn foreground invalid_grant deletes slot; background retains it',async()=>{
 for(const background of [false,true]){let slot={accessToken:'',refreshToken:'r',tokenUrl:'https://fixture.invalid',clientId:'c'},deleted=0;
 const s=createHybridOidcSession({storage:{read:()=>slot,write:()=>{},delete:()=>{deleted++;slot=undefined}},fetch:async()=>new Response('{"error":"invalid_grant"}',{status:400}),now:()=>100});
 assert.deepEqual(await s.getBootstrapBearer({storeKey:'slot'},{background}),{ok:false,kind:'auth'});assert.equal(deleted,background?0:1);assert.equal(!!slot,background);}
});
test('native backoff exposes retryAt only when subsequent call is already held',async()=>{
 let calls=0;const slot={accessToken:'',refreshToken:'r',tokenUrl:'https://fixture.invalid',clientId:'c'};const s=createHybridOidcSession({storage:{read:()=>slot,write:()=>{}},fetch:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'20'}})},now:()=>100,random:()=>0});
 assert.deepEqual(await s.getBootstrapBearer({storeKey:'slot'},{background:true}),{ok:false,kind:'unreachable'});assert.deepEqual(await s.getBootstrapBearer({storeKey:'slot'},{background:true}),{ok:false,kind:'unreachable',retryAt:20100});assert.equal(calls,1);
});
test('foreground missing delete capability is explicit rather than claiming slot cleared',async()=>{
 const slot={accessToken:'',refreshToken:'r',tokenUrl:'https://fixture.invalid',clientId:'c'};const s=createHybridOidcSession({storage:{read:()=>slot,write:()=>{}},fetch:async()=>new Response('{"error":"invalid_grant"}',{status:400}),now:()=>100});assert.deepEqual(await s.getBootstrapBearer({storeKey:'slot'}),{ok:false,kind:'auth',slotRemoval:'unavailable'});
});

test('upstream Ptn VM foreground/background invalid_grant and held retryAt',async()=>{
 for(const background of [false,true]){let slot={accessToken:'',refreshToken:'r'},deleted=0;const n=native();n.sandbox.Uw=()=>slot;n.sandbox.Ytn=()=>{slot=undefined;deleted++};n.sandbox.qen=async()=>({ok:false,invalidGrant:true});await assert.rejects(n.sandbox.Ptn({storeKey:'slot',anthropicTokenEndpoint:true},background));assert.equal(deleted,background?0:1);}
 const n=native();n.sandbox.Uw=()=>({accessToken:'',refreshToken:'r'});n.sandbox.Fw.set('slot',{notBefore:20100,consecutive:1});n.sandbox.tS=()=>true;n.sandbox.htn=class extends Error{constructor(retryAt){super();this.retryAt=retryAt;}};await assert.rejects(n.sandbox.Ptn({storeKey:'slot',anthropicTokenEndpoint:true},true),e=>e.retryAt===20100);
});
