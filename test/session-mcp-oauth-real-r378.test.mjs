import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createCcbKernel}=require('../desktop/ccb-kernel.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');

test('real CCB OAuth through session and bridge against isolated local service', {skip:process.env.CCB_REAL_OAUTH_PROOF!=='1',timeout:45000}, async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'real-ccb-oauth-'));
 for(const key of Object.keys(process.env)) if(/TOKEN|API_KEY|AUTH|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete process.env[key];
 for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA']){process.env[key]=path.join(dir,key);fs.mkdirSync(process.env[key],{recursive:true})}
 Object.assign(process.env,{ANTHROPIC_BASE_URL:'http://127.0.0.1:9',ANTHROPIC_API_KEY:'fixture-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'});
 let origin, tokenIssued=false; const seen=[];
 const server=http.createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{
  const u=new URL(req.url,origin);seen.push(u.pathname);res.setHeader('Content-Type','application/json');
  if(u.pathname.includes('oauth-protected-resource'))return res.end(JSON.stringify({resource:origin+'/mcp',authorization_servers:[origin]}));
  if(u.pathname.includes('oauth-authorization-server')||u.pathname.includes('openid-configuration'))return res.end(JSON.stringify({issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']}));
  if(u.pathname==='/register')return res.end(JSON.stringify({client_id:'fixture-client',redirect_uris:JSON.parse(body).redirect_uris,token_endpoint_auth_method:'none'}));
  if(u.pathname==='/token'){tokenIssued=true;return res.end(JSON.stringify({access_token:'fixture-token',token_type:'Bearer',expires_in:3600}))}
  if(u.pathname==='/mcp'){if(req.headers.authorization!=='Bearer fixture-token'){res.statusCode=401;res.setHeader('WWW-Authenticate',`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);return res.end('{}')}if(req.method==='POST'){let q=JSON.parse(body);if(q.id===undefined){res.statusCode=202;return res.end('{}')}let result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:q.method==='tools/list'?{tools:[]}:{ };return res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}))}res.statusCode=405;return res.end('{}')}
  res.statusCode=404;res.end('{}');
 })});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 const config=path.join(dir,'mcp.json');fs.writeFileSync(config,JSON.stringify({mcpServers:{fixture:{type:'http',url:origin+'/mcp'}}}));
 const logs=[];const root=process.env.CCB_REAL_CORE || 'D:/CodexArtifacts/claude-code-desktop/R378-AUTH-RELAY-OWNERSHIP-ASAR/resources/agent-core';const k=createCcbKernel({log:msg=>logs.push(msg),permissionMode:'default',bunPath:path.join(root,'bun/bun.exe'),entryPath:path.join(root,'claude-code/dist/cli-bun.js'),kernelRoot:path.join(root,'claude-code'),cwd:dir,homeDir:path.join(dir,'ccb-home'),scratchDir:path.join(dir,'scratch'),startupTimeoutMs:30000,mcpControlTimeoutMs:15000,extraArgs:['--mcp-config',config,'--strict-mcp-config']});
 const session=createSessionKernel({backend:k,emit(){}});session.start({sessionId:'s',cwd:dir});
 const handlers=new Map();registerBridgeServices({ipcMain:{handle:(c,fn)=>handlers.set(c,fn),removeHandler(){}},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>({isDestroyed:()=>false,webContents:{send(){}}}),settings:{sidebarMode:'epitaxy',themeMode:'system',kernelFactory:()=>session},frontend:{root:process.cwd()}});
 const call=(method,...args)=>handlers.get(messageChannel('claude.web','LocalSessions',method))({},...args);
 t.after(async()=>{session.dispose();await k.dispose();await new Promise(r=>server.close(r));void dir});
 try{await k.initialize('s')}catch(e){throw new Error(e.message+' '+logs.join(' '))};const actor=k.getInfo('s').actorToken;
 for(let i=0;i<100;i++){await session.refreshCliMcpStatus('s');if(['needs-auth','failed'].includes(session.getCliMcpStatus('s')?.servers.find(x=>x.name==='fixture')?.status))break;await new Promise(r=>setTimeout(r,50))}
 const auth=await call('mcpAuthenticateConfigServer','s','fixture');assert.ok(auth.authUrl,JSON.stringify(auth));assert.equal(auth.flowId,undefined);const u=new URL(auth.authUrl);assert.equal(u.origin,origin);assert.equal(u.pathname,'/authorize');assert.equal(u.searchParams.get('client_id'),'fixture-client');
 const redirect=new URL(u.searchParams.get('redirect_uri'));redirect.searchParams.set('code','fixture-code');redirect.searchParams.set('state',u.searchParams.get('state'));
 assert.deepEqual(await call('mcpSubmitOAuthCallbackUrl','s','fixture',redirect.href),{error:undefined});assert.equal(tokenIssued,true);assert.deepEqual(await call('mcpReconnect','s','fixture'),{});assert.equal(session.getCliMcpStatus('s').servers.find(x=>x.name==='fixture').status,'connected');assert.equal(session.getSession('s').sdkMcpServers.find(x=>x.name==='fixture').status,'connected');assert.deepEqual(await call('mcpClearAuth','s','fixture'),{});
 assert.ok(seen.includes('/token'));assert.ok(seen.includes('/register'));
});






