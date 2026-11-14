import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);const {createHybridOidcLogin}=require('../desktop/hybrid-oidc-login.cjs');
function oidc(origin){return {storeKey:'hybrid:fixture:unknown',clientId:'fixture-client',scopes:'user:profile org:desktop_config',authorizationUrl:'https://id.example.test/oauth/authorize',tokenUrl:origin+'/v1/oauth/token',apiOrigin:origin,orgUuid:'aabbccdd-1111-2222-3333-aabbccddeeff'};}
async function server(){const requests=[];const srv=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push({path:req.url,headers:req.headers,body:JSON.parse(body)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('/revoke')?{}:{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:600,scope:'user:profile org:desktop_config'}));});await new Promise(r=>srv.listen(0,'127.0.0.1',r));return {origin:`http://127.0.0.1:${srv.address().port}`,requests,close:async()=>{srv.closeAllConnections();await new Promise(r=>srv.close(r));}};}
async function browser(url){const a=new URL(url), callback=new URL(a.searchParams.get('redirect_uri'));callback.searchParams.set('state',a.searchParams.get('state'));callback.searchParams.set('code','fixture-code');const response=await fetch(callback);assert.equal(response.status,200);}

test('actual loopback callback and exchange use matching PKCE and bind before persisting',async()=>{
 const s=await server(),writes=[],events=[];let auth;const login=createHybridOidcLogin({openBrowser:async url=>{auth=new URL(url);const bad=new URL(auth.searchParams.get('redirect_uri'));bad.searchParams.set('state','wrong');assert.equal((await fetch(bad)).status,400);await browser(url);},fetch,slotStore:{write:async(k,c)=>{events.push('write');writes.push([k,c]);}},assertTokenBoundToHybridOrg:async(o,token)=>{events.push('bind');assert.equal(token,'fixture-access');return {accountUuid:'fixture-account'}},now:()=>1000});
 try{const result=await login.signIn(oidc(s.origin));assert.deepEqual(result,{ok:true,accountUuid:'fixture-account'});assert.deepEqual(events,['bind','write']);assert.equal(writes.length,1);assert.equal(writes[0][1].expiresAt,601000);const exchange=s.requests[0];assert.equal(exchange.body.grant_type,'authorization_code');assert.equal(exchange.body.code,'fixture-code');assert.equal(exchange.body.state,auth.searchParams.get('state'));assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'),auth.searchParams.get('code_challenge'));assert.equal(exchange.headers['anthropic-version'],'2023-06-01');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');}finally{await s.close();}
});

test('mismatched organization revokes both tokens and never writes',async()=>{
 const s=await server();let writes=0;const login=createHybridOidcLogin({openBrowser:browser,fetch,slotStore:{write:async()=>writes++},assertTokenBoundToHybridOrg:async()=>{throw Error('org mismatch')}});
 try{await assert.rejects(login.signIn(oidc(s.origin)),/org mismatch/);assert.equal(writes,0);assert.deepEqual(s.requests.slice(1).map(r=>r.body.token_type_hint).sort(),['access_token','refresh_token']);}finally{await s.close();}
});

test('changed context during org verification does not persist grant',async()=>{
 const s=await server();let current=true,writes=0;const login=createHybridOidcLogin({openBrowser:browser,fetch,slotStore:{write:async()=>writes++},assertTokenBoundToHybridOrg:async()=>{current=false;return {}}});
 try{await assert.rejects(login.signIn(oidc(s.origin),{isCurrent:()=>current}),/context changed/);assert.equal(writes,0);assert.equal(s.requests.filter(r=>r.path.endsWith('/revoke')).length,2);}finally{await s.close();}
});

test('abort of pending browser flow closes listener and performs no exchange',async()=>{
 const s=await server(), abort=new AbortController();let requests=0;const login=createHybridOidcLogin({openBrowser:async()=>{abort.abort();},fetch:async(...args)=>{requests++;return fetch(...args)},slotStore:{write:async()=>{throw Error('unexpected')}},assertTokenBoundToHybridOrg:async()=>({})});
 try{await assert.rejects(login.signIn(oidc(s.origin),{signal:abort.signal}));assert.equal(requests,0);}finally{await s.close();}
});

test('reject non-HTTPS and non-loopback endpoints before opening browser',async()=>{
 let called=false;const login=createHybridOidcLogin({openBrowser:async()=>{called=true},fetch,slotStore:{write:async()=>{}},assertTokenBoundToHybridOrg:async()=>({})});const o=oidc('http://not-loopback.test');await assert.rejects(login.signIn(o),/must use https/);assert.equal(called,false);
});

test('invalidation cancels active and queued same-slot login before browser opens again',async()=>{
 const s=await server();let opened=0,notify;const started=new Promise(r=>{notify=r});const login=createHybridOidcLogin({openBrowser:async()=>{opened++;notify()},fetch,slotStore:{write:async()=>{}},assertTokenBoundToHybridOrg:async()=>({})});
 try{const first=login.signIn(oidc(s.origin)),second=login.signIn(oidc(s.origin));first.catch(()=>{});second.catch(()=>{});await started;login.invalidate();await assert.rejects(first);await assert.rejects(second);assert.equal(opened,1);}finally{await s.close();}
});

test('retained memory-only IO failure is success and does not revoke grant',async()=>{
 const s=await server();let stored;const login=createHybridOidcLogin({openBrowser:browser,fetch,slotStore:{write:(k,c)=>{stored=c;const e=new Error('disk unavailable');e.credentialRetained=true;e.memoryOnly=true;e.receipt={rollbackIfCurrent:()=>{stored=undefined;return true}};throw e;}},assertTokenBoundToHybridOrg:async()=>({})});
 try{assert.deepEqual(await login.signIn(oidc(s.origin)),{ok:true});assert.equal(stored.accessToken,'fixture-access');assert.equal(s.requests.filter(r=>r.path.endsWith('/revoke')).length,0);}finally{await s.close();}
});

test('encryption unavailable with current context keeps memory grant and does not revoke',async()=>{
 const s=await server();let stored;const login=createHybridOidcLogin({openBrowser:browser,fetch,slotStore:{write:(k,c)=>{stored=c;const e=new Error('locked');e.code='HYBRID_ENCRYPTION_UNAVAILABLE';e.credentialRetained=true;e.memoryOnly=true;e.receipt={rollbackIfCurrent:()=>{stored=undefined;return true}};throw e;}},assertTokenBoundToHybridOrg:async()=>({})});
 try{await assert.rejects(login.signIn(oidc(s.origin)),/locked/);assert.equal(stored.accessToken,'fixture-access');assert.equal(s.requests.filter(r=>r.path.endsWith('/revoke')).length,0);}finally{await s.close();}
});

test('async commit cancelled before resolution rolls back then revokes',async()=>{
 const s=await server();let current=true,stored,release,notify;const started=new Promise(r=>{notify=r});const login=createHybridOidcLogin({openBrowser:browser,fetch,slotStore:{write:(k,c)=>{stored=c;notify();return new Promise(r=>{release=()=>r({rollbackIfCurrent:()=>{stored=undefined;return true}})});}},assertTokenBoundToHybridOrg:async()=>({})});
 try{const work=login.signIn(oidc(s.origin),{isCurrent:()=>current});work.catch(()=>{});await started;current=false;release();await assert.rejects(work,/context changed/);assert.equal(stored,undefined);assert.equal(s.requests.filter(r=>r.path.endsWith('/revoke')).length,2);}finally{await s.close();}
});

test('failed rollback never revokes a still-committed slot',async()=>{
 const s=await server();let current=true;const login=createHybridOidcLogin({openBrowser:browser,fetch,slotStore:{write:async()=>{current=false;return {rollbackIfCurrent:()=>{throw Error('disk locked')}}}},assertTokenBoundToHybridOrg:async()=>({})});
 try{await assert.rejects(login.signIn(oidc(s.origin),{isCurrent:()=>current}),/rollback failed/);assert.equal(s.requests.filter(r=>r.path.endsWith('/revoke')).length,0);}finally{await s.close();}
});

test('abort closes listener when browser-launch promise never resolves',async()=>{
 const s=await server();let notify,callbackUrl;const started=new Promise(r=>{notify=r});const abort=new AbortController();const login=createHybridOidcLogin({openBrowser:async url=>{callbackUrl=new URL(url).searchParams.get('redirect_uri');notify();return new Promise(()=>{});},fetch,slotStore:{write:async()=>{}},assertTokenBoundToHybridOrg:async()=>({})});
 try{const work=login.signIn(oidc(s.origin),{signal:abort.signal});work.catch(()=>{});await started;abort.abort();await assert.rejects(work);await assert.rejects(fetch(callbackUrl));}finally{await s.close();}
});

test('upstream jtn/Ww locked-storage branch retains grant and skips revoke',async()=>{
 const source=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
 const jtn=source.slice(source.indexOf('async function jtn('),source.indexOf('async function Mtn('));
 const ww=source.slice(source.indexOf('function Ww(e,t)'),source.indexOf('function Jtn('));assert.ok(jtn.includes('e instanceof sx'));assert.ok(ww.includes('Iw[e]=t'));
 const sx=class sx extends Error{};let revokes=0;
 const grant={accessToken:'fixture-access',refreshToken:'fixture-refresh'};
 const sandbox={sx,Iw:{},a:{safeStorage:{isEncryptionAvailable:()=>false}},Lw:{capture:()=>()=>false},Pw:{run:(_k,fn)=>fn()},Hw:()=> 'fixture-slot',rx:()=>{},Dw:async()=>grant,Mw:null,
  GF:{hybridOidcFor:async()=>({authorizationUrl:'https://id.invalid',tokenUrl:'https://id.invalid/token',clientId:'fixture',scopes:''}),assertTokenBoundToHybridOrg:async()=>({}),revokeHybridGrant:()=>{revokes++}},T5t:{invalidateHybridAccount:()=>{}},KC:{noteIncomingHybridGrant:()=>{},recordHybridIdentity:async()=>{}},N:{warn:()=>{},info:()=>{}},P:()=>'',Buffer};
 vm.createContext(sandbox);vm.runInContext(`${ww};${jtn}`,sandbox);
 await assert.rejects(sandbox.jtn('fixture-bootstrap'),e=>e instanceof sx);assert.equal(sandbox.Iw['fixture-slot'],grant);assert.equal(revokes,0);
});

test('encryption failure after context becomes stale rolls back then revokes',async()=>{
 const s=await server();let stored,current=true;const login=createHybridOidcLogin({openBrowser:browser,fetch,slotStore:{write:(k,c)=>{stored=c;current=false;const e=new Error('locked');e.code='HYBRID_ENCRYPTION_UNAVAILABLE';e.credentialRetained=true;e.memoryOnly=true;e.receipt={rollbackIfCurrent:()=>{stored=undefined;return true}};throw e;}},assertTokenBoundToHybridOrg:async()=>({})});
 try{await assert.rejects(login.signIn(oidc(s.origin),{isCurrent:()=>current}),/context changed/);assert.equal(stored,undefined);assert.equal(s.requests.filter(r=>r.path.endsWith('/revoke')).length,2);}finally{await s.close();}
});

test('explicit unchanged-slot error revokes the unused grant',async()=>{
 const s=await server();let writes=0;const login=createHybridOidcLogin({openBrowser:browser,fetch,slotStore:{write:()=>{writes++;const e=new Error('cancelled before commit');e.slotUnchanged=true;throw e;}},assertTokenBoundToHybridOrg:async()=>({})});
 try{await assert.rejects(login.signIn(oidc(s.origin)),/cancelled before commit/);assert.equal(writes,1);assert.equal(s.requests.filter(r=>r.path.endsWith('/revoke')).length,2);}finally{await s.close();}
});
