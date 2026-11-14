import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const {parseTaskFile}=require('../desktop/scheduled-tasks.cjs');

test('scheduled-task IPC confirms a dispatched session after start rather than when delivered or ACKed',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-ipc-'));
  const handlers=new Map();let kernel,dispatch,resolveDispatch;
  const received=new Promise(resolve=>{resolveDispatch=resolve});
  const timer=setTimeout(()=>resolveDispatch(null),5000);
  const bridge=registerBridgeServices({ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler:c=>handlers.delete(c)},
    bridgeMap:require('../desktop/shim/bridge-map.json'),frontend:{root},
    getMainWindow:()=>({isDestroyed:()=>false,webContents:{send:(c,e)=>{if(c===messageChannel('claude.web','CCDScheduledTasks','onScheduledTaskEvent')&&e.type==='session_started'){dispatch=e;resolveDispatch(e);}},isLoadingMainFrame:()=>false}}),
    settings:{dataDir:root,kernelFactory:({emit})=>{kernel=createSessionKernel({emit,createAgent:()=>({run:async()=>({text:'SCHEDULED_FIXTURE_DONE'})})});return kernel;}}});
  t.after(async()=>{clearTimeout(timer);await bridge.dispose();fs.rmSync(root,{recursive:true,force:true});});
  const call=(service,method,...args)=>handlers.get(messageChannel('claude.web',service,method))({},...args);
  assert.equal(await call('CCDScheduledTasks','setEventAckSupported'),true);
  assert.equal(await call('CCDScheduledTasks','markListenerReady'),true);
  const task=await call('CCDScheduledTasks','createScheduledTask',{name:'ipc-task',description:'fixture',prompt:'Run fixture',cwd:root,fireAt:Date.now()+40});
  await received;assert.ok(dispatch,'real scheduler timer did not dispatch');
  assert.equal(dispatch.scheduledTask.id,task.id);
  assert.equal((await call('CCDScheduledTasks','getAllScheduledTasks'))[0].enabled,true);
  assert.equal(await call('CCDScheduledTasks','ackEvent',dispatch.ackId),true);
  assert.equal((await call('CCDScheduledTasks','getAllScheduledTasks'))[0].enabled,true);
  const content=await call('CCDScheduledTasks','getScheduledTaskFileContent',task.id);
  const started=await call('LocalSessions','start',{...dispatch.ccdSessionStart,scheduledTaskId:task.id,message:parseTaskFile(content).prompt});
  assert.equal(started.sessionId,dispatch.sessionId);
  assert.equal(started.scheduledTaskId,task.id);
  const after=(await call('CCDScheduledTasks','getAllScheduledTasks'))[0];
  assert.equal(after.enabled,false);assert.equal(typeof after.lastRunAt,'string');
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(kernel.getTranscript(started.sessionId).some(r=>r.type==='assistant'));
  const again=await call('LocalSessions','start',{...dispatch.ccdSessionStart,scheduledTaskId:task.id,message:'must not duplicate'});
  assert.equal(again.sessionId,started.sessionId);
  assert.equal(kernel.getAll().length,1);
});
