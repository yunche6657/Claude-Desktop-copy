import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
function setup(storePath) {
  const calls=[]; let gate=null; let fail=false;
  const backend={ id:'ccb', start(o){calls.push(['start',o.sessionId,o.model]);}, onEvent(){return ()=>{};}, cancel(){}, dispose(){},
    async setModel(id,model){calls.push(['switch',id,model]); if(gate) await gate.promise; if(fail) throw Error('switch failed');},
    async sendMessage(id,_message,o){calls.push(['turn',id,o.model]); return {text:'ok',stopReason:'end_turn'};} };
  const events=[]; const kernel=createSessionKernel({backend,emit:e=>events.push(e),storePath});
  const handlers=new Map();
  registerBridgeServices({ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler:c=>handlers.delete(c)},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>null,settings:{sidebarMode:'epitaxy',themeMode:'system',kernelFactory:()=>kernel},frontend:{root:process.cwd()}});
  const call=(service,method,...args)=>{const key=[...handlers.keys()].find(c=>c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`)); return handlers.get(key)({},...args);};
  return {kernel,calls,events,call,setGate:g=>gate=g,setFail:f=>fail=f};
}
test('switch waits for acknowledgement, failure is not persisted, both bridge surfaces agree',async()=>{
 const x=setup(); const s=x.kernel.start({model:'model-a'}); const g=deferred(); x.setGate(g);
 const change=x.call('LocalSessions','setModel',s.sessionId,'model-b');
 assert.equal(x.kernel.getSession(s.sessionId).model,'model-a');
 const turn=x.kernel.sendMessage(s.sessionId,'hello');
 assert.equal(x.calls.some(c=>c[0]==='turn'),false); g.resolve(); await change; await turn;
 assert.equal(x.kernel.getSession(s.sessionId).model,'model-b'); assert.equal(x.calls.find(c=>c[0]==='turn')[2],'model-b');
 x.setGate(null); x.setFail(true); await assert.rejects(x.call('LocalAgentModeSessions','setModel',s.sessionId,'bad'),/switch failed/);
 assert.equal(x.kernel.getSession(s.sessionId).model,'model-b');
 await assert.rejects(x.call('LocalSessions','updateSession',s.sessionId,{model:'bad',title:'no'}),/switch failed/);
 assert.notEqual(x.kernel.getSession(s.sessionId).title,'no');
 for (const value of ['', '  ', ' a', 'a\n', null]) await assert.rejects(x.kernel.setModel(s.sessionId,value),/invalid model/);
 x.kernel.dispose();
});
test('separate sessions and restored sessions pass their saved model to backend',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'r362-model-')); const store=path.join(dir,'sessions.json');
 try { const x=setup(store); const a=x.kernel.start({model:'model-a'}); const b=x.kernel.start({model:'model-b'});
 await x.kernel.sendMessage(a.sessionId,'a'); await x.kernel.sendMessage(b.sessionId,'b');
 assert.deepEqual(x.calls.filter(c=>c[0]==='turn').map(c=>c[2]),['model-a','model-b']);
 await x.kernel.setModel(a.sessionId,'model-c'); x.kernel.flush(); x.kernel.dispose();
 const y=setup(store); await y.kernel.sendMessage(a.sessionId,'resume');
 assert.equal(y.calls.find(c=>c[0]==='turn')[2],'model-c'); y.kernel.dispose();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('cancel releases a non-cooperative local turn before queued switch and resend', async () => {
 let calls=0, lateEvent; const models=[], events=[];
 const kernel=createSessionKernel({emit:e=>events.push(e),createAgent:({model})=>({run:({onEvent})=>{
   models.push(model); calls++;
   if(calls===1){lateEvent=onEvent; return new Promise(()=>{});}
   return Promise.resolve({text:'second ok',stopReason:'end_turn'});
 }})});
 const s=kernel.start({model:'model-a'}); const first=kernel.sendMessage(s.sessionId,'first');
 await assert.rejects(kernel.sendMessage(s.sessionId,'duplicate'),/already running/);
 const change=kernel.setModel(s.sessionId,'model-b');
 assert.equal(kernel.cancel(s.sessionId).ok,true);
 const next=kernel.sendMessage(s.sessionId,'second');
 await assert.rejects(kernel.sendMessage(s.sessionId,'third'),/already running/);
 const results=await Promise.race([Promise.all([first,change,next]),new Promise((_,reject)=>setTimeout(()=>reject(Error('queue stuck')),1000))]);
 assert.equal(results[2].text,'second ok'); assert.deepEqual(models,['model-a','model-b']);
 const before=events.length; lateEvent({type:'text',text:'stale'}); assert.equal(events.length,before);
 assert.deepEqual(kernel.getTranscript(s.sessionId).map(row=>row.type),['user','user','assistant']);
 kernel.dispose();
});

test('a turn queued behind a model switch preserves the busy guard',async()=>{
 const x=setup(); const s=x.kernel.start({model:'model-a'}); const g=deferred(); x.setGate(g);
 const change=x.kernel.setModel(s.sessionId,'model-b'); const turn=x.kernel.sendMessage(s.sessionId,'one');
 await assert.rejects(x.kernel.sendMessage(s.sessionId,'two'),/already running/);
 g.resolve(); await change; await turn; assert.equal(x.calls.filter(c=>c[0]==='turn').length,1); x.kernel.dispose();
});

test('cancelling a turn queued behind a model change prevents its dispatch',async()=>{
 const x=setup(); const s=x.kernel.start({model:'model-a'}); const g=deferred(); x.setGate(g);
 const change=x.kernel.setModel(s.sessionId,'model-b'); const pending=x.kernel.sendMessage(s.sessionId,'never send');
 await assert.rejects(x.kernel.sendMessage(s.sessionId,'duplicate'),/already running/);
 assert.equal(x.kernel.cancel(s.sessionId).ok,true);
 const cancelled=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('cancel stuck')),500))]);
 assert.equal(cancelled.ok,false); assert.equal(cancelled.error,'cancelled');
 g.resolve(); await change; await new Promise(resolve=>setImmediate(resolve));
 assert.equal(x.calls.filter(c=>c[0]==='turn').length,0);
 const next=await x.kernel.sendMessage(s.sessionId,'send this'); assert.equal(next.ok,true);
 assert.equal(x.calls.filter(c=>c[0]==='turn').length,1); x.kernel.dispose();
});

test('removing an active session invalidates late backend events and completion',async()=>{
 const result=deferred(); let listener, cancelled=0; const events=[];
 const backend={id:'ccb',start(){},onEvent(fn){listener=fn; return ()=>{};},sendMessage(){return result.promise;},cancel(){cancelled++;},dispose(){}};
 const kernel=createSessionKernel({backend,emit:e=>events.push(e)}); const s=kernel.start({model:'model-a'});
 const turn=kernel.sendMessage(s.sessionId,'first'); assert.equal(kernel.remove(s.sessionId).ok,true); assert.equal(cancelled,1);
 assert.equal(kernel.getSession(s.sessionId),null); assert.deepEqual(kernel.getTranscript(s.sessionId),[]);
 kernel.start({sessionId:s.sessionId,model:'replacement'});
 const count=events.length; listener({type:'text',sessionId:s.sessionId,text:'late'}); result.resolve({text:'late',stopReason:'end_turn'});
 await turn; assert.equal(events.length,count); assert.equal(kernel.getSession(s.sessionId).model,'replacement'); assert.deepEqual(kernel.getTranscript(s.sessionId),[]);
 kernel.dispose();
});

test('active model selection returns before ack; rejection rolls back only the current choice',async()=>{
 const turn=deferred(), controls=[]; const events=[]; let actor='one', confirmed='model-a';
 const backend={id:'ccb',start(){},onEvent(){return ()=>{}},cancel(){},dispose(){},
  getInfo(){return {actorToken:actor,confirmedModel:confirmed}},
  sendMessage(){return turn.promise},setModel(_id,model){const d=deferred(); controls.push({model,...d}); return d.promise}};
 const kernel=createSessionKernel({backend,emit:e=>events.push(e)}); const s=kernel.start({model:'model-a'});
 const running=kernel.sendMessage(s.sessionId,'hello');
 const selected=await kernel.setModel(s.sessionId,'model-b'); assert.equal(selected.model,'model-b');
 assert.equal(kernel.getSession(s.sessionId).model,'model-b'); await new Promise(setImmediate);
 assert.equal(controls.length,1); const reject=Object.assign(Error('refused'),{code:'CCB_CONTROL_REJECTED'});
 controls[0].reject(reject); await new Promise(setImmediate);
 assert.equal(kernel.getSession(s.sessionId).model,'model-a');
 assert.ok(events.some(e=>e.type==='error' && e.code==='CCB_CONTROL_REJECTED'));
 await kernel.setModel(s.sessionId,'model-c'); await kernel.setModel(s.sessionId,'model-d'); await new Promise(setImmediate);
 controls[1].reject(reject); await new Promise(setImmediate); assert.equal(kernel.getSession(s.sessionId).model,'model-d');
 confirmed='model-d'; controls[2].resolve(); await new Promise(setImmediate);
 await kernel.setModel(s.sessionId,'model-e'); await new Promise(setImmediate);
 const timeout=Object.assign(Error('timeout'),{code:'CCB_CONTROL_TIMEOUT'}); controls[3].reject(timeout); await new Promise(setImmediate);
 assert.equal(kernel.getSession(s.sessionId).model,'model-e'); assert.ok(events.some(e=>e.code==='CCB_CONTROL_TIMEOUT'));
 await kernel.setModel(s.sessionId,'model-f'); await new Promise(setImmediate); actor='two'; controls[4].reject(reject); await new Promise(setImmediate);
 assert.equal(kernel.getSession(s.sessionId).model,'model-f');
 turn.resolve({text:'ok',stopReason:'end_turn'}); await running; kernel.dispose();
});
