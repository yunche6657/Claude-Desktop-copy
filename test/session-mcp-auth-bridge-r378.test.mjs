import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');

test('config auth, private callback and reconnect flow through the session bridge',async t=>{
 let status='needs-auth', authCount=0;const calls=[];
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},async sendMessage(){},getInfo(){return{actorToken:'actor'}},
  async mcpServerStatus(_id,token){return{actorToken:token,servers:[{name:'fixture',status,scope:'project',config:{type:'http',url:'https://mcp.example.test/v1'}}]}},
  async authenticateMcpServer(id,token,name){calls.push(['auth',id,token,name]);return{actorToken:token,flowId:`private-flow-${++authCount}`,requiresUserAction:true,authUrl:'https://auth.example.test/authorize'}},
  async submitMcpOAuthCallback(id,token,name,flow,url){calls.push(['callback',id,token,name,flow,url]);return{actorToken:token}},
  async reconnectMcpServer(id,token,name){calls.push(['reconnect',id,token,name]);status='connected';return{actorToken:token}},
  async clearMcpAuth(id,token,name){calls.push(['clear',id,token,name]);status='needs-auth';return{actorToken:token}}};
 const kernel=createSessionKernel({backend,emit(){}});t.after(()=>kernel.dispose());kernel.start({sessionId:'s'});await kernel.refreshCliMcpStatus('s');
 const handlers=new Map();registerBridgeServices({ipcMain:{handle:(c,fn)=>handlers.set(c,fn),removeHandler(){}},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>({isDestroyed:()=>false,webContents:{send(){}}}),settings:{sidebarMode:'epitaxy',themeMode:'system',kernelFactory:()=>kernel},frontend:{root:process.cwd()}});
 const call=(method,...args)=>handlers.get(messageChannel('claude.web','LocalSessions',method))({},...args);
 const start=await call('mcpAuthenticateConfigServer','s','fixture');assert.equal(start.authUrl,'https://auth.example.test/authorize');assert.equal(start.flowId,undefined);
 const again=await call('mcpAuthenticateConfigServer','s','fixture');assert.equal(again.authUrl,'https://auth.example.test/authorize');
 assert.deepEqual(await call('mcpSubmitOAuthCallbackUrl','s','fixture','http://localhost/callback?code=fixture'),{error:undefined});
 assert.deepEqual(await call('mcpReconnect','s','fixture'),{});
 assert.match((await call('mcpSubmitOAuthCallbackUrl','s','fixture','http://localhost/callback?code=late')).error,/verify/);
 assert.deepEqual(await call('mcpClearAuth','s','fixture'),{});
 assert.deepEqual(calls,[['auth','s','actor','fixture'],['auth','s','actor','fixture'],['callback','s','actor','fixture','private-flow-2','http://localhost/callback?code=fixture'],['reconnect','s','actor','fixture'],['clear','s','actor','fixture']]);
 assert.match((await call('mcpReconnect','s','fixture')).error,/verify/);
 const wrong=await call('mcpAuthenticate','s','fixture','https://other.example.test/mcp');assert.match(wrong.error,/different server URL/);assert.equal(calls.length,5);
 const plugin=await call('mcpAuthenticate','s','fixture','https://mcp.example.test/v1');assert.equal(plugin.authUrl,'https://auth.example.test/authorize');assert.equal(plugin.flowId,undefined);
 assert.deepEqual(await call('mcpSubmitOAuthCallbackUrl','s','fixture','http://localhost/callback?code=plugin'),{error:undefined});
 assert.deepEqual(await call('mcpReconnect','s','fixture'),{});assert.deepEqual(await call('mcpClearAuth','s','fixture'),{});
 assert.deepEqual(calls.slice(5),[['auth','s','actor','fixture'],['callback','s','actor','fixture','private-flow-3','http://localhost/callback?code=plugin'],['reconnect','s','actor','fixture'],['clear','s','actor','fixture']]);
});
