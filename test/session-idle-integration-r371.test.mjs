import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
function clock(){let time=1000,seq=0;const timers=new Map();return {now:()=>time,setTimer(fn,ms){const id=++seq;timers.set(id,{fn,at:time+ms});return id;},clearTimer:id=>timers.delete(id),async advance(ms){const end=time+ms;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;timers.delete(next[0]);time=next[1].at;await next[1].fn();}time=end;},count:()=>timers.size};}
function fixture({timeout=0}={}){const c=clock(),listeners=new Set(),actors=new Map(),evictions=[];let decline=false;const backend={id:'fixture',onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);},start({sessionId:id}){actors.set(id,{pid:actors.size+100,actorToken:id+'-actor',idleEligible:true,initialized:true});},async sendMessage(){return {text:'ok'};},cancel(){},dispose(){},getInfo(id){return actors.get(id)||null;},getActiveProcesses(){return [...actors].map(([sessionId,s])=>({sessionId,...s,protection:{version:1}}));},async warm(id){backend.start({sessionId:id});},removeSession:id=>actors.delete(id),async evictSession(id,expected){assert.equal(expected.validate(),true);evictions.push(id);if(!decline){actors.delete(id);notify('query_closed',id,null);}return {ok:!decline};}};
 function notify(type,id,actorToken=actors.get(id)?.actorToken){for(const fn of listeners)fn({type,sessionId:id,actorToken});}
 const kernel=createSessionKernel({backend,emit(){},idleTimeoutMs:()=>timeout,idleClock:c});return {c,kernel,backend,actors,evictions,notify,setTimeout:v=>timeout=v,setDecline:v=>decline=v};}

test('unregistered visibility uses last write, preserves false and caps recent IDs at 64',()=>{
 const f=fixture();try{
  for(let i=0;i<65;i++)f.kernel.setVisibility('future-'+i,false,'renderer');
  assert.equal(f.kernel.getWarmLifecycleState('future-0').pendingVisibility,undefined);
  assert.equal(f.kernel.getWarmLifecycleState('future-1').pendingVisibility,false);
  f.kernel.setVisibility('future-1',true,'renderer');f.kernel.setVisibility('future-1',false,'renderer');
  f.kernel.start({sessionId:'future-1',cwd:process.cwd()});
  const s=f.kernel.getWarmLifecycleState('future-1');assert.equal(s.visibilityKnown,true);assert.equal(s.isVisible,false);assert.equal(s.pendingVisibility,undefined);
  f.notify('query_installed','future-1');assert.equal(f.kernel.getWarmLifecycleState('future-1').idleUnarmedSince,1000);
  assert.equal(f.kernel.pickLruIdleVictim(f.backend.getActiveProcesses(),{protectionForSession:()=>Object.fromEntries(['agentRun','stopping','cron','backgroundTasks','loopWakeup','remoteControl','lanyard','otherProtection','otherProtection2'].map(k=>[k,false]))}).sessionId,'future-1');
 }finally{f.kernel.dispose();}assert.equal(f.c.count(),0);
});

test('zero timeout remains connected on recheck; config change arms, decline retries, visibility cancels',async()=>{
 const f=fixture();try{
  f.kernel.setVisibility('s',false,'renderer');f.kernel.start({sessionId:'s',cwd:process.cwd()});f.notify('query_installed','s');
  assert.equal(f.kernel.getWarmLifecycleState('s').idleRecheckPending,true);await f.c.advance(900000);assert.deepEqual(f.evictions,[]);assert.equal(f.actors.has('s'),true);
  f.setTimeout(100);await f.c.advance(900000);assert.equal(f.kernel.getWarmLifecycleState('s').idleArmed,true);
  f.setDecline(true);await f.c.advance(100);assert.deepEqual(f.evictions,['s']);assert.equal(f.kernel.getWarmLifecycleState('s').consecutiveDeclinedPauses,1);
  f.kernel.setVisibility('s',true,'renderer');await f.c.advance(1000);assert.deepEqual(f.evictions,['s']);
  f.setDecline(false);f.kernel.setVisibility('s',false,'renderer');await f.c.advance(100);assert.deepEqual(f.evictions,['s','s']);assert.equal(f.actors.has('s'),false);assert.equal(f.kernel.getWarmLifecycleState('s').idleRecheckPending,false);
 }finally{f.kernel.dispose();}assert.equal(f.c.count(),0);
});

test('stale actor install is ignored and visible query installation does not arm',()=>{
 const f=fixture({timeout:100});try{f.kernel.setVisibility('s',true);f.kernel.start({sessionId:'s',cwd:process.cwd()});f.notify('query_installed','s','wrong');assert.equal(f.kernel.getWarmLifecycleState('s').idleArmed,false);f.notify('query_installed','s');assert.equal(f.kernel.getWarmLifecycleState('s').idleArmed,false);}finally{f.kernel.dispose();}
});


test('pending visibility aggregates registered-later renderers and losing one source does not hide another',()=>{
 const f=fixture({timeout:100});try{
 f.kernel.setVisibility('s',true,'A');f.kernel.setVisibility('s',false,'B');
 assert.equal(f.kernel.getWarmLifecycleState('s').pendingVisibility,true);f.kernel.start({sessionId:'s',cwd:process.cwd()});
 f.notify('query_installed','s');assert.equal(f.kernel.getWarmLifecycleState('s').isVisible,true);assert.equal(f.kernel.getWarmLifecycleState('s').idleArmed,false);
 f.kernel.setVisibility('s',false,'B');assert.equal(f.kernel.getWarmLifecycleState('s').isVisible,true);
 f.kernel.setVisibility('s',false,'A');assert.equal(f.kernel.getWarmLifecycleState('s').isVisible,false);assert.equal(f.kernel.getWarmLifecycleState('s').idleArmed,true);
 }finally{f.kernel.dispose();}
});
