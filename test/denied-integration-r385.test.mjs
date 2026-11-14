import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../desktop/ccb-kernel.cjs',import.meta.url));
const {createCcbKernel}=require('./ccb-kernel.cjs');
const {createSessionKernel}=require('./session-kernel.cjs');
const {registerBridgeServices,messageChannel}=require('./bridge-services.cjs');

for (const mode of ['same-cycle','next-cycle','no-echo']) {
test(`denied promotion preserves original input: ${mode}`, {timeout:15000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r384-denied-'));
  const entryPath=path.join(dir,'fixture.cjs');
  fs.writeFileSync(entryPath,String.raw`
const cli=process.argv[process.argv.indexOf('--session-id')+1];
const out=f=>process.stdout.write(JSON.stringify({session_id:cli,...f})+'\n');
const sys=(subtype,props)=>out({type:'system',subtype,...props});
let pending;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 if(f.type==='control_request'){
  if(f.request.subtype==='cancel_async_message'){
   out({type:'control_response',response:{request_id:f.request_id,subtype:'success',response:{cancelled:false}}});sys('denied');return;
  }
  if(f.request.subtype==='mcp_status' && pending){
   if ('MODE'==='no-echo') {out({type:'result',subtype:'success',uuid:'result-A',result:'done',stop_reason:'end_turn'});sys('session_state_changed',{state:'idle'});}
   else if ('MODE'==='next-cycle') {
    out({type:'result',subtype:'success',uuid:'result-A',result:'done',stop_reason:'end_turn'});sys('session_state_changed',{state:'idle'});
    setTimeout(()=>{sys('session_state_changed',{state:'running'});out({...pending,session_id:cli,isReplay:true});out({type:'result',subtype:'success',uuid:'result-B',result:'second',stop_reason:'end_turn'});sys('session_state_changed',{state:'idle'});pending=null},100);
   } else {out({...pending,session_id:cli,isReplay:true});out({type:'result',subtype:'success',uuid:'result',result:'done',stop_reason:'end_turn'});sys('session_state_changed',{state:'idle'});pending=null;}
  }
  out({type:'control_response',response:{request_id:f.request_id,subtype:'success',response:{mcpServers:[]}}});return;
 }
 if(f.type!=='user')return;
 if(f.priority==='next'){pending=f;sys('written_B');return;}
 sys('session_state_changed',{state:'running'});sys('init');
 out({type:'assistant',message:{content:[{type:'tool_use',id:'open',name:'Read',input:{}}]}});
});`.replaceAll('MODE',mode));
  const backend=createCcbKernel({bunPath:process.execPath,entryPath,kernelRoot:dir,cwd:dir,homeDir:path.join(dir,'home'),scratchDir:path.join(dir,'scratch'),nativeCycleEvents:true,turnTimeoutMs:mode==='no-echo'?700:5000});
  const ui=[], session=createSessionKernel({backend,emit:e=>ui.push(e)});
  const handlers=new Map();
  const bridge=registerBridgeServices({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},bridgeMap:require('./shim/bridge-map.json'),settings:{kernelFactory:()=>session},getMainWindow:()=>null,frontend:{root:dir}});
  t.after(async()=>{bridge.dispose();session.dispose();await backend.dispose();fs.rmSync(dir,{recursive:true,force:true})});
  const {sessionId}=session.start({cwd:dir}), ready=Promise.withResolvers(),written=Promise.withResolvers();
  const call=(name,...args)=>handlers.get(messageChannel('claude.web','LocalSessions',name))({},sessionId,...args);
  backend.onEvent(e=>{if(e.type==='tool_request')ready.resolve();if(e.type==='raw'&&e.frame.subtype==='written_B')written.resolve()});
  const first=session.sendMessage(sessionId,'A');await ready.promise;
  const b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await session.sendMessage(sessionId,'B',{priority:'next',messageUuid:b});await written.promise;
  assert.equal(await call('sendSteeredNow',b),false);
  assert.deepEqual(backend.getSteerUuids(sessionId),[b]);
  assert.deepEqual(ui.filter(e=>e.type==='steers_rekeyed'||e.type==='steer_escalating'),[]);
  let settled=false;first.finally(()=>{settled=true});
  await backend.mcpServerStatus(sessionId,backend.getInfo(sessionId).actorToken);
  if(mode==='next-cycle'){await new Promise(resolve=>setTimeout(resolve,30));assert.equal(settled,false);}
  const result=await first;
  if(mode==='no-echo') {assert.match(JSON.stringify(result),/timed out/);return;}
  assert.equal(result.text,'done');
  const rows=session.getTranscript(sessionId);
  assert.equal(rows.filter(r=>r.type==='user'&&r.uuid===b).length,1);
  assert.deepEqual(backend.getSteerUuids(sessionId),[]);
});
}
