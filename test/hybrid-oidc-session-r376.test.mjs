import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);const {deriveHybridOidc,createHybridOidcSession}=require('../desktop/hybrid-oidc-session.cjs');
const orig=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const segment=orig.slice(orig.indexOf('function Cl(e)'),orig.indexOf('function Gze(e)'));
assert.ok(segment.includes('function Wze(e)'));
const originalSlot=vm.runInNewContext(`const Wse=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;const Gn=e=>typeof e==='string'&&Wse.test(e);${segment}; Wze`,{URL,decodeURIComponent});
const defaults={apiHost:'https://api.anthropic.com',clientId:'fixture-client',scopes:'user:profile org:desktop_config',authorizationOrigin:'https://claude.ai'};
const oidc=()=>deriveHybridOidc('https://api.anthropic.com/v1/desktop/orgs/AABBCCDD-1111-2222-3333-AABBCCDDEEFF/bootstrap',defaults);
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
function harness(initial,overrides={}) {const map=new Map(initial?[[oidc().storeKey,initial]]:[]);let time=1000;const session=createHybridOidcSession({storage:{read:async k=>map.get(k),write:async(k,v)=>map.set(k,v)},fetch:async()=>{throw Error('offline')},now:()=>time,random:()=>0,...overrides});return {session,map,setTime:t=>time=t};}
const cred=(extra={})=>({accessToken:'old-fixture',refreshToken:'refresh-fixture',expiresAt:50000,tokenUrl:'https://controlled.invalid/token',clientId:'fixture-client',grantedScopes:['user:profile','org:desktop_config'],...extra});

test('slot key agrees with extracted upstream and does not confuse bootstrap origin with OAuth origin',()=>{
 for(const url of ['https://api.claude.ai/v1/desktop/orgs/AABBCCDD-1111-2222-3333-AABBCCDDEEFF/bootstrap','https://api.anthropic.com/x','https://api.anthropic.com/v1/desktop/orgs/%ZZ/bootstrap']) assert.equal(deriveHybridOidc(url,defaults).storeKey,originalSlot(url));
 const x=oidc();assert.equal(x.orgUuid,'aabbccdd-1111-2222-3333-aabbccddeeff');assert.equal(x.authorizationUrl,'https://claude.ai/oauth/authorize?orgUUID=aabbccdd-1111-2222-3333-aabbccddeeff');assert.equal(x.tokenUrl,'https://api.anthropic.com/v1/oauth/token');
});

test('absent, valid, and exactly 60-second early-expiry branches',async()=>{
 let n=0;const a=harness(null,{fetch:async()=>{n++;throw Error()}});assert.deepEqual(await a.session.getBearer(oidc()),{ok:false,kind:'auth'});assert.equal(n,0);
 const b=harness(cred({expiresAt:61001}),{fetch:async()=>{n++;throw Error()}});assert.deepEqual(await b.session.getBearer(oidc()),{ok:true,bearer:'old-fixture'});assert.equal(n,0);
 const c=harness(cred({expiresAt:61000}),{fetch:async()=>{n++;throw Error()}});assert.deepEqual(await c.session.getBearer(oidc()),{ok:false,kind:'unreachable'});assert.equal(n,1);
});

test('actual loopback refresh uses JSON wire contract, rotates and persists existing credential',async()=>{
 const requests=[];const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push({headers:req.headers,method:req.method,body:JSON.parse(body)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({access_token:'new-fixture',refresh_token:'rotated-fixture',expires_in:1800,scope:'user:profile,org:desktop_config'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const key=oidc().storeKey;const c=cred({tokenUrl:`http://127.0.0.1:${server.address().port}/token`});const h=harness(c,{fetch});
 try{assert.deepEqual(await h.session.getBearer(oidc()),{ok:true,bearer:'new-fixture'});assert.deepEqual(requests[0].body,{grant_type:'refresh_token',refresh_token:'refresh-fixture',client_id:'fixture-client',scope:'user:profile org:desktop_config'});assert.equal(requests[0].headers['anthropic-version'],'2023-06-01');assert.equal(requests[0].headers['content-type'],'application/json');assert.equal(h.map.get(key).refreshToken,'rotated-fixture');assert.equal(h.map.get(key).expiresAt,1801000);assert.equal(requests.length,1);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('invalid grant retains slot, memoizes rejection, and invalidate permits retry',async()=>{
 let calls=0;const h=harness(cred(),{fetch:async()=>{calls++;return new Response(JSON.stringify({error:'invalid_grant'}),{status:400});}});
 assert.deepEqual(await h.session.getBearer(oidc()),{ok:false,kind:'auth'});assert.ok(h.map.has(oidc().storeKey));assert.deepEqual(await h.session.getBearer(oidc()),{ok:false,kind:'auth'});assert.equal(calls,1);h.session.invalidate();await h.session.getBearer(oidc());assert.equal(calls,2);
});

test('transient and unchanged token impose global five-minute suppression',async()=>{
 let calls=0;const h=harness(cred(),{fetch:async()=>{calls++;return new Response(JSON.stringify({access_token:'old-fixture',expires_in:3600}),{status:200});}});
 assert.deepEqual(await h.session.getBearer(oidc()),{ok:false,kind:'unreachable'});assert.deepEqual(await h.session.getBearer(oidc()),{ok:true,bearer:'old-fixture'});assert.equal(calls,1);
 const b=harness(cred(),{fetch:async()=>{calls++;throw Error('down')}});assert.deepEqual(await b.session.getBearer(oidc()),{ok:false,kind:'unreachable'});await b.session.getBearer(oidc());assert.equal(calls,2);b.setTime(301001);await b.session.getBearer(oidc());assert.equal(calls,3);
});

test('same slot simultaneous refresh serializes and invalidate blocks late write',async()=>{
 const d=defer();let calls=0;const h=harness(cred(),{fetch:()=>{calls++;return d.promise}});const one=h.session.getBearer(oidc()),two=h.session.getBearer(oidc());await new Promise(r=>setImmediate(r));assert.equal(calls,1);h.session.invalidate();d.resolve(new Response(JSON.stringify({access_token:'late-fixture'}),{status:200}));assert.deepEqual(await one,{ok:false,kind:'auth'});assert.deepEqual(await two,{ok:false,kind:'auth'});assert.equal(h.map.get(oidc().storeKey).accessToken,'old-fixture');
});

test('native public defaults select staging by bootstrap origin and production fallback',()=>{
 const prod=deriveHybridOidc('https://api.claude.ai/any');assert.equal(prod.clientId,'eecb31a3-ffc9-4391-83ba-d63733df2f47');assert.equal(prod.apiOrigin,'https://api.anthropic.com');assert.equal(prod.scopes,'user:profile org:desktop_config');assert.equal(prod.xAuthorization,false);
 const staging=deriveHybridOidc('https://api-staging.anthropic.com/any');assert.equal(staging.clientId,'104f6bf0-7787-407c-a39c-69f7005305aa');assert.equal(staging.xAuthorization,true);
});
