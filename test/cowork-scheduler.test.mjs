import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require=createRequire(import.meta.url);
const {createCoworkScheduler}=require('../desktop/cowork-scheduler.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');

function fixture(t,{run, store={tasks:[]}}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-clock-'));let time=new Date(2026,5,1,9,0).getTime(), callback;
 const clock={setInterval(fn){callback=fn;return {unref(){}}},clearInterval(){callback=null}};
 const turns=[],events=[];const kernel=createSessionKernel({emit(){},createAgent:()=>({async run(input){turns.push(input);return run?await run(input):{text:'actual scheduled reply',stopReason:'end_turn'};}})});
 const power=new EventEmitter();
 const scheduler=createCoworkScheduler({getStore:()=>store,saveStore:()=>{fs.writeFileSync(path.join(dir,'store.json'),JSON.stringify(store));},root:()=>dir,kernel,now:()=>time,clock,powerMonitor:power,defaultCwd:()=>path.join(dir,'created','workspace'),getInstructions:()=> 'Account instructions fixture',emit:event=>events.push(event),postWakeDelayMs:1000});
 scheduler.start();t.after(async()=>{await scheduler.stop();kernel.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 return {scheduler,kernel,turns,events,power,dir,store,clock,set time(value){time=value},get time(){return time},async flush(){await new Promise(resolve=>setImmediate(resolve));await scheduler.tick();},fire(){callback?.();}};
}

test('clock fires real kernel turn with native cwd, instructions and completed history; restart does not replay',async t=>{
 const f=fixture(t);const task=f.scheduler.createScheduledTask({name:'real-turn',description:'fixture',prompt:'Execute fixture prompt',fireAt:f.time+1000});
 assert.equal(f.turns.length,0);f.time+=1000;f.fire();await f.flush();
 assert.equal(f.turns.length,1);const sessions=f.kernel.getAll();assert.equal(sessions.length,1);assert.equal(sessions[0].scheduledTaskId,task.id);assert.equal(sessions[0].hostLoopMode,true);
 assert.ok(fs.statSync(sessions[0].cwd).isDirectory());const transcript=f.kernel.getTranscript(sessions[0].sessionId);assert.ok(JSON.stringify(transcript).includes('Execute fixture prompt'));assert.ok(JSON.stringify(transcript).includes('Account instructions fixture'));assert.ok(JSON.stringify(transcript).includes(os.platform()));assert.ok(JSON.stringify(transcript).includes('actual scheduled reply'));
 assert.equal(f.scheduler.getWatcherHistory(task.id)[0].status,'completed');assert.equal('nextRunAt' in f.scheduler.getAllScheduledTasks()[0],false);await f.scheduler.tick();assert.equal(f.turns.length,1);
 const reload=createCoworkScheduler({getStore:()=>JSON.parse(fs.readFileSync(path.join(f.dir,'store.json'),'utf8')),saveStore(){},root:()=>f.dir,kernel:f.kernel,now:()=>f.time});await reload.tick();assert.equal(f.turns.length,1);await reload.stop();
});

test('pause, enable, single-object edit and delete control dispatch',async t=>{
 const f=fixture(t);const task=f.scheduler.createScheduledTask({name:'control',prompt:'original',cronExpression:'* * * * *'});
 f.scheduler.updateScheduledTaskStatus(task.id,'disabled');f.time+=60000;await f.scheduler.tick();assert.equal(f.turns.length,0);
 f.scheduler.updateScheduledTask({scheduledTaskId:task.id,prompt:'edited',fireAt:f.time+1000,enabled:true});f.time+=1000;await f.scheduler.tick();await f.flush();assert.equal(f.turns.length,1);assert.ok(JSON.stringify(f.kernel.getTranscript(f.kernel.getAll()[0].sessionId)).includes('edited'));
 const removed=f.scheduler.createScheduledTask({name:'removed',prompt:'never',fireAt:f.time+1000});f.scheduler.updateScheduledTaskStatus(removed.id,'deleted',true);f.time+=1000;await f.scheduler.tick();assert.equal(f.turns.length,1);assert.equal(f.scheduler.getAllScheduledTasks().length,1);
});

test('suspend/resume coalesces missed runs, skip policy records skip and overlap never starts twice',async t=>{
 let finish;const f=fixture(t,{run:()=>new Promise(resolve=>{finish=resolve;})});
 const task=f.scheduler.createScheduledTask({name:'missed',prompt:'work',cronExpression:'* * * * *'});
 const skipped=f.scheduler.createScheduledTask({name:'skip',prompt:'never',cronExpression:'* * * * *',missedRunPolicy:'skip'});
 f.power.emit('suspend');f.time+=3600000;await f.scheduler.tick();assert.equal(f.turns.length,0);f.power.emit('resume');await f.scheduler.tick();assert.equal(f.turns.length,0);
 f.time+=1000;await Promise.all([f.scheduler.tick(),f.scheduler.tick()]);assert.equal(f.turns.length,1);assert.equal(f.scheduler.getWatcherHistory(task.id)[0].missed,true);assert.equal(f.scheduler.getWatcherHistory(skipped.id)[0].status,'skipped');f.scheduler.updateScheduledTaskStatus(skipped.id,'disabled');
 f.time+=60000;await f.scheduler.tick();assert.equal(f.turns.length,1);finish({text:'done',stopReason:'end_turn'});await new Promise(resolve=>setImmediate(resolve));await f.scheduler.stop();f.time+=60000;await f.scheduler.tick();assert.equal(f.turns.length,1);assert.equal(f.power.listenerCount('resume'),0);
});

test('kernel failures surface in history and task state without re-dispatching same slot',async t=>{
 const f=fixture(t,{run:async()=>{throw new Error('fixture provider failed');}});const task=f.scheduler.createScheduledTask({name:'failure',prompt:'fail',fireAt:f.time+1000});f.time+=1000;await f.scheduler.tick();await f.flush();
 const history=f.scheduler.getWatcherHistory(task.id);assert.equal(history[0].status,'failed');assert.match(history[0].error,/fixture provider failed/);assert.match(f.scheduler.getAllScheduledTasks()[0].lastError,/fixture provider failed/);await f.scheduler.tick();assert.equal(f.turns.length,1);
});

test('bridge frontend shape dispatches on host timer and dispose detaches timer',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-bridge-clock-'));let time=Date.now(),callback,cleared=false,kernel;const handlers=new Map();
 const bridge=registerBridgeServices({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler(){}},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>null,frontend:{root:dir},settings:{dataDir:dir,coworkWorkspaceRoot:dir,coworkScheduler:{now:()=>time,clock:{setInterval(fn){callback=fn;return {unref(){}}},clearInterval(){cleared=true;}}},kernelFactory:({emit})=>(kernel=createSessionKernel({emit,createAgent:()=>({async run(){return{text:'bridge timer reply',stopReason:'end_turn'};}})}))}});
 t.after(async()=>{await bridge.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 const call=(method,...args)=>handlers.get(messageChannel('claude.web','CoworkScheduledTasks',method))({},...args);
 const task=await call('createScheduledTask',{name:'bridge schedule',description:'test',prompt:'bridge execution',fireAt:time+1000,cwd:dir});
 await call('updateScheduledTask',{scheduledTaskId:task.id,prompt:'updated bridge execution'});assert.equal(await call('markListenerReady'),true);time+=1000;callback();await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(kernel.getAll().length,1);assert.ok(JSON.stringify(kernel.getTranscript(kernel.getAll()[0].sessionId)).includes('bridge timer reply'));await bridge.dispose();assert.equal(cleared,true);
});
