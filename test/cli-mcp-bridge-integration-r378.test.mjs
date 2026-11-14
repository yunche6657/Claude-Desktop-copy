import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');

test('CLI app bridge reads only a current announced server and URI through its actor',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cli-mcp-bridge-'));
 const previous=process.env.CLAUDE_MCP_CONFIG;process.env.CLAUDE_MCP_CONFIG=path.join(dir,'mcp.json');fs.writeFileSync(process.env.CLAUDE_MCP_CONFIG,'{"mcpServers":{}}');
 t.after(()=>{if(previous===undefined)delete process.env.CLAUDE_MCP_CONFIG;else process.env.CLAUDE_MCP_CONFIG=previous;fs.rmSync(dir,{recursive:true,force:true})});
 let version=1,listener;const reads=[];
 const backend={id:'ccb',start(){},async sendMessage(){},cancel(){},dispose(){},onEvent(){return()=>{}},getInfo(){return{actorToken:'actor'}},
  async mcpServerStatus(){return{actorToken:'actor',servers:[{name:'app',source:'project',status:'connected',tools:[{name:'view',_meta:{ui:{resourceUri:'ui://page'}}}]}]}},
  async readMcpResource(...args){reads.push(args);return{actorToken:'actor',contents:[{uri:'ui://page',text:'fixture',_meta:{ui:{visibility:'app',csp:{secret:'restricted'}}}}]}}};
 const coverage={coordinator:true,config:true,reserved:true,identities:true,session:true,tenantHistory:true,plugins:true};
 const provider={subscribe(fn){listener=fn;return()=>{}},async getSnapshot(){return{version,complete:true,featureEnabled:true,sessionAllowed:true,coverage,tenancy:{accountId:'fixture',orgId:'org'},conflicts:()=>false,cliRunsAsThisUser:false}},isCurrent(snapshot){return snapshot.version===version}};
 const kernel=createSessionKernel({backend,emit(){},cliMcpDiscovery:provider,storePath:path.join(dir,'sessions.json')});t.after(()=>kernel.dispose());kernel.start({sessionId:'s',cwd:dir});
 assert.equal(await kernel.refreshCliMcpStatus('s'),true);
 const handlers=new Map();registerBridgeServices({ipcMain:{handle:(c,fn)=>handlers.set(c,fn),removeHandler(){}},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>({isDestroyed:()=>false,webContents:{send(){}}}),settings:{sidebarMode:'epitaxy',themeMode:'system',kernelFactory:()=>kernel},frontend:{root:process.cwd()}});
 const read=handlers.get(messageChannel('claude.web','LocalSessions','mcpReadResource'));
 assert.deepEqual(await read({},'s','app','ui://page'),{contents:[{uri:'ui://page',text:'fixture',_meta:{ui:{visibility:'app'}}}]});
 assert.deepEqual(reads,[['s','actor','app','ui://page']]);
 assert.deepEqual(await read({},'s','app','ui://other'),{contents:[],unavailable:'read_failed'});
 version++;listener();
 assert.deepEqual(await read({},'s','app','ui://page'),{contents:[],unavailable:'not_connected'});
 assert.equal(reads.length,1);
});

test('session enable passes the actual bridge and targets the owning CCB actor', async t => {
 let actor='actor-a', status='disabled'; const controls=[];
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},async sendMessage(){},
  getInfo(){return{actorToken:actor}},
  async mcpServerStatus(_id,token){return{actorToken:token,servers:[{name:'fixture',status,scope:'project',config:{type:'stdio',command:'secret'}}]}},
  async toggleMcpServer(id,token,name,enabled){controls.push({id,token,name,enabled});status='connected';return{actorToken:token}},
  async reconnectMcpServer(){throw Error('no verified binding')}};
 const kernel=createSessionKernel({backend,emit(){}});t.after(()=>kernel.dispose());kernel.start({sessionId:'s'});
 assert.equal(await kernel.refreshCliMcpStatus('s'),true);
 const handlers=new Map();registerBridgeServices({ipcMain:{handle:(c,fn)=>handlers.set(c,fn),removeHandler(){}},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>({isDestroyed:()=>false,webContents:{send(){}}}),settings:{sidebarMode:'epitaxy',themeMode:'system',kernelFactory:()=>kernel},frontend:{root:process.cwd()}});
 const call=(method,...args)=>handlers.get(messageChannel('claude.web','LocalSessions',method))({},...args);
 assert.deepEqual(await call('mcpEnableServer','s','fixture'),{});
 assert.deepEqual(controls,[{id:'s',token:'actor-a',name:'fixture',enabled:true}]);
 assert.match((await call('mcpReconnect','s','fixture')).error,/verify/);
 actor='actor-b';
 assert.match((await call('mcpEnableServer','s','fixture')).error,/state unavailable/);
 assert.equal(controls.length,1);
});
