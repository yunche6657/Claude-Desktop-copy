import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
function boot(withKernel) {
  const handlers=new Map();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-host-start-'));
  let kernel;
  const bridge=registerBridgeServices({
    ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn),on(){},removeHandler(){}},
    bridgeMap:{'claude.web':{ClaudeVM:['isHostLoopModeEnabled','getRunningStatus'],LocalAgentModeSessions:['start','getAll','getTranscript','getTranscriptRead']}},
    getMainWindow:()=>null,
    settings:{dataDir:root,...withKernel?{kernelFactory:({emit})=>(kernel=createSessionKernel({emit,createAgent:()=>({run:async()=>({text:'Cowork response',stopReason:'end_turn'})})}))}:{}},
  });
  return {call:(service,method,...args)=>handlers.get(messageChannel('claude.web',service,method))({},...args),close(){bridge.dispose?.();kernel?.dispose?.();fs.rmSync(root,{recursive:true,force:true});}};
}
test('Cowork host readiness releases frontend VM gate and starts a folderless task',async()=>{
  const b=boot(true);
  try {
    // The shipped YF readiness gate resolves immediately only for host mode or
    // runningStatus === ready. Old stopped + false held the composer forever.
    assert.equal(await b.call('ClaudeVM','isHostLoopModeEnabled'),true);
    const session=await b.call('LocalAgentModeSessions','start',{message:'hi',userSelectedFolders:[]});
    assert.ok(session.sessionId.startsWith('local_'));
    await new Promise(resolve=>setImmediate(resolve));
    const sessions=await b.call('LocalAgentModeSessions','getAll');
    assert.equal(sessions.length,1);
    const rows=await b.call('LocalAgentModeSessions','getTranscript',session.sessionId);
    assert.deepEqual(rows.map(row=>row.type),['user','assistant']);
    const read=await b.call('LocalAgentModeSessions','getTranscriptRead',session.sessionId);
    assert.deepEqual(read.messages,rows);
    assert.equal(sessions[0].isRunning,false);
  } finally { b.close(); }
});
test('a bridge without a session kernel does not advertise host execution',async()=>{
  const b=boot(false);
  try {
    assert.equal(await b.call('ClaudeVM','isHostLoopModeEnabled'),false);
    assert.equal(await b.call('ClaudeVM','getRunningStatus'),'offline');
  } finally { b.close(); }
});
