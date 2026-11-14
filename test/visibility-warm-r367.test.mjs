import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fixture() {
  const calls = [], live = new Set(), handlers = new Map();
  const backend = { id:'ccb', start(){}, onEvent(){return () => {}}, cancel(){}, dispose(){},
    sendMessage:async()=>({text:'ok'}), getActiveProcesses:()=>[...live].map(sessionId=>({sessionId})),
    async warm(id) { calls.push({id, at:performance.now()}); live.add(id); } };
  const kernel = createSessionKernel({backend, emit(){}});
  const bridge = registerBridgeServices({ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler(){}},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>({isDestroyed:()=>false,webContents:{send(){}}}),settings:{kernelFactory:()=>kernel},frontend:{root:process.cwd()}});
  const set = (sender,id,visible,reason='route') => handlers.get([...handlers.keys()].find(k=>k.endsWith('_$_LocalSessions_$_setVisibility')))({sender},id,visible,reason);
  return {kernel, bridge, calls, live, set, make:()=>kernel.start({cwd:process.cwd()}).sessionId};
}
test('visibility warms a hidden session and staggers further sessions with rechecks', async t => {
 const f=fixture(); t.after(()=>{f.kernel.dispose();f.bridge.dispose()});
 const a=f.make(), b=f.make(), c=f.make(), sender=new EventEmitter();
 f.set(sender,a,true); assert.equal(f.calls.length,0);
 for(const id of [a,b,c]) f.set(sender,id,false);
 for(const id of [a,b,c]) f.set(sender,id,true);
 assert.deepEqual(f.calls.map(x=>x.id),[a]);
 assert.equal(f.kernel.getWarmLifecycleState(b).warmScheduled,true);
 f.set(sender,b,false); f.live.add(c);
 assert.equal(f.kernel.getWarmLifecycleState(b).warmScheduled,false, 'hidden sessions cancel their queued warm immediately');
 await sleep(2100);
 assert.deepEqual(f.calls.map(x=>x.id),[a]);
 assert.equal(f.kernel.getWarmLifecycleState(b).warmScheduled,false);
 assert.equal(f.kernel.getWarmLifecycleState(c).hasActiveQuery,true);
});
test('renderer navigation and destruction preserve visibility of other renderers',async t=>{
 const f=fixture(); t.after(()=>{f.kernel.dispose();f.bridge.dispose()});
 const id=f.make(), a=new EventEmitter(), b=new EventEmitter();
 f.set(a,id,false); f.set(a,id,true); f.set(b,id,true);
 a.emit('did-start-navigation',{},'url',false,true);
 assert.equal(f.kernel.getWarmLifecycleState(id).isVisible,true);
 b.emit('destroyed'); const state=f.kernel.getWarmLifecycleState(id);
 assert.equal(state.isVisible,false); assert.equal(typeof state.lastHiddenTime,'number');
});
test('missing process inventory cannot establish absence of a query', async t=>{
 let warmed=0; const backend={id:'ccb',start(){},onEvent(){return ()=>{}},cancel(){},dispose(){},sendMessage:async()=>({text:'ok'}),warm:async()=>{warmed++}};
 const kernel=createSessionKernel({backend,emit(){}});t.after(()=>kernel.dispose());const {sessionId}=kernel.start({});
 kernel.setVisibility(sessionId,false);kernel.setVisibility(sessionId,true);
 assert.equal(warmed,0);assert.equal(kernel.getWarmLifecycleState(sessionId).hasActiveQuery,null);
});
test('two eligible visible sessions actually start at least one second apart',async t=>{
 const f=fixture();t.after(()=>{f.kernel.dispose();f.bridge.dispose()});
 const a=f.make(), b=f.make(), sender=new EventEmitter();
 f.set(sender,a,false);f.set(sender,b,false);f.set(sender,a,true);f.set(sender,b,true);
 await sleep(1100);assert.deepEqual(f.calls.map(x=>x.id),[a,b]);
 assert.ok(f.calls[1].at-f.calls[0].at>=990);
});
