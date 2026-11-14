import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createMcpSessionAuth}=require('../desktop/mcp-session-auth.cjs');
const {createMcpAuthBindingRegistry}=require('../desktop/mcp-auth-binding.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
const row=(url='https://example.test/mcp',status='needs-auth',type='http')=>({name:'srv',status,transport:type,config:{type,url}});
function fixture(){
 let actor={actorToken:'a',generation:1}, servers=[row()], revision=1, proofLive=true, calls=[], auth;
 const deps={getActor:()=>actor,getStatus:()=>({actorToken:actor.actorToken,servers}),refreshStatus:async(_id,token)=>({actorToken:token,servers}),getConfigRevision:()=>revision,isLocal:()=>true,authenticate:async(_id,token)=>{calls.push('auth');return {actorToken:token,requiresUserAction:true,authUrl:'https://login.test/',flowId:'private'}},submitCallback:async(_id,token)=>{calls.push('callback');return {actorToken:token}}};
 const registry=createMcpAuthBindingRegistry({getActor:deps.getActor,issueVerified:args=>{const p=auth.getPluginAuthProof(args);return p && {url:p.url,isCurrent:()=>proofLive && p.isCurrent()}}});
 deps.getAuthBinding=registry.get;deps.establishVerified=registry.establishVerified;
 auth=createMcpSessionAuth(deps);return {deps,auth,registry,calls,setActor:a=>actor=a,setRows:r=>servers=r,setRevision:r=>revision=r,revokeProof:()=>proofLive=false};
}
function native(){
 const src=fs.readFileSync('../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js','utf8');
 const norm=fs.readFileSync('../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js','utf8');
 const nf=norm.slice(norm.indexOf('function XTe('),norm.indexOf('function ls(',norm.indexOf('function XTe(')));
 const bj=src.slice(src.indexOf('async function bj('),src.indexOf('var xj=class',src.indexOf('async function bj(')));
 const method=src.slice(src.indexOf('async mcpAuthenticate('),src.indexOf('async mcpAuthenticateConfigServer('));
 return vm.runInNewContext(`(()=>{${nf};const t={o8:XTe,M4:String,L5:{warn(){},error(){}}},YA=new Set(['needs-auth','failed','connected']),XA=new Set(['http','sse']),ZA=XA,GA=x=>({transport:x.config?.type}),RA=60000,zA=Symbol(),fx=(_s,_q,p)=>p,BA=async p=>p;${bj};return deps=>({deps,startSdkMcpOAuth:async()=>({authUrl:'https://login.test/',error:undefined,callbackExpected:undefined,redirectScheme:undefined,state:undefined}),${method}})})()`,{URL,Date,Promise});
}
test('plugin authentication matches original VM URL, status and transport gates and shape with trusted issuer',async()=>{
 for(const [expected,current,status,type] of [
  ['https://example.test/mcp','https://example.test/mcp','needs-auth','http'],
  ['https://example.test/other','https://example.test/mcp','needs-auth','http'],
  ['https://example.test/mcp','https://example.test/mcp','disabled','http'],
  ['https://example.test/mcp','https://example.test/mcp','needs-auth','stdio'],
 ]){
  const f=fixture(), r=row(current,status,type);f.setRows([r]);
  const session={query:{mcpAuthenticate(){},mcpServerStatus:async()=>[r]},backend:{kind:'local'},sdkMcpServers:[r]};
  assert.deepEqual(copy(await f.auth.mcpAuthenticate('s','srv',expected)),copy(await native()({getSession:()=>session}).mcpAuthenticate('s','srv',expected)));
 }
});
test('host-issued proof permits matching renderer and actor status, callback and reconnect lookup',async()=>{
 const f=fixture();f.deps.establishVerified=()=>false;
 assert.ok((await f.auth.mcpAuthenticate('s','srv','https://example.test/mcp')).error);assert.deepEqual(f.calls,[]);
 f.deps.establishVerified=f.registry.establishVerified;
 assert.equal((await f.auth.mcpAuthenticate('s','srv','https://example.test/mcp')).authUrl,'https://login.test/');
 const binding=f.registry.get('s','srv','a');assert.equal(binding.kind,'verified');assert.equal(binding.url,'https://example.test/mcp');
 assert.deepEqual(await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/callback'),{error:undefined});
 assert.deepEqual(f.calls,['auth','callback']);
});
test('status revision changes, issuer invalidation, and actor replacement stop in-flight control',async()=>{
 for(const change of ['revision','proof','actor']){
  const f=fixture();let resolve,started;const pending=new Promise(r=>resolve=r), begun=new Promise(r=>started=r);
  f.deps.refreshStatus=async(_id,token)=>{started();await pending;return {actorToken:token,servers:[row()]}};
  const p=f.auth.mcpAuthenticate('s','srv','https://example.test/mcp');await begun;
  if(change==='revision')f.setRevision(2);if(change==='proof')f.revokeProof();if(change==='actor')f.setActor({actorToken:'b',generation:2});
  resolve();assert.ok((await p).error);assert.deepEqual(f.calls,[]);
 }
});
test('fresh changed status or URL prevents dispatch and stale proof prevents callback',async()=>{
 const f=fixture();f.deps.refreshStatus=async(_id,token)=>({actorToken:token,servers:[row('https://other.test/mcp')]});
 assert.ok((await f.auth.mcpAuthenticate('s','srv','https://example.test/mcp')).error);assert.deepEqual(f.calls,[]);
 f.deps.refreshStatus=async(_id,token)=>({actorToken:token,servers:[row()]});await f.auth.mcpAuthenticate('s','srv','https://example.test/mcp');f.revokeProof();
 assert.ok((await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/callback')).error);assert.deepEqual(f.calls,['auth']);
});

test('plugin clear preserves binding and callback on failure; success permits host revoke',async()=>{
 const f=fixture();f.deps.controlRequestsWait=()=>false;let fail=true;
 f.deps.clear=async(_id,token)=>{if(fail)throw Error('failure');return {actorToken:token}};
 await f.auth.mcpAuthenticate('s','srv','https://example.test/mcp');const binding=f.registry.get('s','srv','a');
 assert.ok((await f.auth.mcpClearAuth('s','srv')).error);assert.equal(binding.isCurrent(),true);
 assert.deepEqual(await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/callback'),{error:undefined});
 fail=false;assert.deepEqual(await f.auth.mcpClearAuth('s','srv'),{});assert.equal(binding.isCurrent(),false);
 assert.equal(f.registry.revoke('s','srv','a'),true);assert.equal(f.registry.get('s','srv','a').kind,'none');
});
test('failed repeat preflight preserves old verified binding; dispatch failure keeps new verified binding',async()=>{
 const f=fixture();await f.auth.mcpAuthenticate('s','srv','https://example.test/mcp');const old=f.registry.get('s','srv','a');
 assert.ok((await f.auth.mcpAuthenticate('s','srv','https://wrong.test/mcp')).error);assert.equal(old.isCurrent(),true);
 f.deps.authenticate=async()=>{throw Error('failure')};assert.ok((await f.auth.mcpAuthenticate('s','srv','https://example.test/mcp')).error);
 assert.equal(old.isCurrent(),false);const fresh=f.registry.get('s','srv','a');assert.equal(fresh.kind,'verified');assert.equal(fresh.isCurrent(),true);
});
