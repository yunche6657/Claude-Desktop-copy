import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createCliGovernor,createMemoryRatioReader,systemMemoryRatio,defaultProcessCap}=require('../desktop/cli-governor.cjs');
function fixture(options={}){
  let time=1000000,count=0,ratio=0.5;const analytics=[],pressures=[],warnings=[];
  const service=createCliGovernor({countActive:()=>count,cap:()=>6,getFreeMemoryRatio:()=>ratio,now:()=>time,
    onAnalyticsEvent:(name,data)=>analytics.push({name,data}),onPressureEvent:e=>pressures.push(e),warn:(message,error)=>warnings.push({message,error}),...options});
  return {service,analytics,pressures,warnings,get time(){return time;},set time(v){time=v;},get count(){return count;},set count(v){count=v;},get ratio(){return ratio;},set ratio(v){ratio=v;}};
}

test('process cap uses the recovered RAM tier formula, not an invented fixed concurrency',()=>{
  assert.equal(defaultProcessCap(8*1024**3),6);assert.equal(defaultProcessCap(18*1024**3),6);assert.equal(defaultProcessCap(24*1024**3),8);assert.equal(defaultProcessCap(64*1024**3),21);
});

test('Windows memory pressure uses the minimum of physical free and commit/swap headroom',()=>{
  assert.equal(systemMemoryRatio({total:1000,free:500,swapTotal:2000,swapFree:20}),0.01);
  assert.equal(systemMemoryRatio({total:1000,free:40,swapTotal:2000,swapFree:800}),0.04);
  assert.equal(systemMemoryRatio({total:1000,free:500,swapTotal:0,swapFree:0}),0.5);
  assert.equal(systemMemoryRatio({total:1000,free:500}),0.5);
  assert.equal(systemMemoryRatio({total:0,free:0}),1);assert.equal(systemMemoryRatio(undefined),1);
});

test('sampler exposes unavailable and invalid sources rather than pretending an OS read succeeded',()=>{
  const absent=createMemoryRatioReader(null);assert.equal(absent(),1);assert.equal(absent.sourceAvailable(),false);assert.equal(absent.sourceState(),'unavailable');
  const invalid=createMemoryRatioReader(()=>null);assert.equal(invalid(),1);assert.equal(invalid.sourceState(),'invalid');
  const actual=createMemoryRatioReader(()=>({total:4000,free:2000,swapTotal:8000,swapFree:80}));assert.equal(actual(),0.01);assert.equal(actual.sourceState(),'sampled');
});

test('captured thresholds are strict: below 2% critical, below 5% warning, otherwise clear',()=>{
  const f=fixture();const levels=[];const detach=f.service.subscribe(level=>levels.push(level));
  f.ratio=0.019;assert.equal(f.service.sampleNow(),'critical');f.ratio=0.02;assert.equal(f.service.sampleNow(),'warning');
  f.ratio=0.049;assert.equal(f.service.sampleNow(),'warning');f.ratio=0.05;assert.equal(f.service.sampleNow(),null);
  assert.deepEqual(levels,['critical','warning',null]);assert.equal(f.service.currentLevel(),null);detach();f.service.stop();
});

test('critical pressure drives real dispatch throttle and exact deferred bypass contract',()=>{
  const f=fixture();f.ratio=0.01;f.service.sampleNow();assert.equal(f.service.currentLevel(),'critical');
  assert.equal(f.service.dispatchThrottle('tick'),'memory pressure critical');assert.equal(f.service.dispatchThrottle('due_fire',{deferredForMs:900000}),null);
  const rows=f.analytics.filter(e=>e.name==='desktop_ccd_governor_throttled');assert.equal(rows.length,2);assert.equal(rows[0].data.source,'scheduled_dispatch');
  assert.equal(rows[1].data.bypassed,true);assert.equal(rows[1].data.deferred_for_ms,900000);f.ratio=0.1;f.service.sampleNow();assert.equal(f.service.dispatchThrottle('tick'),null);
});

test('infinite cap suppresses externally observed level exactly like native disable policy',()=>{
  const f=fixture({cap:()=>Infinity});f.ratio=0.01;f.service.sampleNow();assert.equal(f.service.diagnostics().observedLevel,'critical');
  assert.equal(f.service.currentLevel(),null);assert.equal(f.service.dispatchThrottle('tick'),null);assert.equal(f.service.headroom(),Infinity);
});

test('sampling error clears level per native fallback, warns once and preserves diagnostic failure',()=>{
  let fail=false;const f=fixture({getFreeMemoryRatio:()=>{if(fail)throw new Error('controlled memory read error');return 0.01;}});
  f.service.sampleNow();assert.equal(f.service.currentLevel(),'critical');fail=true;assert.equal(f.service.sampleNow(),null);assert.equal(f.service.currentLevel(),null);
  f.service.sampleNow();assert.equal(f.warnings.length,1);assert.equal(f.service.diagnostics().lastReadError,'controlled memory read error');
});

test('concurrent warm reservations are serialized and release is idempotent',async()=>{
  const f=fixture({cap:()=>1});const [first,second]=await Promise.all([f.service.acquireSlot('warm'),f.service.acquireSlot('warm')]);
  assert.equal(first.yielded,false);assert.equal(second.yielded,true);assert.equal(f.service.effective(),1);assert.equal(f.service.headroom(),0);
  first.release();first.release();second.release();assert.equal(f.service.effective(),0);
});

test('user starts exceed soft cap while warm starts yield without a qualified owned victim',async()=>{
  const f=fixture({cap:()=>1});f.count=1;const warm=await f.service.acquireSlot('warm');assert.equal(warm.yielded,true);
  const user=await f.service.acquireSlot('user');assert.equal(user.yielded,false);assert.equal(f.service.isOverCap(),true);user.release();
  assert.equal(f.analytics.filter(e=>e.name==='desktop_ccd_governor_soft_cap_exceeded').length,1);
});

test('warm cap replacement requests only a 60-second idle victim and never evicts when already over cap',async()=>{
  let victim={sessionId:'owned-idle',idleSeconds:59};const evicted=[];const f=fixture({cap:()=>1,peekLruIdleVictim:()=>victim,evictVictim:id=>evicted.push(id)});f.count=1;
  assert.equal((await f.service.acquireSlot('warm')).yielded,true);assert.deepEqual(evicted,[]);
  victim={...victim,idleSeconds:60};const warm=await f.service.acquireSlot('warm');assert.equal(warm.yielded,false);assert.deepEqual(evicted,['owned-idle']);warm.release();
  f.count=2;assert.equal((await f.service.acquireSlot('warm')).yielded,true);assert.equal(evicted.length,1);
});

test('pressure sweep evicts only supplied idle victims, stops at demand, and debounces each level for 60 seconds',()=>{
  const victims=[{sessionId:'one',idleSeconds:70},{sessionId:'two',idleSeconds:80},{sessionId:'young',idleSeconds:59}];const evicted=[];
  const f=fixture({peekLruIdleVictim:()=>victims[0]||null,evictVictim:id=>{evicted.push(id);victims.shift();}});f.count=3;f.ratio=0.01;
  f.service.sampleNow();assert.deepEqual(evicted,['one','two']);assert.deepEqual(f.pressures,['critical']);
  const row=f.analytics.find(e=>e.name==='desktop_ccd_governor_pressure');assert.equal(row.data.evicted,2);assert.equal(row.data.demand,3);
  f.time+=59999;f.service.sampleNow();assert.equal(f.pressures.length,1);f.time+=1;f.service.sampleNow();assert.equal(f.pressures.length,2);assert.equal(evicted.length,2);
});

test('pressure sweep never repeatedly requests the same still-live victim',()=>{
  const evicted=[];const f=fixture({peekLruIdleVictim:()=>({sessionId:'same',idleSeconds:120}),evictVictim:id=>evicted.push(id)});f.count=10;f.ratio=0.01;
  f.service.sampleNow();assert.deepEqual(evicted,['same']);assert.equal(f.analytics.find(e=>e.name==='desktop_ccd_governor_pressure').data.evicted,0);
});

test('repeat pressure analytics require a 100% tree peak plus five minutes while pressure events still arrive',()=>{
  let peak=null;const f=fixture({getTreePeakPercent:()=>peak,getTreeFootprintPercent:()=>91});f.ratio=0.01;f.service.sampleNow();
  f.time+=300000;f.service.sampleNow();assert.equal(f.pressures.length,2);assert.equal(f.analytics.filter(e=>e.name==='desktop_ccd_governor_pressure').length,1);
  peak=100;f.service.sampleNow();assert.equal(f.analytics.filter(e=>e.name==='desktop_ccd_governor_pressure').length,1);
  f.time+=60000;f.service.sampleNow();const rows=f.analytics.filter(e=>e.name==='desktop_ccd_governor_pressure');assert.equal(rows.length,2);assert.equal(rows[1].data.is_repeat,true);assert.equal(rows[1].data.tree_footprint_pct_of_ram,91);
});

test('real polling timer samples and stops without retaining an interval or subscribers',async t=>{
  let sampleCount=0,resolve;const changed=new Promise(r=>{resolve=r;});const f=fixture({pollIntervalMs:10,getFreeMemoryRatio:()=>{sampleCount++;return 0.01;}});
  const detach=f.service.subscribe(resolve);t.after(()=>{detach();f.service.stop();});f.service.start();f.service.start();
  const timeout=setTimeout(()=>resolve('timeout'),1000);const level=await changed;clearTimeout(timeout);
  assert.equal(level,'critical');assert.ok(sampleCount>=1);assert.equal(f.service.diagnostics().polling,true);detach();f.service.stop();
  assert.equal(f.service.diagnostics().polling,false);assert.equal(f.service.currentLevel(),null);
});

test('macOS native pressure path does not invent a polled observedLevel',()=>{
  let callback,detached=0;const f=fixture({platform:'darwin'});f.service.start(fn=>{callback=fn;return()=>{detached++;};});callback('critical');
  assert.deepEqual(f.pressures,['critical']);assert.equal(f.service.currentLevel(),null);assert.equal(f.service.diagnostics().polling,false);f.service.stop();assert.equal(detached,1);
});
