import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createSessionKernel} = require('../desktop/session-kernel.cjs');

function clock() {
  let time=1000, seq=0; const timers=new Map();
  return {now:()=>time, setTimer(fn,ms){const id=++seq;timers.set(id,{fn,at:time+ms});return id;},
    clearTimer:id=>timers.delete(id), async advance(ms){const end=time+ms;for(;;){
      const entry=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!entry||entry[1].at>end)break;
      timers.delete(entry[0]);time=entry[1].at;await entry[1].fn();}time=end;}, count:()=>timers.size};
}
function fixture(options={}) {
  const c=clock(), listeners=new Set(), actors=new Map(), events=[], warms=[];
  let serial=0;
  const notify=(type,id,actorToken,extra={})=>{for(const fn of listeners)fn({type,sessionId:id,actorToken,...extra});};
  const backend={id:'fixture',onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    start({sessionId:id}){actors.set(id,{pid:100+(++serial),actorToken:'actor-'+serial,idleEligible:true,initialized:true});},
    getInfo:id=>actors.get(id)||null,
    getActiveProcesses:()=>[...actors].map(([sessionId,a])=>({sessionId,...a,protection:{version:1}})),
    async evictSession(id,expected){const a=actors.get(id);if(!a || expected.validate?.()!==true || expected.actorToken!==a.actorToken)return {ok:false};
      actors.delete(id);notify('query_closed',id,null);notify('actor_paused',id,null,{reason:'idle_timeout'});return {ok:true};},
    async warm(id){warms.push(id);backend.start({sessionId:id});notify('query_installed',id,actors.get(id).actorToken);},
    async sendMessage(){return {text:'ok'};},cancel(){},removeSession:id=>actors.delete(id),dispose(){}};
  const kernel=createSessionKernel({backend,emit:e=>events.push(e),idleClock:c,...options});
  return {kernel,backend,c,actors,events,warms,notify};
}

test('pause forwards native event and retains session, transcript and CLI identity; explicit warm recovers',async()=>{
 const f=fixture({idleTimeoutMs:()=>50});try{
  const initial=f.kernel.start({sessionId:'s',cwd:process.cwd()});
  const cli='11111111-1111-4111-8111-111111111111';f.kernel.update('s',{cliSessionId:cli});
  const rows=[{type:'user',uuid:'u',message:{role:'user',content:'hello'}}];f.kernel.setTranscript('s',rows);
  f.kernel.setVisibility('s',false,'renderer');f.notify('query_installed','s',f.actors.get('s').actorToken);
  assert.equal(f.kernel.getWarmLifecycleState('s').idleArmed,true);
  await f.c.advance(50);
  const paused=f.events.filter(e=>e.type==='paused');assert.equal(paused.length,1);
  assert.deepEqual(Object.keys(paused[0]).sort(),['session','sessionId','type']);
  assert.equal(paused[0].sessionId,'s');assert.equal(paused[0].session.cliSessionId,cli);
  assert.equal('isPaused' in paused[0].session,false);assert.equal(f.kernel.getSession('s').sessionId,initial.sessionId);
  assert.deepEqual(f.kernel.getTranscript('s'),rows);assert.equal(f.kernel.getWarmLifecycleState('s').idleArmed,false);
  assert.equal(f.kernel.getWarmLifecycleState('s').idleRecheckPending,false);assert.equal(f.actors.has('s'),false);
  await f.kernel.warmSession('s');assert.deepEqual(f.warms,['s']);assert.equal(f.actors.has('s'),true);
 }finally{f.kernel.dispose();}assert.equal(f.c.count(),0);
});

test('stale paused notification cannot affect current actor, archived warm is refused',async()=>{
 const f=fixture();try{
  f.kernel.start({sessionId:'s',cwd:process.cwd()});
  f.notify('actor_paused','s',null,{reason:'governor_evict'});
  assert.equal(f.events.some(e=>e.type==='paused'),false);assert.equal(f.actors.has('s'),true);
  f.actors.delete('s');f.notify('query_closed','s',null);f.notify('actor_paused','s',null,{reason:'governor_evict'});
  assert.equal(f.events.filter(e=>e.type==='paused').length,1);
  f.kernel.update('s',{isArchived:true});assert.equal(await f.kernel.warmSession('s'),undefined);assert.deepEqual(f.warms,[]);
 }finally{f.kernel.dispose();}
});

test('default idle policy adapts plain null task and inherits scheduled ancestry including continued',()=>{
 const f=fixture();try{
  for(const [id,extra] of [['plain',{}],['routine',{scheduledTaskId:'task'}],['parent',{scheduledTaskId:'task'}],['continued',{scheduledTaskId:'task'}],['child',{}]])
    f.kernel.start({sessionId:id,cwd:process.cwd(),...extra});
  f.kernel.update('continued',{scheduledRunContinued:true});
  f.kernel.update('child',{dispatchParentId:'continued'});
  for(const id of ['plain','routine','parent','continued','child']){
    f.kernel.setVisibility(id,false,'renderer');f.notify('query_installed',id,f.actors.get(id).actorToken);
  }
  assert.equal(f.kernel.getSession('plain').scheduledTaskId,null);
  assert.equal(f.kernel.getWarmLifecycleState('plain').idleUnarmedSince,1000);
  for(const id of ['routine','parent','continued','child'])assert.equal(f.kernel.getWarmLifecycleState(id).idleArmedTimeoutMs,900000,id);
 }finally{f.kernel.dispose();}assert.equal(f.c.count(),0);
});


test('archive while warm is pending refuses success and ends only its newly created idle actor',async()=>{
 const f=fixture();try{
  f.kernel.start({sessionId:'s',cwd:process.cwd()});f.actors.delete('s');f.notify('query_closed','s',null);
  let release;const original=f.backend.warm;f.backend.warm=async id=>{await new Promise(r=>release=r);await original(id);};
  const warming=f.kernel.warmSession('s');f.kernel.update('s',{isArchived:true});release();
  assert.equal(await warming,undefined);assert.equal(f.actors.has('s'),false);assert.equal(f.kernel.getSession('s').isArchived,true);
  assert.equal(await f.kernel.warmSession('missing'),undefined);
 }finally{f.kernel.dispose();}
});

test('late warm completion does not arm a replacement registration with the same ID',async()=>{
 const f=fixture();try{
  f.kernel.start({sessionId:'s',cwd:process.cwd()});f.actors.delete('s');f.notify('query_closed','s',null);
  let release;f.backend.warm=()=>new Promise(r=>release=r);const warming=f.kernel.warmSession('s');
  f.kernel.remove('s');f.kernel.start({sessionId:'s',cwd:process.cwd()});const token=f.actors.get('s').actorToken;
  release();assert.equal(await warming,undefined);assert.equal(f.actors.get('s').actorToken,token);assert.equal(f.kernel.getWarmLifecycleState('s').idleUnarmedSince,null);
 }finally{f.kernel.dispose();}
});
