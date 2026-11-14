import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
test('escalating an unknown UUID from an idle session returns false without a new prompt',async t=>{
  const requests=[],handlers=new Map();
  const backend={id:'fixture',start(){},onEvent(){return ()=>{}},cancel(){},dispose(){},
    async sendMessage(_id,text){requests.push(text);return {text:'unexpected response',stopReason:'end_turn'}}};
  const kernel=createSessionKernel({backend,emit(){}});
  const bridge=registerBridgeServices({ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},
    bridgeMap:require('../desktop/shim/bridge-map.json'),settings:{kernelFactory:()=>kernel},frontend:{root:process.cwd()},getMainWindow:()=>null});
  t.after(()=>{bridge.dispose();kernel.dispose()});
  const {sessionId}=kernel.start({});
  const control=handlers.get(messageChannel('claude.web','LocalSessions','sendSteeredNow'));
  const result=await control({},sessionId,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.deepEqual({result,requests,rows:kernel.getTranscript(sessionId).length},{result:false,requests:[],rows:0});
});
test('steer control preserves the owning method verdict and passes only the native two arguments',async t=>{
  const handlers=new Map(),calls=[],owner={sendSteeredNow:async(...args)=>{calls.push(args);return args[1]==='owned'}};
  const bridge=registerBridgeServices({ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},
    bridgeMap:require('../desktop/shim/bridge-map.json'),settings:{kernelFactory:()=>owner},getMainWindow:()=>null,frontend:{root:process.cwd()}});
  t.after(()=>bridge.dispose());
  const control=handlers.get(messageChannel('claude.web','LocalSessions','sendSteeredNow'));
  assert.equal(await control({},'session','owned',{autoReason:'untrusted'}),true);
  assert.equal(await control({},'session','gone'),false);
  assert.deepEqual(calls,[['session','owned'],['session','gone']]);
});
