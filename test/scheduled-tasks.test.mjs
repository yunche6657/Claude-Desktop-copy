import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createScheduledTasks,parseCron,nextCron,parseTaskFile}=require('../desktop/scheduled-tasks.cjs');

function fixture(t, options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scheduled-task-'));
  const events=[];let time=new Date(2026,9,27,10,0,1).getTime();
  const service=createScheduledTasks({root,now:()=>time,emit:e=>events.push(e),...options});
  t.after(async()=>{await service.stop();fs.rmSync(root,{recursive:true,force:true});});
  return {root,events,service,get time(){return time;},set time(t){time=t;},
    create:params=>service.createScheduledTask({name:'daily-report',description:'实际描述',prompt:'Run a real report',cwd:root,...params})};
}

test('task files, metadata and prompt edits survive restart with original return fields',async t=>{
  const f=fixture(t);const task=await f.create({cronExpression:'15 9 * * 1-5',displayName:'Daily report',model:'fixture-model'});
  assert.equal(task.id,'daily-report');assert.equal(typeof task.createdAt,'number');assert.equal(task.enabled,true);
  assert.equal(task.prompt,'Run a real report');assert.equal(task.description,'实际描述');
  const file=await f.service.getScheduledTaskFileContent(task.id);
  assert.deepEqual(parseTaskFile(file),{name:'daily-report',description:'实际描述',prompt:'Run a real report'});
  const updated=await f.service.updateScheduledTask({scheduledTaskId:task.id,prompt:'A changed prompt',description:'two\nlines',displayName:'Renamed'});
  assert.equal(updated.prompt,'A changed prompt');assert.equal(updated.description,'two lines');
  const loaded=createScheduledTasks({root:f.root,now:()=>f.time});t.after(()=>loaded.stop());
  assert.deepEqual(await loaded.getAllScheduledTasks(),await f.service.getAllScheduledTasks());
  const disk=JSON.parse(fs.readFileSync(path.join(f.root,'scheduled-tasks.json'),'utf8'));
  assert.equal(disk.scheduledTasks[0].filePath,path.join(f.root,'scheduled-tasks','daily-report','SKILL.md'));
  assert.deepEqual(f.events.map(e=>e.type),['scheduled_task_created','scheduled_task_updated']);
});

test('one-time due dispatch is gated by renderer readiness and confirmed start, not ack',async t=>{
  const f=fixture(t);const task=await f.create({fireAt:f.time+1000});f.time+=1001;
  assert.equal(await f.service.tick(),0);assert.equal(f.service.setEventAckSupported(),true);f.service.markListenerReady();
  assert.equal(await f.service.tick(),1);
  const dispatch=f.events.find(e=>e.type==='session_started');
  assert.equal(dispatch.scheduledTask.id,task.id);assert.equal(dispatch.ccdSessionStart.cwd,f.root);
  assert.equal(dispatch.ccdSessionStart.sessionId,dispatch.sessionId);assert.match(dispatch.sessionId,/^local_/);
  assert.equal(f.service.ackEvent(dispatch.ackId),true);
  let stored=(await f.service.getAllScheduledTasks())[0];assert.equal(stored.enabled,true);assert.equal(stored.lastRunAt,undefined);
  assert.equal(await f.service.tick(),0);
  assert.equal(await f.service.confirmTaskRun(task.id,'different-session'),false);
  assert.equal(await f.service.confirmTaskRun(task.id,dispatch.sessionId),true);
  stored=(await f.service.getAllScheduledTasks())[0];assert.equal(stored.enabled,false);assert.equal(stored.lastScheduledFor,new Date(task.fireAt).toISOString());
  assert.equal(stored.lastRunAt,new Date(f.time).toISOString());assert.equal(await f.service.tick(),0);
});

test('unconfirmed dispatch survives restart and reuses the same session identity',async t=>{
  const f=fixture(t);await f.create({fireAt:f.time+1000});f.time+=1001;f.service.setEventAckSupported();f.service.markListenerReady();await f.service.tick();
  const original=f.events.find(e=>e.type==='session_started');await f.service.stop();
  const replay=[];const loaded=createScheduledTasks({root:f.root,now:()=>f.time,emit:e=>replay.push(e)});t.after(()=>loaded.stop());
  loaded.setEventAckSupported();loaded.markListenerReady();assert.equal(await loaded.tick(),1);
  assert.equal(replay[0].sessionId,original.sessionId);assert.equal(replay[0].ackId,original.ackId);
  assert.equal(await loaded.confirmTaskRun(original.scheduledTask.id,original.sessionId),true);
  const again=createScheduledTasks({root:f.root,now:()=>f.time,emit:e=>assert.fail('consumed task dispatched')});t.after(()=>again.stop());
  again.markListenerReady();assert.equal(await again.tick(),0);
});

test('failed emit or released claim leaves a due slot eligible without recording success',async t=>{
  const f=fixture(t,{emit:()=>false});const task=await f.create({fireAt:f.time+1});f.time+=2;f.service.markListenerReady();
  assert.equal(await f.service.tick(),0);assert.equal((await f.service.getAllScheduledTasks())[0].lastRunAt,undefined);
  assert.equal(f.service.diagnostics().pending.length,1);assert.equal(f.service.releaseDispatchClaim(task.id),true);
  assert.equal(f.service.diagnostics().pending.length,0);assert.equal(f.service.releaseDispatchClaim(task.id),false);
  assert.equal(await f.service.tick(),0);assert.equal(f.service.diagnostics().pending.length,1);
});

test('cron ranges, lists, steps, Sunday alias and restricted day OR follow local calendar',()=>{
  const at=(d,h=9,m=0)=>new Date(2026,9,d,h,m);
  assert.equal(parseCron('*/15 9-10 * * 1,2')(at(27,9,30)),true);
  assert.equal(parseCron('*/15 9-10 * * 1,2')(at(27,9,31)),false);
  assert.equal(parseCron('0 9 1 * 2')(at(27)),true);
  assert.equal(parseCron('0 9 * * 7')(at(25)),true);
  assert.equal(parseCron('0 9 * * 0')(at(25)),true);
  assert.equal(nextCron('0 9 * * *',at(27).getTime()),at(28).getTime());
  for(const text of ['* * * *','0 25 * * *','*/0 * * * *','1,,2 * * * *','MON * * * *','0 0 0 * *'])assert.throws(()=>parseCron(text));
});

test('cron slot dispatch does not repeat after confirmation and advances next minute',async t=>{
  const f=fixture(t);const task=await f.create({cronExpression:'* * * * *'});f.time+=60000;f.service.markListenerReady();
  assert.equal(await f.service.tick(),1);let dispatch=f.events.find(e=>e.type==='session_started');await f.service.confirmTaskRun(task.id,dispatch.sessionId);
  assert.equal(await f.service.tick(),0);f.time+=60000;assert.equal(await f.service.tick(),1);
  const all=f.events.filter(e=>e.type==='session_started');assert.equal(all.length,2);assert.notEqual(all[0].sessionId,all[1].sessionId);
});

test('disable blocks dispatch and delete removes only owned task files on explicit request',async t=>{
  const f=fixture(t);const task=await f.create({fireAt:f.time+100});f.time+=101;f.service.markListenerReady();
  assert.equal(await f.service.updateScheduledTaskStatus(task.id,'disabled'),true);assert.equal(await f.service.tick(),0);
  assert.equal(await f.service.updateScheduledTaskStatus(task.id,'enabled'),true);assert.equal(await f.service.tick(),1);
  assert.equal(await f.service.updateScheduledTaskStatus(task.id,'deleted',true),true);
  assert.equal(fs.existsSync(task.filePath),false);assert.deepEqual(await f.service.getAllScheduledTasks(),[]);
  assert.equal(await f.service.getScheduledTaskFileContent(task.id),null);assert.equal(await f.service.updateScheduledTaskStatus(task.id,'deleted'),false);
});

test('delete without file removal preserves the skill and refuses silent overwrite',async t=>{
  const f=fixture(t);const task=await f.create();assert.equal(await f.service.updateScheduledTaskStatus(task.id,'deleted'),true);
  assert.equal(fs.existsSync(task.filePath),true);await assert.rejects(f.create(),/EEXIST/);
});

test('invalid, remote and watcher inputs fail before storing fake local tasks',async t=>{
  const f=fixture(t);
  await assert.rejects(f.create({cronExpression:'* * * * *',fireAt:f.time+1000}),/either/);
  await assert.rejects(f.create({fireAt:f.time-1}),/future/);
  await assert.rejects(f.create({place:{remoteTarget:{kind:'ssh'}}}),/not supported/);
  await assert.rejects(f.create({watcher:{description:'watch'}}),/not supported/);
  await assert.rejects(f.create({cwd:'relative'}),/absolute/);
  assert.deepEqual(await f.service.getAllScheduledTasks(),[]);assert.equal(fs.existsSync(path.join(f.root,'scheduled-tasks.json')),false);
});

test('task directories cannot be substituted by an external junction',async t=>{
  const f=fixture(t),external=fs.mkdtempSync(path.join(os.tmpdir(),'task-outside-'));t.after(()=>fs.rmSync(external,{recursive:true,force:true}));
  fs.symlinkSync(external,path.join(f.root,'scheduled-tasks'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.create(),/link/);assert.deepEqual(fs.readdirSync(external),[]);
});

test('read and delete reject a substituted task file and preserve outside bytes',async t=>{
  const f=fixture(t);const task=await f.create();const outside=path.join(f.root,'outside.txt');fs.writeFileSync(outside,'DO_NOT_TOUCH');
  fs.unlinkSync(task.filePath);fs.linkSync(outside,task.filePath);
  assert.equal(await f.service.getScheduledTaskFileContent(task.id),null);
  await assert.rejects(f.service.updateScheduledTaskStatus(task.id,'deleted',true),/link/);
  assert.equal(fs.readFileSync(outside,'utf8'),'DO_NOT_TOUCH');
});

test('corrupt store is not overwritten or presented as an empty successful inventory',async t=>{
  const f=fixture(t);await f.service.stop();fs.writeFileSync(path.join(f.root,'scheduled-tasks.json'),'{broken');
  assert.throws(()=>createScheduledTasks({root:f.root}),/JSON/);assert.equal(fs.readFileSync(path.join(f.root,'scheduled-tasks.json'),'utf8'),'{broken');
});

test('live timer dispatches due fixture once and stop releases its timer',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scheduled-live-'));let resolve;
  const dispatched=new Promise(r=>{resolve=r;});const events=[];
  const service=createScheduledTasks({root,pollIntervalMs:10,emit:e=>{events.push(e);if(e.type==='session_started')resolve(e);}});
  t.after(async()=>{await service.stop();fs.rmSync(root,{recursive:true,force:true});});
  await service.createScheduledTask({name:'timer',description:'timer fixture',prompt:'controlled timer',cwd:root,fireAt:Date.now()+35});
  service.markListenerReady();service.start();
  const timeout=setTimeout(()=>resolve(null),1500);const event=await dispatched;clearTimeout(timeout);
  assert.equal(event?.type,'session_started');assert.equal(service.diagnostics().running,true);
  await service.stop();assert.equal(service.diagnostics().running,false);assert.equal(events.filter(e=>e.type==='session_started').length,1);
});

test('missed cron slot catches up once with the original missedScheduledTime field',async t=>{
  const f=fixture(t);const task=await f.create({cronExpression:'5 10 * * *'});
  f.time=new Date(2026,9,27,10,8,1).getTime();f.service.markListenerReady();
  assert.equal(await f.service.tick(),1);const event=f.events.find(e=>e.type==='session_started');
  assert.equal(event.missedScheduledTime,new Date(2026,9,27,10,5).toISOString());
  await f.service.confirmTaskRun(task.id,event.sessionId);assert.equal(await f.service.tick(),0);
  assert.equal(typeof (await f.service.getAllScheduledTasks())[0].nextRunAt,'string');
});

test('persistence failure rolls back task state and restores staged file deletion',async t=>{
  const f=fixture(t);const task=await f.create({fireAt:f.time+1000});
  const store=path.join(f.root,'scheduled-tasks.json');fs.unlinkSync(store);fs.mkdirSync(store);
  await assert.rejects(f.service.updateScheduledTaskStatus(task.id,'deleted',true));
  assert.equal(fs.existsSync(task.filePath),true);assert.equal((await f.service.getAllScheduledTasks())[0].id,task.id);
  await assert.rejects(f.service.updateScheduledTask({scheduledTaskId:task.id,prompt:'must roll back'}));
  assert.equal((await f.service.getAllScheduledTasks())[0].prompt,'Run a real report');
  assert.deepEqual(fs.readdirSync(path.dirname(task.filePath)),['SKILL.md']);
});

test('invalid task frontmatter cannot be dispatched as a successful readable prompt',async t=>{
  const f=fixture(t);const task=await f.create({fireAt:f.time+1});fs.writeFileSync(task.filePath,'not a skill');
  f.time+=2;f.service.markListenerReady();assert.equal(await f.service.tick(),0);
  assert.equal((await f.service.getAllScheduledTasks())[0].fileReadError,'unreadable');
  assert.equal(f.events.filter(e=>e.type==='session_started').length,0);
});

test('native deterministic jitter is nonzero, interval-capped and explicitly disableable',()=>{
  const {jitterSeconds}=require('../desktop/scheduled-tasks.cjs');
  const now=new Date(2026,9,27,10,0).getTime();
  assert.equal(jitterSeconds({id:'stable-jitter',cronExpression:'0 * * * *'},now),51);
  assert.equal(jitterSeconds({id:'stable-jitter',cronExpression:'0 * * * *'},now+3600000),51);
  assert.equal(jitterSeconds({id:'every-five',cronExpression:'*/5 * * * *'},now),147);
  assert.equal(jitterSeconds({id:'stable-jitter',cronExpression:'* * * * *'},now),0);
  assert.equal(jitterSeconds({id:'stable-jitter',cronExpression:'0 * * * *',disableJitter:true},now),0);
  assert.equal(jitterSeconds({id:'stable-jitter',fireAt:now+5000},now),0);
});

test('jitter delays actual dispatch, survives restart and does not become a fake missed run',async t=>{
  const f=fixture(t);const task=await f.create({name:'stable-jitter',cronExpression:'0 * * * *'});
  assert.equal(task.disableJitter,undefined);assert.equal(task.jitterSeconds,51);
  assert.equal(task.nextRunAt,new Date(new Date(2026,9,27,11,0).getTime()+51000).toISOString());
  f.service.markListenerReady();assert.equal(await f.service.tick(),0);
  const pending=f.service.diagnostics().pending[0];assert.equal(pending.readyAt,f.time+51000);
  await f.service.stop();
  const replay=[];const loaded=createScheduledTasks({root:f.root,now:()=>f.time,emit:e=>replay.push(e)});t.after(()=>loaded.stop());loaded.markListenerReady();
  f.time+=50999;assert.equal(await loaded.tick(),0);f.time+=1;assert.equal(await loaded.tick(),1);
  assert.equal(replay[0].sessionId,pending.sessionId);assert.equal(replay[0].missedScheduledTime,undefined);
  assert.equal(await loaded.confirmTaskRun(task.id,pending.sessionId),true);
});

test('disableJitter updates are persisted and cancel a pending delayed dispatch',async t=>{
  const f=fixture(t);const task=await f.create({name:'stable-jitter',cronExpression:'0 * * * *'});f.service.markListenerReady();assert.equal(await f.service.tick(),0);
  const updated=await f.service.updateScheduledTask({scheduledTaskId:task.id,disableJitter:true});
  assert.equal(updated.jitterSeconds,0);assert.equal(updated.disableJitter,true);assert.equal(await f.service.tick(),1);
  const loaded=createScheduledTasks({root:f.root,now:()=>f.time});t.after(()=>loaded.stop());assert.equal((await loaded.getAllScheduledTasks())[0].disableJitter,true);
});

test('per-task active sessions block overlapping slots without consuming their scheduled time',async t=>{
  let counts={thisTask:0,totalScheduled:0};const f=fixture(t,{countActiveSessionsForTask:()=>counts,perTaskLimit:1});
  const task=await f.create({cronExpression:'* * * * *'});f.service.markListenerReady();assert.equal(await f.service.tick(),1);
  const first=f.events.find(e=>e.type==='session_started');await f.service.confirmTaskRun(task.id,first.sessionId);
  counts={thisTask:1,totalScheduled:1};f.time+=60000;assert.equal(await f.service.tick(),0);
  assert.equal(f.service.diagnostics().pending.length,0);assert.equal((await f.service.getAllScheduledTasks())[0].lastScheduledFor,new Date(Math.floor((f.time-60000)/60000)*60000).toISOString());
  const stored=JSON.parse(fs.readFileSync(path.join(f.root,'scheduled-tasks.json'),'utf8'));assert.equal(stored.recordedSkips[task.id][0].reason,'per_task_limit');
  counts={thisTask:0,totalScheduled:0};assert.equal(await f.service.tick(),1);
});

test('global limit includes reserved jitter claims but does not count a claim against itself',async t=>{
  const f=fixture(t,{countActiveSessionsForTask:()=>({thisTask:0,totalScheduled:0}),globalLimit:1});
  const first=await f.create({name:'stable-jitter',cronExpression:'0 * * * *'});const second=await f.create({name:'second',fireAt:f.time+1});
  f.time+=2;f.service.markListenerReady();assert.equal(await f.service.tick(),0);assert.equal(f.service.diagnostics().pending.length,1);
  f.time+=51000;assert.equal(await f.service.tick(),1);const event=f.events.find(e=>e.type==='session_started');assert.equal(event.scheduledTask.id,first.id);
  await f.service.confirmTaskRun(first.id,event.sessionId);assert.equal(await f.service.tick(),1);assert.equal(f.events.filter(e=>e.type==='session_started')[1].scheduledTask.id,second.id);
});

test('captured default zero concurrency limits do not silently impose a new policy',async t=>{
  const f=fixture(t,{countActiveSessionsForTask:()=>({thisTask:10,totalScheduled:20})});await f.create({fireAt:f.time+1});f.time+=2;f.service.markListenerReady();assert.equal(await f.service.tick(),1);
});

test('missedRuns uses actual roster, excludes started slots and groups outages like native UI',()=>{
  const {missedRunsFor}=require('../desktop/scheduled-tasks.cjs');
  const at=m=>new Date(2026,9,27,10,m).getTime();const task={id:'gaps',createdAt:at(-1),cronExpression:'*/5 * * * *'};
  const missed=missedRunsFor(task,[at(15),at(30)],at(40),0,[{at:at(25),reason:'global_limit'}]);
  assert.deepEqual(missed,[{time:new Date(at(35)).toISOString()},{time:new Date(at(25)).toISOString(),reason:'global_limit'},{time:new Date(at(10)).toISOString()}]);
});

test('unknown roster omits missedRuns while an injected complete roster provides real gap rows',async t=>{
  const f=fixture(t);await f.create({cronExpression:'*/5 * * * *',disableJitter:true});f.time=new Date(2026,9,27,10,40).getTime();
  assert.equal((await f.service.getAllScheduledTasks())[0].missedRuns,undefined);
  f.service.setSessionRosterSource(()=>[{createdAt:new Date(2026,9,27,10,15).getTime()}]);
  assert.equal((await f.service.getAllScheduledTasks())[0].missedRuns.length,2);
  f.service.setSessionRosterSource(()=>[],false);assert.equal((await f.service.getAllScheduledTasks())[0].missedRuns,undefined);
});

test('Pacific weekday peak-hours metadata uses native 5-11 window and never gates a due task',async t=>{
  const {duringPeakHours}=require('../desktop/scheduled-tasks.cjs');const sample=new Date('2026-10-27T12:00:00Z');
  const cron=`0 ${sample.getHours()} * * *`;assert.equal(duringPeakHours(cron,sample.getTime()),true);
  assert.equal(duringPeakHours(cron,sample.getTime(),[6,7]),false);assert.equal(duringPeakHours(cron,sample.getTime(),null),false);
  const f=fixture(t);const task=await f.create({cronExpression:cron,disableJitter:true});assert.deepEqual(task.peakHoursWindowPst,[5,11]);assert.equal(typeof task.isScheduledDuringPeakHours,'boolean');
});

test('explicit offline state defers actual dispatch without consuming a one-time task',async t=>{
  let online=false;const f=fixture(t,{isOnline:()=>online});const task=await f.create({fireAt:f.time+1});f.time+=2;f.service.markListenerReady();
  assert.equal(await f.service.tick(),0);assert.equal(f.service.diagnostics().gates.lastGate.reason,'offline');assert.equal(f.service.diagnostics().pending.length,0);
  assert.equal((await f.service.getAllScheduledTasks())[0].lastRunAt,undefined);online=true;assert.equal(await f.service.tick(),1);
  const event=f.events.find(e=>e.type==='session_started');assert.equal(await f.service.confirmTaskRun(task.id,event.sessionId),true);
});

test('unknown online source does not fabricate offline or authenticated status',async t=>{
  const f=fixture(t);await f.create({fireAt:f.time+1});f.time+=2;f.service.markListenerReady();assert.equal(await f.service.tick(),1);
  assert.equal(f.service.diagnostics().gates.online,undefined);assert.equal(f.service.diagnostics().gates.lastGate,null);
});

test('offline gate can be explicitly disabled and rejects invalid async online sources',async t=>{
  const f=fixture(t,{isOnline:()=>false,offlineGateEnabled:false});await f.create({fireAt:f.time+1});f.time+=2;f.service.markListenerReady();assert.equal(await f.service.tick(),1);
  const invalid=fixture(t,{isOnline:async()=>false});invalid.service.markListenerReady();await assert.rejects(invalid.service.tick(),/boolean or undefined/);
});

test('power event subscription applies a fresh 60-second resume gate and cleans up listeners',async t=>{
  const {EventEmitter}=await import('node:events');const power=new EventEmitter();const f=fixture(t,{powerMonitor:power});await f.create({fireAt:f.time+1});f.time+=2;f.service.markListenerReady();
  assert.equal(power.listenerCount('suspend'),1);assert.equal(power.listenerCount('resume'),1);power.emit('suspend');
  assert.equal(await f.service.tick(),0);f.time+=30000;power.emit('resume');assert.equal(f.service.diagnostics().gates.postWakeRemainingMs,60000);
  f.time+=59999;assert.equal(await f.service.tick(),0);f.time+=1;assert.equal(await f.service.tick(),1);
  await f.service.stop();assert.equal(power.listenerCount('suspend'),0);assert.equal(power.listenerCount('resume'),0);
  assert.equal(f.service.diagnostics().gates.powerEventsAttached,false);
  f.service.start();assert.equal(power.listenerCount('resume'),1);await f.service.stop();assert.equal(power.listenerCount('resume'),0);
});

test('late timer wake inference uses the captured strict 90-second lateness threshold',async t=>{
  const f=fixture(t);await f.create({fireAt:f.time+1});f.time+=2;f.service.markListenerReady();
  const expected=f.time;assert.equal(f.service.observeTimerFire(expected,expected+90000),false);
  f.time=expected+90001;assert.equal(f.service.observeTimerFire(expected,f.time),true);assert.equal(await f.service.tick(),0);
  f.time+=60000;assert.equal(await f.service.tick(),1);
});

test('a real resume event after expected fire suppresses duplicate inferred wake delay',async t=>{
  const f=fixture(t);const expected=f.time;f.time+=1000;f.service.noteResume();f.time=expected+95000;
  assert.equal(f.service.observeTimerFire(expected,f.time),false);assert.equal(f.service.diagnostics().gates.postWakeRemainingMs,0);
  const silent=fixture(t,{silentWakesEnabled:()=>true});assert.equal(silent.service.observeTimerFire(silent.time,silent.time+95000),false);
});

test('due jitter claims survive offline and resume gates with their same identity',async t=>{
  let online=true;const f=fixture(t,{isOnline:()=>online});await f.create({name:'stable-jitter',cronExpression:'0 * * * *'});f.service.markListenerReady();
  assert.equal(await f.service.tick(),0);const claim=f.service.diagnostics().pending[0];online=false;f.time+=51000;assert.equal(await f.service.tick(),0);
  assert.equal(f.service.diagnostics().pending[0].sessionId,claim.sessionId);online=true;f.service.noteResume();assert.equal(await f.service.tick(),0);
  f.time+=60000;assert.equal(await f.service.tick(),1);const event=f.events.find(e=>e.type==='session_started');assert.equal(event.sessionId,claim.sessionId);
});

test('uniform dispatch throttle defers a due slot then bypasses only after native 15-minute ceiling',async t=>{
  const calls=[];let critical=true;const f=fixture(t,{dispatchThrottle:(trigger,extra)=>{calls.push({trigger,extra});return critical?'memory pressure critical':null;}});
  await f.create({fireAt:f.time+1});f.time+=2;f.service.markListenerReady();const start=f.time;
  assert.equal(await f.service.tick(),0);assert.equal(f.service.diagnostics().pending.length,0);assert.equal(f.service.diagnostics().gates.throttleDeferredSince['daily-report'],start);
  f.time+=899999;assert.equal(await f.service.tick(),0);f.time+=1;assert.equal(await f.service.tick(),1);
  assert.deepEqual(calls.at(-1),{trigger:'due_fire',extra:{deferredForMs:900000}});
  assert.equal((await f.service.getAllScheduledTasks())[0].lastRunAt,undefined);
  critical=false;
});

test('a due-fire critical transition refuses emit, retains the slot and resumes when pressure clears',async t=>{
  let dueCritical=true;const f=fixture(t,{dispatchThrottle:trigger=>trigger==='due_fire'&&dueCritical?'memory pressure critical':null});
  await f.create({fireAt:f.time+1});f.time+=2;f.service.markListenerReady();assert.equal(await f.service.tick(),0);
  assert.equal(f.events.filter(e=>e.type==='session_started').length,0);assert.equal(f.service.diagnostics().pending.length,0);
  assert.equal((await f.service.getAllScheduledTasks())[0].lastRunAt,undefined);dueCritical=false;assert.equal(await f.service.tick(),1);
});

test('wake and throttle windows are process state like native, not fabricated persistent flags',async t=>{
  const f=fixture(t,{dispatchThrottle:()=> 'memory pressure critical'});await f.create({fireAt:f.time+1});f.time+=2;f.service.markListenerReady();await f.service.tick();f.service.noteResume();
  const disk=JSON.parse(fs.readFileSync(path.join(f.root,'scheduled-tasks.json'),'utf8'));
  assert.equal(disk.throttleDeferredSince,undefined);assert.equal(disk.lastResumedAt,undefined);assert.equal(disk.suspendedAt,undefined);
  const loaded=createScheduledTasks({root:f.root,now:()=>f.time,dispatchThrottle:()=> 'memory pressure critical'});t.after(()=>loaded.stop());loaded.markListenerReady();
  assert.equal(loaded.diagnostics().gates.postWakeRemainingMs,0);assert.deepEqual(loaded.diagnostics().gates.throttleDeferredSince,{});assert.equal(await loaded.tick(),0);
});
