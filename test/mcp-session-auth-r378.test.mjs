import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {createMcpSessionAuth}=createRequire(import.meta.url)('../desktop/mcp-session-auth.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function setup(){
 let actor={actorToken:'a',generation:1}, binding='none', servers=[{name:'srv',status:'needs-auth',transport:'http',config:{type:'http',url:'https://example.test/mcp'}}], calls=[];
 const deps={getConfigRevision:()=>1,getAuthBinding:()=>({kind:binding,isCurrent:()=>true}),resetConfigAuth:()=>{if(binding==='verified')return false;binding='none';return true;},getActor:()=>actor,getStatus:()=>({actorToken:actor.actorToken,servers}),refreshStatus:async()=>({actorToken:actor.actorToken,servers}),isLocal:()=>true,controlRequestsWait:()=>false,authenticate:async(_id,token)=>{calls.push('auth');return {actorToken:token,requiresUserAction:true,authUrl:'https://issuer.test/auth',flowId:'private'}},submitCallback:async(_id,token,_name,flow,url)=>{calls.push(['callback',flow,url]);return {actorToken:token}},clear:async(_id,token)=>{calls.push('clear');return {actorToken:token}}};
 const raw=createMcpSessionAuth(deps);const auth={...raw,mcpAuthenticateConfigServer:async(...args)=>{const result=await raw.mcpAuthenticateConfigServer(...args);if(!result.error)binding='config-auth';return result;}};return {deps,auth,calls,setActor:a=>actor=a,setServers:s=>servers=s};
}
const row=(url='https://example.test/mcp')=>({name:'srv',status:'needs-auth',transport:'http',config:{type:'http',url}});
test('original config auth VM matches core gates and result shape',async()=>{
 const src=fs.readFileSync('../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js','utf8');
 const method=src.slice(src.indexOf('async mcpAuthenticateConfigServer('),src.indexOf('async startSdkMcpOAuth('));
 const native=vm.runInNewContext(`(deps)=>({deps,startSdkMcpOAuth:async()=>({authUrl:'https://issuer.test/auth',error:undefined,callbackExpected:undefined,redirectScheme:undefined,state:undefined}),${method}})`,{Date,RA:60000,BA:async p=>p,zA:Symbol(),YA:new Set(['needs-auth','failed','connected']),XA:new Set(['http','sse']),ZA:new Set(['http','sse']),GA:r=>({transport:r.config?.type}),t:{L5:{warn(){},error(){}},M4:x=>x,o8:x=>x},fx:(_r,_q,p)=>p});
 const f=setup(), r=row(), query={mcpAuthenticate(){},mcpServerStatus(){}};let session={query,backend:{kind:'local'},sdkMcpServers:[r]};
 const n=native({getSession:()=>session,refreshSdkMcpStatuses:async()=>[r]});
 assert.deepEqual(copy(await f.auth.mcpAuthenticateConfigServer('s','srv')),copy(await n.mcpAuthenticateConfigServer('s','srv')));
 for(const status of ['disabled','pending']){r.status=status; f.setServers([r]);assert.deepEqual(copy(await f.auth.mcpAuthenticateConfigServer('s','srv')),copy(await n.mcpAuthenticateConfigServer('s','srv')));}
});
test('private flow and binding are bound to actor and current status URL',async()=>{
 const f=setup(), a=await f.auth.mcpAuthenticateConfigServer('s','srv');assert.equal(a.authUrl,'https://issuer.test/auth');assert.ok(!('flowId' in a));
 const proof=f.auth.getConfigAuthProof({sessionId:'s',serverName:'srv',actorToken:'a',generation:1});assert.equal(proof.isCurrent(),true);
 f.setServers([row('https://other.test/')]);assert.equal(proof.isCurrent(),false);assert.match((await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=1')).error,/verify/);assert.deepEqual(f.calls,['auth']);
 f.setServers([row()]);await f.auth.mcpAuthenticateConfigServer('s','srv');assert.deepEqual(await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=2'),{error:undefined});
 assert.match((await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=2')).error,/verify/);assert.deepEqual(f.calls.at(-1),['callback','private','http://localhost/?code=2']);
 f.setActor({actorToken:'b',generation:2});assert.equal(proof.isCurrent(),false);
});
test('a callback rejected before dispatch can be retried exactly once',async()=>{
 const f=setup();await f.auth.mcpAuthenticateConfigServer('s','srv');let attempts=0;
 f.deps.formatError=e=>e.message;
 f.deps.submitCallback=async(_id,token)=>{if(++attempts===1)throw Object.assign(new Error('busy'),{code:'MCP_CONTROL_BUSY'});return{actorToken:token}};
 assert.deepEqual(await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x'),{error:'busy'});
 assert.deepEqual(await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x'),{error:undefined});
 assert.match((await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x')).error,/verify/);
 assert.equal(attempts,2);
});
test('a callback whose preflight fails remains available for retry',async()=>{
 const f=setup();await f.auth.mcpAuthenticateConfigServer('s','srv');let fail=true;
 const refresh=f.deps.refreshStatus;f.deps.refreshStatus=async(...args)=>{if(fail)throw Error('preflight failed');return refresh(...args)};
 assert.ok((await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x')).error);
 assert.deepEqual(f.calls,['auth']);fail=false;
 assert.deepEqual(await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x'),{error:undefined});
 assert.deepEqual(f.calls.at(-1),['callback','private','http://localhost/?code=x']);
});
test('clear and replacement invalidate outstanding operations and proof',async()=>{
 const f=setup(), gate=deferred(), started=deferred();
 f.deps.authenticate=async(_id,token)=>{started.resolve();await gate.promise;return {actorToken:token,requiresUserAction:true,authUrl:'https://x/',flowId:'private'}};
 const first=f.auth.mcpAuthenticateConfigServer('s','srv');await started.promise;assert.match((await f.auth.mcpClearAuth('s','srv')).error,/in progress/);gate.resolve();assert.equal((await first).authUrl,'https://x/');assert.deepEqual(f.calls,[]);
 const g=setup();await g.auth.mcpAuthenticateConfigServer('s','srv');const proof=g.auth.getConfigAuthProof({sessionId:'s',serverName:'srv',actorToken:'a',generation:1});
 const block=deferred();g.deps.refreshStatus=()=>block.promise;const clear=g.auth.mcpClearAuth('s','srv');assert.equal(proof.isCurrent(),true);g.setActor({actorToken:'b',generation:2});assert.equal(proof.isCurrent(),false);block.resolve({actorToken:'a',servers:[row()]});assert.match((await clear).error,/Session not running/);assert.deepEqual(g.calls,['auth']);
});
test('two callbacks cannot dispatch; stale server or actor cannot send',async()=>{
 const f=setup();await f.auth.mcpAuthenticateConfigServer('s','srv');const d=deferred();f.deps.refreshStatus=()=>d.promise;
 const first=f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x');assert.match((await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x')).error,/in progress/);
 f.setActor({actorToken:'new',generation:2});d.resolve({actorToken:'a',servers:[row()]});assert.match((await first).error,/Session not running/);assert.deepEqual(f.calls,['auth']);
});

 test('isolated local fake service exercises auth callback and clear controls', async t=>{
  const http = await import('node:http'); const received=[];
  const server=http.createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{received.push([req.url,JSON.parse(body)]);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/auth'?{actorToken:'a',requiresUserAction:true,authUrl:'https://issuer.test/auth',flowId:'local-private'}:{actorToken:'a'}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`,post=async(url,data)=>(await fetch(base+url,{method:'POST',body:JSON.stringify(data)})).json();
  const f=setup();f.deps.authenticate=(id,actorToken,name)=>post('/auth',{id,actorToken,name});f.deps.submitCallback=(id,actorToken,name,flow,url)=>post('/callback',{id,actorToken,name,flow,url});f.deps.clear=(id,actorToken,name)=>post('/clear',{id,actorToken,name});
  assert.equal((await f.auth.mcpAuthenticateConfigServer('s','srv')).authUrl,'https://issuer.test/auth');
  assert.deepEqual(await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=fake'),{error:undefined});assert.deepEqual(await f.auth.mcpClearAuth('s','srv'),{});
  assert.deepEqual(received.map(x=>x[0]),['/auth','/callback','/clear']);assert.equal(received[1][1].flow,'local-private');
 });

test('actor replacement cannot inherit an entry even without explicit retirement',async()=>{
 const f=setup();await f.auth.mcpAuthenticateConfigServer('s','srv');f.setActor({actorToken:'b',generation:2});
 assert.equal(f.auth.getConfigAuthProof({sessionId:'s',serverName:'srv',actorToken:'b',generation:2}),null);
 assert.match((await f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x')).error,/verify/);assert.deepEqual(f.calls,['auth']);
});
test('proof permanently expires on configuration generation change including A to B to A',async()=>{
 const f=setup();let revision=1;f.deps.getConfigRevision=()=>revision;
 await f.auth.mcpAuthenticateConfigServer('s','srv');const proof=f.auth.getConfigAuthProof({sessionId:'s',serverName:'srv',actorToken:'a',generation:1});assert.equal(proof.isCurrent(),true);
 revision=2;f.setServers([row('https://other.test/')]);assert.equal(proof.isCurrent(),false);
 revision=3;f.setServers([row()]);assert.equal(proof.isCurrent(),false);assert.equal(f.auth.getConfigAuthProof({sessionId:'s',serverName:'srv',actorToken:'a',generation:1}),null);
 const g=setup();g.deps.getConfigRevision=()=>undefined;assert.ok((await g.auth.mcpAuthenticateConfigServer('s','srv')).error);assert.deepEqual(g.calls,[]);
});
test('verified binding is preserved and no side effects dispatched',async()=>{
 const f=setup();f.deps.getAuthBinding=()=>({kind:'verified',url:'https://example.test/mcp',isCurrent:()=>true});f.deps.resetConfigAuth=()=>false;
 assert.ok((await f.auth.mcpAuthenticateConfigServer('s','srv')).error);assert.deepEqual(f.calls,[]);
});
test('clear and other controls reject while dispatched auth or callback remains unsettled',async()=>{
 const f=setup(), hold=deferred(), started=deferred();f.deps.authenticate=async(_id,token)=>{started.resolve();await hold.promise;return {actorToken:token,requiresUserAction:true,authUrl:'https://issuer.test/',flowId:'private'}};
 const p=f.auth.mcpAuthenticateConfigServer('s','srv');await started.promise;assert.ok((await f.auth.mcpClearAuth('s','srv')).error);assert.ok((await f.auth.mcpAuthenticateConfigServer('s','srv')).error);hold.resolve();await p;assert.deepEqual(f.calls,[]);
 const h=setup();await h.auth.mcpAuthenticateConfigServer('s','srv');const pending=deferred(), signal=deferred();h.deps.submitCallback=async(_id,token)=>{signal.resolve();await pending.promise;return {actorToken:token}};
 const cb=h.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x');await signal.promise;assert.ok((await h.auth.mcpClearAuth('s','srv')).error);pending.resolve();await cb;assert.deepEqual(h.calls,['auth']);
});

test('timeout keeps dispatched control locked until underlying promise settles',async()=>{
 const f=setup(),hold=deferred(),started=deferred();f.deps.timeoutMs=20;f.deps.authenticate=async(_id,token)=>{started.resolve();await hold.promise;return {actorToken:token,requiresUserAction:false}};
 const keepAlive=setTimeout(()=>{},1000);try{const pending=f.auth.mcpAuthenticateConfigServer('s','srv');await started.promise;assert.match((await pending).error,/timed out/);assert.match((await f.auth.mcpClearAuth('s','srv')).error,/in progress/);hold.resolve();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(await f.auth.mcpClearAuth('s','srv'),{});}finally{clearTimeout(keepAlive)}
});
test('observed mismatch permanently revokes proof even if source gives same revision',async()=>{
 const f=setup();await f.auth.mcpAuthenticateConfigServer('s','srv');const proof=f.auth.getConfigAuthProof({sessionId:'s',serverName:'srv',actorToken:'a',generation:1});f.setServers([row('https://other.test/')]);assert.equal(proof.isCurrent(),false);f.setServers([row()]);assert.equal(proof.isCurrent(),false);assert.equal(f.auth.getConfigAuthProof({sessionId:'s',serverName:'srv',actorToken:'a',generation:1}),null);
});

 test('registry integration permits repeated auth and recovers after failed clear',async()=>{
  const {createMcpAuthBindingRegistry}=createRequire(import.meta.url)('../desktop/mcp-auth-binding.cjs');const f=setup();let auth=f.auth;
  const registry=createMcpAuthBindingRegistry({getActor:f.deps.getActor,issueConfigAuth:p=>auth.getConfigAuthProof(p)});
  f.deps.getAuthBinding=(id,name,token)=>registry.get(id,name,token);
  f.deps.resetConfigAuth=(id,name,token)=>registry.revoke(id,name,token);
  const sign=async()=>{const r=await auth.mcpAuthenticateConfigServer('s','srv');if(!r.error)assert.equal(registry.establishConfigAuth('s','srv','a'),true);return r;};
  assert.ok((await sign()).authUrl);assert.ok((await sign()).authUrl);
  f.deps.clear=async()=>{throw Error('fixture clear failed')};assert.ok((await auth.mcpClearAuth('s','srv')).error);assert.ok((await sign()).authUrl);
 });
 test('callback is denied after registry revoke or reconnect completion',async()=>{
  const {createMcpAuthBindingRegistry}=createRequire(import.meta.url)('../desktop/mcp-auth-binding.cjs');const f=setup();let auth=f.auth;
  const registry=createMcpAuthBindingRegistry({getActor:f.deps.getActor,issueConfigAuth:p=>auth.getConfigAuthProof(p)});
  f.deps.getAuthBinding=(id,name,token)=>registry.get(id,name,token);f.deps.resetConfigAuth=(id,name,token)=>registry.revoke(id,name,token);
  await auth.mcpAuthenticateConfigServer('s','srv');assert.equal(registry.establishConfigAuth('s','srv','a'),true);
  const b=registry.get('s','srv','a');assert.equal(registry.completeReconnect('s','srv','a',b),true);
  assert.ok((await auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x')).error);assert.deepEqual(f.calls,['auth']);
 });

test('callback stops if its registry snapshot is revoked during status refresh',async()=>{
 const f=setup();await f.auth.mcpAuthenticateConfigServer('s','srv');let live=true;f.deps.getAuthBinding=()=>({kind:'config-auth',isCurrent:()=>live});const hold=deferred();f.deps.refreshStatus=()=>hold.promise;
 const operation=f.auth.mcpSubmitOAuthCallbackUrl('s','srv','http://localhost/?code=x');live=false;hold.resolve({actorToken:'a',servers:[row()]});assert.ok((await operation).error);assert.deepEqual(f.calls,['auth']);
});

test('a hung retired actor cannot lock a replacement actor or release its lock',async()=>{
 const f=setup(), oldHold=deferred(),newHold=deferred(),oldStarted=deferred(),newStarted=deferred();
 f.deps.authenticate=async(_id,token)=>{if(token==='a'){oldStarted.resolve();await oldHold.promise;}else{newStarted.resolve();await newHold.promise;}return {actorToken:token,requiresUserAction:true,flowId:token,authUrl:'https://issuer.test/auth'};};
 const old=f.auth.mcpAuthenticateConfigServer('s','srv');await oldStarted.promise;f.setActor({actorToken:'b',generation:2});const fresh=f.auth.mcpAuthenticateConfigServer('s','srv');
 const started=await Promise.race([newStarted.promise.then(()=>true),new Promise(r=>setTimeout(()=>r(false),40))]);assert.equal(started,true);
 oldHold.resolve();assert.match((await old).error,/Session not running/);assert.match((await f.auth.mcpClearAuth('s','srv')).error,/in progress/);newHold.resolve();assert.equal((await fresh).authUrl,'https://issuer.test/auth');
});
