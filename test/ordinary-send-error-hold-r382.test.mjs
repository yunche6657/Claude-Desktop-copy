import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setImmediate as tick} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');
const {shouldHoldAfterResult}=require('../desktop/queue-result-health.cjs');
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',C='cccccccc-cccc-4ccc-8ccc-cccccccccccc';

async function scenario(t,{killSwitch=false, warmGate, modelGate, raw=true}={}) {
  const requests=[],events=[],listeners=new Set(),firstEntered=Promise.withResolvers(),finishFirst=Promise.withResolvers();
  const backend={id:'ccb',start(){},cancel(){},dispose(){},
    onEvent(fn){listeners.add(fn);return ()=>listeners.delete(fn)},
    async setModel(){await modelGate?.promise},
    async warm(){await warmGate?.promise},
    async sendMessage(sessionId,text){
      const first=requests.length===0;
      requests.push(text);
      if(first){firstEntered.resolve();await finishFirst.promise;}
      if(raw)for(const fn of listeners)fn({type:'raw',sessionId,frame:{uuid:crypto.randomUUID(),type:'result',subtype:'success',is_error:first,result:first?'fixture failure':'ok'}});
      return {text:first?'fixture failure':'ok',stopReason:first?'error':'end_turn'};
    }};
  const kernel=createSessionKernel({backend,emit:e=>events.push(e),
    readFeatureValue:(key,fallback)=>key==='4122449738' ? !killSwitch : fallback,
    readFeatureOn:(key,fallback)=>{
    assert.equal(key,'4122449738');assert.equal(fallback,false);return killSwitch;
  }});
  const handlers=new Map();let press=false;
  const sender={};
  const bridge=registerBridgeServices({ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},
    bridgeMap:require('../desktop/shim/bridge-map.json'), getMainWindow:()=>null,
    settings:{kernelFactory:()=>kernel},frontend:{root:process.cwd()},
    consumePreviewUserGesture(contents){assert.equal(contents,sender);const result=press;press=false;return result}});
  t.after(()=>{finishFirst.resolve();warmGate?.resolve();modelGate?.resolve();bridge.dispose();kernel.dispose()});
  const {sessionId}=kernel.start({});
  const call=(method,...args)=>handlers.get(messageChannel('claude.web','LocalSessions',method))({sender},sessionId,...args);
  const send=(text,uuid,meta)=>call('sendMessage',text,null,null,null,'later',null,uuid,null,null,null,null,null,null,meta);
  const first=send('active');
  await firstEntered.promise;
  await send('second',B);await send('third',C);
  finishFirst.resolve();await first;await tick();
  return {kernel,sessionId,requests,events,send,call,markPress:()=>{press=true}};
}

test('unhealthy CCB result retains person sends, publishes held UUIDs, and permits reorder, withdraw and promotion',async t=>{
  const {kernel,sessionId,requests,events,call}=await scenario(t);
  assert.deepEqual(requests,['active']);
  assert.deepEqual(kernel.getSession(sessionId).sendsHeldAfterError,[B,C]);
  const result=events.find(e=>e.type==='message'&&e.message.type==='result');
  assert.equal(result.message.is_error,true);
  assert.deepEqual(result.message.heldQueuedSendUuids,[B,C]);assert.deepEqual(result.message.sendsHeldAfterError,[B,C]);
  assert.equal(await call('reorderQueuedMessage',C,B),true);
  assert.deepEqual(kernel.getSession(sessionId).sendsHeldAfterError,[C,B]);
  assert.equal(await call('cancelQueuedMessage',B),true);assert.equal(await call('cancelQueuedMessage',B),false);
  assert.equal(await call('promoteQueuedMessage',C),true);await tick();
  assert.deepEqual(requests,['active','third']);
  assert.equal(kernel.getSession(sessionId).sendsHeldAfterError,undefined);
});
test('only a marked non-command person send with a host-observed press rejoins held input',async t=>{
  const {kernel,sessionId,requests,send,markPress}=await scenario(t);
  await send('unmarked');await send('mark alone',undefined,{personSent:true});
  markPress();await send('\u200b/status',undefined,{personSent:true});
  await send('automatic',undefined,{personSent:true,modelAuthored:true});
  assert.deepEqual(kernel.getSession(sessionId).sendsHeldAfterError,[B,C]);
  await send('new turn',undefined,{personSent:true});await tick();
  assert.deepEqual(requests,['active','unmarked','mark alone','\u200b/status','automatic','new turn','second\n\nthird']);
});
test('kill switch keeps the regular drain behavior',async t=>{
  const {kernel,sessionId,requests}=await scenario(t,{killSwitch:true});
  assert.deepEqual(requests,['active','second\n\nthird']);assert.equal(kernel.getSession(sessionId).sendsHeldAfterError,undefined);
});
test('held promotion rechecks the session after a pending warm and a withdrawal wins',async t=>{
  const warmGate=Promise.withResolvers(),{call,requests}=await scenario(t,{warmGate});
  const promotion=call('promoteQueuedMessage',B);await tick();
  assert.equal(await call('cancelQueuedMessage',B),true);
  warmGate.resolve();assert.equal(await promotion,false);assert.deepEqual(requests,['active']);
});
test('explicitly promoting the second held UUID sends it first and rejoins the rest exactly once',async t=>{
  const {kernel,sessionId,call,requests}=await scenario(t);
  assert.equal(await call('promoteQueuedMessage',C),true);await tick();
  assert.deepEqual(requests,['active','third','second']);
  assert.deepEqual(kernel.getQueuedMessages(sessionId),[]);
  assert.equal(await call('promoteQueuedMessage',C),false);
});
test('a marked queued send accepted without a running turn does not later release held input',async t=>{
  const modelGate=Promise.withResolvers(),{kernel,sessionId,call,send,markPress,requests}=await scenario(t,{modelGate});
  const change=kernel.setModel(sessionId,'changed'),promotion=call('promoteQueuedMessage',B);
  await tick();markPress();await send('person followup',undefined,{personSent:true});
  assert.equal(await call('cancelQueuedMessage',B),true);modelGate.resolve();await change;
  assert.equal(await promotion,false);await tick();
  assert.deepEqual(requests,['active','person followup']);
  assert.deepEqual(kernel.getSession(sessionId).sendsHeldAfterError,[C]);
});
test('held promotion waiting for model selection has one cancellable UUID',async t=>{
  const modelGate=Promise.withResolvers(),{kernel,sessionId,call,requests}=await scenario(t,{modelGate,raw:false});
  const change=kernel.setModel(sessionId,'changed');const promotion=call('promoteQueuedMessage',B);await tick();
  assert.deepEqual(kernel.getQueuedMessages(sessionId),[{uuid:B},{uuid:C}]);
  assert.equal(await call('cancelQueuedMessage',B),true);assert.equal(await call('cancelQueuedMessage',B),false);
  modelGate.resolve();await change;assert.equal(await promotion,false);assert.deepEqual(requests,['active']);
});
test('top-level errors exclude explicit interrupts and diagnostic-plus-known-tool errors',()=>{
  const frame={subtype:'error_during_execution',is_error:true};
  assert.equal(shouldHoldAfterResult({...frame,terminal_reason:'aborted_tools'},'error'),false);
  assert.equal(shouldHoldAfterResult(frame,'cancelled'),false);
  assert.equal(shouldHoldAfterResult({...frame,errors:['[ede_diagnostic] fixture','File does not exist.']},'error'),false);
  assert.equal(shouldHoldAfterResult({...frame,errors:['File does not exist.']},'error'),true);
  assert.equal(shouldHoldAfterResult({...frame,errors:['[ede_diagnostic] fixture','unknown failure']},'error'),true);
  assert.equal(shouldHoldAfterResult({subtype:'success',is_error:true},'end_turn'),true);
});
