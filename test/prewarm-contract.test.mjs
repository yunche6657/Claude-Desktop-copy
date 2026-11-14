import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url);
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const {registerBridgeServices}=require('../desktop/bridge-services.cjs');
function fixture(){
 const calls=[],removed=[],handlers=new Map();let gate=null,fail=false;
 const backend={id:'ccb',start:o=>calls.push(['start',o]),onEvent:()=>()=>{},cancel(){},dispose(){},async sendMessage(){return {text:'ok',stopReason:'end_turn'};},removeSession:id=>removed.push(id),async warm(id,opts){calls.push(['warm',id,opts]);if(gate)await gate;if(fail)throw Error('warm unavailable');}};
 const kernel=createSessionKernel({backend,emit(){}});
 const bridge=registerBridgeServices({ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler(){}},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>({isDestroyed:()=>false,webContents:{send(){}}}),settings:{kernelFactory:()=>kernel},frontend:{root:process.cwd()}});
 const call=(method,...args)=>Promise.resolve().then(()=>{const key=[...handlers.keys()].find(k=>k.endsWith('_$_LocalSessions_$_'+method));assert.ok(key,method);return handlers.get(key)({},...args);});
 const callFrom=(sender,method,...args)=>Promise.resolve().then(()=>{const key=[...handlers.keys()].find(k=>k.endsWith('_$_LocalSessions_$_'+method));return handlers.get(key)({sender},...args);});
 return {kernel,bridge,call,callFrom,calls,removed,setGate:x=>gate=x,setFail:x=>fail=x};
}
test('folder prewarm is a real initialized spare kept out of session rows until adopted',async t=>{
 const f=fixture();t.after(()=>{f.kernel.dispose();f.bridge.dispose();});let release;
 f.setGate(new Promise(r=>release=r));let settled=false;
 const pending=f.call('prewarmLocal',{cwd:process.cwd(),model:'m'}).then(x=>{settled=true;return x;});
 await new Promise(r=>setTimeout(r,5));assert.equal(settled,false);assert.deepEqual(f.kernel.getAll(),[]);
 assert.equal(f.calls[0][0],'warm');assert.equal(f.calls[0][2].reason,'prewarm');release();
 const result=await pending;assert.equal(result.kind,'spare');assert.equal(result.ready,true);assert.ok(result.sessionId);assert.equal(f.kernel.getAll().length,0);
 const s=f.kernel.start({sessionId:result.sessionId,cwd:process.cwd(),model:'m'});assert.equal(s.sessionId,result.sessionId);assert.equal(f.removed.length,0);
 assert.equal(f.kernel.getAll().length,1);assert.equal(await f.kernel.discardPrewarm(result.sessionId),false);
});
test('discard removes only the unused draft actor, never the adopted conversation',async t=>{
 const f=fixture();t.after(()=>{f.kernel.dispose();f.bridge.dispose();});
 const result=await f.call('prewarmLocal',{cwd:process.cwd(),model:'m'});
 assert.equal((await f.call('discardPrewarm',result.sessionId)).discarded,true);assert.deepEqual(f.removed,[result.sessionId]);assert.equal(f.kernel.getAll().length,0);
 assert.equal((await f.call('discardPrewarm',result.sessionId)).discarded,false);
});
test('warm refusal and unavailable folderless/auth paths never claim ready',async t=>{
 const f=fixture();t.after(()=>{f.kernel.dispose();f.bridge.dispose();});f.setFail(true);
 const refused=await f.call('prewarmLocal',{cwd:process.cwd()});assert.equal(refused.ready,false);assert.ok(refused.refusedReason);assert.equal(f.kernel.getAll().length,0);assert.equal(f.removed.length,1);
 for(const method of ['prewarmFolderless','prewarmAuth']){const answer=await f.call(method,{});assert.equal(answer.ready,false);}
});
test('LRU uses lifecycle result and known-visible state, and requires complete protections',async t=>{
 const f=fixture();t.after(()=>{f.kernel.dispose();f.bridge.dispose();});const s=f.kernel.start({cwd:process.cwd(),model:'m'});
 assert.equal((await f.kernel.sendMessage(s.sessionId,'hi')).ok,true);
 const processes=[{sessionId:s.sessionId,pid:1,idleEligible:true,initialized:true}];
 const flags=Object.fromEntries(['agentRun','stopping','cron','backgroundTasks','loopWakeup','remoteControl','lanyard','otherProtection','otherProtection2'].map(k=>[k,false]));
 assert.equal(f.kernel.pickLruIdleVictim(processes),null);
 assert.equal(f.kernel.pickLruIdleVictim(processes,{protectionForSession:()=>({agentRun:false})}),null);
 const select=()=>f.kernel.pickLruIdleVictim(processes,{protectionForSession:()=>flags});
 assert.equal(select().sessionId,s.sessionId);f.kernel.setVisibility(s.sessionId,true,'a');assert.equal(select(),null);
 f.kernel.setVisibility(s.sessionId,true,'b');f.kernel.setVisibility(s.sessionId,false,'a');assert.equal(select(),null);
 f.kernel.setVisibility(s.sessionId,false,'b');assert.equal(select().sessionId,s.sessionId);
 flags.backgroundTasks=true;assert.equal(select(),null);
});

test('renderer destruction during initialization revokes the unclaimed draft',async t=>{
 const f=fixture();t.after(()=>{f.kernel.dispose();f.bridge.dispose();});let release;
 f.setGate(new Promise(r=>release=r));const sender=new EventEmitter();
 const pending=f.callFrom(sender,'prewarmLocal',{cwd:process.cwd(),model:'m'});
 await new Promise(r=>setTimeout(r,5));sender.emit('destroyed');release();
 const result=await pending;assert.equal(result.ready,false);assert.equal(result.refusedReason,'renderer_gone');assert.equal(f.removed.length,1);assert.equal(f.kernel.getAll().length,0);
});
test('renderer destruction does not discard an adopted conversation',async t=>{
 const f=fixture();t.after(()=>{f.kernel.dispose();f.bridge.dispose();});const sender=new EventEmitter();
 const result=await f.callFrom(sender,'prewarmLocal',{cwd:process.cwd(),model:'m'});
 f.kernel.start({sessionId:result.sessionId,cwd:process.cwd(),model:'m'});sender.emit('destroyed');
 assert.equal(f.kernel.getSession(result.sessionId).sessionId,result.sessionId);assert.equal(f.removed.length,0);
});
