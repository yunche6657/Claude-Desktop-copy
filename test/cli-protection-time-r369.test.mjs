import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createProtectionClock}=require('../desktop/cli-protection-clock.cjs');
const {createProtectionState,isQueryMessage,isWorkFrame}=require('../desktop/cli-protection-state.cjs');
const {MAX_AGE_MS,MANAGER_GRACE_MS}=require('../desktop/cli-cron-protection.cjs');
const use=(id,name,input={})=>({type:'assistant',message:{content:[{type:'tool_use',id,name,input}]}});
const result=(id,tool_use_result)=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:id}]},tool_use_result});
function setup(){let time=20_000_000_000;const state=createProtectionState({now:()=>time});state.beginEpoch('actor');return {state,get time(){return time},set time(t){time=t},arm(){state.observeFrame('actor',use('w','ScheduleWakeup',{delaySeconds:60}));state.observeFrame('actor',result('w',{clampedDelaySeconds:60}));},snapshot(){return state.snapshot('actor')}};}

test('constant is three days; confirmed cron expires only beyond lifetime and deletion is immediate',()=>{
 assert.equal(MAX_AGE_MS,3*24*60*60*1000);assert.equal(MANAGER_GRACE_MS,16*60*1000);
 const f=setup(),start=f.time;
 f.state.observeFrame('actor',use('c','CronCreate',{cron:'* * * * *',durable:true}));
 assert.equal(f.snapshot().flags.cron,false);
 f.state.observeFrame('actor',result('c',{id:'job',recurring:true}));
 f.time=start+MAX_AGE_MS;assert.equal(f.snapshot().flags.cron,true);
 f.time++;assert.equal(f.snapshot().flags.cron,false);assert.equal(f.snapshot().cronCount,0);
 f.state.observeFrame('actor',use('c2','CronCreate'));f.state.observeFrame('actor',result('c2',{id:'job2',recurring:false}));
 assert.equal(f.snapshot().flags.cron,true);f.state.observeFrame('actor',use('d','CronDelete',{id:'job2'}));assert.equal(f.snapshot().flags.cron,false);
});

test('transport controls and heartbeat cannot extend loop grace; SDK messages can',()=>{
 const f=setup();f.arm();const at=f.snapshot().loop.scheduledFor;
 f.time=at+MANAGER_GRACE_MS;
 for(const type of ['control_response','control_request','control_cancel_request','keep_alive','transcript_mirror']){
  const frame={type};assert.equal(isQueryMessage(frame),false);f.state.observeFrame('actor',frame);
 }
 f.state.observeFrame('actor',{type:'system',subtype:'session_state_changed',sdk_host_only:true});
 assert.equal(f.snapshot().flags.loopWakeup,false);
 f.state.observeFrame('actor',{type:'system',subtype:'status',status:'idle'});
 assert.equal(f.snapshot().flags.loopWakeup,true);
 assert.equal(f.snapshot().activity.lastCliMessageAt,f.time);
 assert.equal(isWorkFrame({type:'system',subtype:'status'}),false);
 assert.equal(isWorkFrame({type:'system',subtype:'task_started',ambient:true}),false);
 assert.equal(isWorkFrame({type:'system',subtype:'task_started'}),true);
 f.time=at+7200000;f.state.noteActivity('actor');assert.equal(f.snapshot().flags.loopWakeup,false);
});

test('shared wall clock relays paired sleep, inherited suspend, unmatched resume and late ticks',()=>{
 let now=20_000_000_000;const clock=createProtectionClock({now:()=>now});const monitor=new EventEmitter();
 const f=setup();f.arm();const original=f.snapshot().loop.scheduledFor;
 const unsubscribe=clock.onEvent(event=>f.state.powerEvent('actor',event));clock.start(monitor);
 monitor.emit('suspend');const first=now;now+=1000;f.time=now;monitor.emit('suspend');
 assert.equal(clock.snapshot().firstUnpairedSuspendAt,first);
 f.time=now+7200000;assert.equal(f.snapshot().flags.loopWakeup,true);
 now=first+50000;f.time=now;monitor.emit('resume');
 assert.equal(f.snapshot().loop.scheduledFor,original+50000);assert.equal(f.snapshot().power.lastSystemWakeAt,now);
 now+=50000;f.time=now;monitor.emit('resume');
 assert.equal(f.snapshot().loop.scheduledFor,now+(original+50000-first));
 const before=f.snapshot().loop.scheduledFor;
 now+=200000;f.time=now;clock.sample();assert.equal(f.snapshot().power.lastClockGapEndedAt,now);assert.equal(f.snapshot().loop.scheduledFor,before);
 monitor.emit('suspend');const newState=createProtectionState({now:()=>now});newState.beginEpoch('new');newState.syncPower('new',clock.snapshot());
 assert.equal(newState.snapshot('new').activity.lastSuspendedAt,now);
 unsubscribe();clock.stop();assert.equal(monitor.listenerCount('resume'),0);assert.equal(monitor.listenerCount('suspend'),0);
});

test('late tick uses strict 90-second drift beyond the nominal minute',()=>{
 let now=1000000;const clock=createProtectionClock({now:()=>now});
 assert.equal(clock.sample(now+150000),null);now+=150000;
 const event=clock.sample(now+150001);assert.equal(event.kind,'clock-gap');assert.equal(event.context.lastSystemWakeAt,now+150001);
});


test('native wakeup fallback accepts captured input delay without structured result envelope',()=>{
 const f=setup();f.state.observeFrame('actor',use('w','ScheduleWakeup',{delaySeconds:80}));
 f.state.observeFrame('actor',result('w',undefined));assert.equal(f.snapshot().loop.scheduledFor,f.time+80000);
});
