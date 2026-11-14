import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createProtectionState} = require('../desktop/cli-protection-state.cjs');
const sys = (subtype, extra={}) => ({type:'system',subtype,...extra});
const use = (id,name,input={}) => ({type:'assistant',message:{content:[{type:'tool_use',id,name,input}]}});
const result = (id,tool_use_result,is_error=false) => ({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,is_error}]},tool_use_result});

test('epoch identity isolates stale frames and exposes native defaults separately from coverage', () => {
 const s=createProtectionState(); s.beginEpoch(1);
 assert.deepEqual(s.snapshot(1).flags,{agentRun:false,stopping:false,cron:false,backgroundTasks:false,loopWakeup:false,remoteControl:false,lanyard:false,otherProtection:false,otherProtection2:false});
 assert.equal(s.snapshot(1).coverage.backgroundSnapshot,false);
 s.observeFrame(1,sys('background_tasks_changed',{tasks:[{task_id:'a',task_type:'local_bash'}]}));
 s.beginEpoch(2); assert.equal(s.observeFrame(1,sys('background_tasks_changed',{tasks:[]})),false);
 assert.equal(s.snapshot(1),null); assert.equal(s.snapshot(2).flags.backgroundTasks,false);
 assert.equal(s.reset(1),false); assert.equal(s.reset(2),true);
});
test('background full snapshots, exclusion, duplicate IDs, malformed input and native ID-only replacement', () => {
 const s=createProtectionState(); s.beginEpoch('x');
 s.observeFrame('x',sys('background_tasks_changed',{tasks:[{task_id:'ambient',ambient:true},{task_id:'dream',task_type:'dream'},{task_id:'r',task_type:'remote_agent'}]}));
 assert.equal(s.snapshot('x').flags.backgroundTasks,false); assert.equal(s.snapshot('x').coverage.backgroundSnapshot,true);
 s.observeFrame('x',sys('background_tasks_changed',{tasks:[{task_id:'r',task_type:'local_bash'}]}));
 assert.equal(s.snapshot('x').flags.backgroundTasks,false);
 s.observeFrame('x',sys('background_tasks_changed',{tasks:[{task_id:'r',task_type:'remote_agent'},{task_id:'a'}]}));
 assert.equal(s.snapshot('x').flags.backgroundTasks,true);
 assert.equal(s.observeFrame('x',sys('background_tasks_changed',{tasks:null})),false); assert.equal(s.snapshot('x').flags.backgroundTasks,true);
 assert.equal(s.observeFrame('x',sys('background_tasks_changed',{tasks:[{}, {task_id:'b'}]})),true); assert.equal(s.snapshot('x').flags.backgroundTasks,true); assert.equal(s.snapshot('x').coverage.backgroundMalformed,true);
 s.observeFrame('x',sys('background_tasks_changed',{tasks:[{}]})); assert.equal(s.snapshot('x').flags.backgroundTasks,false);
 s.observeFrame('x',sys('background_tasks_changed',{tasks:[]})); assert.equal(s.snapshot('x').flags.backgroundTasks,false);
});
test('observed tasks are separate; tool result and turn result do not retire a background task', () => {
 const s=createProtectionState();s.beginEpoch(1);s.observeFrame(1,sys('task_started',{task_id:'a',task_type:'local_agent',prompt:'secret'}));
 s.observeFrame(1,result('tool',{})); s.observeFrame(1,{type:'result'}); assert.equal(s.snapshot(1).observedTasks,1);
 s.observeFrame(1,sys('task_notification',{task_id:'',status:'completed'})); assert.equal(s.snapshot(1).observedTasks,1);
 s.observeFrame(1,sys('task_notification',{task_id:'a',status:'completed'}));assert.equal(s.snapshot(1).observedTasks,0);
});
test('cron and wakeup require correlated successful tool result', () => {
 const s=createProtectionState({now:()=>100000}); s.beginEpoch(1);
 s.observeFrame(1,use('c','CronCreate'));s.observeFrame(1,result('c',{id:'job'},true));assert.equal(s.snapshot(1).flags.cron,false);
 s.observeFrame(1,use('c2','CronCreate'));s.observeFrame(1,result('c2',{id:'job'}));assert.equal(s.snapshot(1).flags.cron,true);
 s.observeFrame(1,use('d','CronDelete',{id:'job'}));assert.equal(s.snapshot(1).flags.cron,false);
 s.observeFrame(1,use('w','ScheduleWakeup',{delaySeconds:10}));s.observeFrame(1,result('w',{clampedDelaySeconds:120,scheduledFor:900000}));assert.equal(s.snapshot(1).loop.scheduledFor,220000);
});
test('explicit run boundaries, remote and lanyard signals retain independent coverage', () => {
 const s=createProtectionState();s.beginEpoch(1);s.update(1,{pendingCycle:true,query:true,remote:true,lanyard:true});s.observeFrame(1,{type:'result'});
 assert.equal(s.snapshot(1).flags.agentRun,true);assert.equal(s.snapshot(1).flags.remoteControl,true);assert.equal(s.snapshot(1).flags.lanyard,true);
 s.update(1,{boundaryHint:true,boundaryComplete:true,pendingCycle:false,remote:false,lanyard:false,coverage:{remote:true}});
 assert.equal(s.snapshot(1).flags.agentRun,false); assert.equal(s.snapshot(1).coverage.remote,true);assert.equal(s.snapshot(1).coverage.lanyard,false);
});

test('wakeup time source precedence and edge cases', () => {
 const s=createProtectionState({now:()=>100000});s.beginEpoch(1);
 s.observeFrame(1,use('a','ScheduleWakeup',{delaySeconds:80})); s.observeFrame(1,result('a',{clampedDelaySeconds:120,scheduledFor:999999})); assert.equal(s.snapshot(1).loop.scheduledFor,220000);
 s.observeFrame(1,use('b','ScheduleWakeup',{delaySeconds:90})); s.observeFrame(1,result('b',{scheduledFor:999999})); assert.equal(s.snapshot(1).loop.scheduledFor,190000);
 s.observeFrame(1,use('c','ScheduleWakeup')); s.observeFrame(1,result('c',{scheduledFor:999999})); assert.equal(s.snapshot(1).loop.scheduledFor,999999);
 s.observeFrame(1,use('d','ScheduleWakeup')); s.observeFrame(1,result('d',{scheduledFor:0,clampedDelaySeconds:120})); assert.equal(s.snapshot(1).loop.scheduledFor,999999);
 s.observeFrame(1,use('e','ScheduleWakeup')); s.observeFrame(1,result('e',{scheduledFor:10000000})); assert.equal(s.snapshot(1).loop.scheduledFor,7300000);
});
