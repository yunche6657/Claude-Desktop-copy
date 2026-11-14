import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {createLoopProtection,GRACE_MS,MAX_WAKE_DELAY_MS,MAX_SUSPEND_MS}=require('../desktop/cli-loop-protection.cjs');
const base=20000000000;
test('strict grace and activity boundaries, including future activity clamp',()=>{
 const l=createLoopProtection();l.positiveSchedule({scheduledFor:base,armedAt:base-1000});
 assert.equal(l.hasLive(base+GRACE_MS-1),true);assert.equal(l.hasLive(base+GRACE_MS),false);
 l.activity({lastCliMessageAt:base+GRACE_MS});assert.equal(l.hasLive(base+GRACE_MS),true);
 assert.equal(l.hasLive(base+GRACE_MS*2),false);
 l.activity({lastActivityAt:base+MAX_WAKE_DELAY_MS+10});assert.equal(l.hasLive(base+MAX_WAKE_DELAY_MS-1),true);assert.equal(l.hasLive(base+MAX_WAKE_DELAY_MS),false);
});
test('paired and repeated suspend, resume, no suspend, cleanup and nonlocal resume',()=>{
 const l=createLoopProtection();l.positiveSchedule({scheduledFor:base+10000,armedAt:base-1000});l.suspend(base);l.suspend(base+1000);
 assert.equal(l.hasLive(base+MAX_WAKE_DELAY_MS),true);assert.equal(l.hasLive(base+1000+MAX_SUSPEND_MS),false);
 l.resume(base+50000);assert.equal(l.snapshot().wakeup.scheduledFor,base+60000);
 l.resume(base+100000);assert.equal(l.snapshot().wakeup.scheduledFor,base+161000);
 const before=l.snapshot().wakeup.scheduledFor;l.suspend(base+120000);l.resume(base+130000,{local:false});assert.equal(l.snapshot().wakeup.scheduledFor,before);
 assert.equal(l.clearExpired(base+MAX_WAKE_DELAY_MS*2),true);assert.equal(l.snapshot().wakeup,null);assert.equal(l.clearExpired(base+MAX_WAKE_DELAY_MS*2),false);
});
test('invalid schedule does not clear positive evidence and reset clears epoch state',()=>{
 const l=createLoopProtection();l.positiveSchedule({scheduledFor:base,armedAt:base});assert.equal(l.positiveSchedule({scheduledFor:NaN,armedAt:base}),false);assert.equal(l.hasLive(base),true);l.reset();assert.equal(l.hasLive(base),false);
});
test('original Bn methods in VM agree over exact boundary vectors',t=>{
 const sourcePath=path.resolve(process.cwd(),'../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js');if(!existsSync(sourcePath)){t.skip('reference build unavailable');return;}
 const source=readFileSync(sourcePath,'utf8');const start=source.indexOf('isLoopWakeupLiveAt(e,t,n){');const end=source.indexOf('restartLosesWorkKind(e,t,n){',start);assert.ok(start>0&&end>start);
 const native=vm.runInNewContext(`const CA=960000;function lW(e){return Math.max(e.lastActivityAt,e.lastCliMessageAt??0)};class Native {${source.slice(start,end)}};Native`);
 for(const scheduled of [base,base+10000])for(const activity of [0,base,base+1000000,base+9000000])for(const suspend of [null,base-1,base+5000])for(const delta of [0,959999,960000,1920000,7199999,7200000,259200000]){
   const n=new native();n.lastSuspendedAt=suspend;n.firstUnpairedSuspendAt=suspend;const w={scheduledFor:scheduled,armedAt:base-1000};const session={pendingLoopWakeup:w,lastActivityAt:activity,lastCliMessageAt:0};
   const l=createLoopProtection();l.positiveSchedule(w);l.activity({lastActivityAt:activity});if(suspend!==null)l.suspend(suspend);
   assert.equal(l.hasLive(base+delta),n.hasLiveLoopWakeup(session,base+delta),JSON.stringify({scheduled,activity,suspend,delta}));
 }
});


test('resume deadline adjustments match extracted native paired and unmatched branches',t=>{
 const sourcePath=path.resolve(process.cwd(),'../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js');if(!existsSync(sourcePath)){t.skip('reference build unavailable');return;}
 const source=readFileSync(sourcePath,'utf8'),start=source.indexOf('if(a!==null&&o!==null)for(let e of this.sessions.values()){let n=e.pendingLoopWakeup;');
 const end=source.indexOf('e(i),Mx(this.sessions)',start);assert.ok(start>0&&end>start);
 const original=vm.runInNewContext(`(function(i){const t={Im:7200000};const a=this.lastSuspendedAt===null?null:this.firstUnpairedSuspendAt??this.lastSuspendedAt,o=a===null?null:i-a;${source.slice(start,end)}})`);
 for(const paired of [false,true])for(const local of [false,true])for(const delta of [1000,50000,7200000,259200000]){
  const l=createLoopProtection();l.positiveSchedule({scheduledFor:base+10000,armedAt:base-1000});l.activity({lastActivityAt:base});if(paired){l.suspend(base);l.suspend(base+100);}
  const session={pendingLoopWakeup:{scheduledFor:base+10000,armedAt:base-1000},lastActivityAt:base,backend:{kind:local?'local':'ssh'}};
  const manager={lastSuspendedAt:paired?base+100:null,firstUnpairedSuspendAt:paired?base:null,sessions:new Map([['s',session]]),isLoopWakeupLiveAt(w,s,time){return w.scheduledFor+960000>time||w.scheduledFor+7200000>time&&time-Math.min(s.lastActivityAt,time)<960000;}};
  original.call(manager,base+delta);l.resume(base+delta,{local});assert.equal(l.snapshot().wakeup.scheduledFor,session.pendingLoopWakeup.scheduledFor);
 }
});
