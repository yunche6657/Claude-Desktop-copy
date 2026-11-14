import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createSessionKernel}=createRequire(import.meta.url)('../desktop/session-kernel.cjs');
test('Code init completion and upstream retries reach the shipped status contract',async()=>{
 const listeners=new Set(),events=[];
 const backend={id:'ccb',cancel(){},getTranscript(){return[]},onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn)},start(){},async sendMessage(sessionId){for(const e of [{type:'init',info:{}},{type:'upstream_retry',errorStatus:503,retryDelayMs:2000}])for(const fn of listeners)fn({...e,sessionId});return{text:'ok',stopReason:'end_turn'}},dispose(){}};
 const k=createSessionKernel({backend,emit:e=>events.push(e)});
 try{const s=await k.start({cwd:process.cwd()});await k.sendMessage(s.sessionId,'hi');const statuses=events.filter(e=>e.type==='initialization_status');assert.equal(statuses[0].initializationStatus.isComplete,true);assert.equal(statuses[1].initializationStatus.step,'connect_retry');assert.match(statuses[1].initializationStatus.message,/503/);}finally{await k.dispose?.()}
});
