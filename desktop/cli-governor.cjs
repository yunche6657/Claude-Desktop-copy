'use strict';
// Native policy: index.chunk-Bn6onBlX.js mp @3252xx; memory reader
// index.chunk-lzaSYO3Q.js VCn @2954116. No arbitrary OS free-memory thresholds.
const os = require('node:os');
const GIB = 1024 ** 3;
const DEFAULTS = Object.freeze({pollIntervalMs:10000,minVictimIdleMs:60000,pressureSweepMs:60000,
  warningRatio:0.05,criticalRatio:0.02,repeatPressureMs:300000,repeatTreePeakPercent:100});
function defaultProcessCap(totalBytes = os.totalmem()) {return Math.max(6,Math.floor(totalBytes/(3*GIB)));}
function systemMemoryRatio(info) {
  if (!info || info.total <= 0) return 1;
  const free = info.free/info.total;
  return info.swapTotal && info.swapFree !== undefined ? Math.min(free,info.swapFree/info.swapTotal) : free;
}
function createMemoryRatioReader(getSystemMemoryInfo = typeof process.getSystemMemoryInfo === 'function' ? process.getSystemMemoryInfo.bind(process) : null) {
  if (getSystemMemoryInfo !== null && typeof getSystemMemoryInfo !== 'function') throw new TypeError('Invalid system-memory sampler');
  let lastSourceState = getSystemMemoryInfo ? 'not_sampled' : 'unavailable';
  const read = () => {
    if (!getSystemMemoryInfo) {lastSourceState='unavailable';return 1;}
    let info;
    try {info=getSystemMemoryInfo();}catch(error){lastSourceState='read_error';throw error;}
    lastSourceState = info && Number.isFinite(info.total) && info.total>0 && Number.isFinite(info.free) ? 'sampled' : 'invalid';
    return systemMemoryRatio(info);
  };
  read.sourceState = () => lastSourceState;
  read.sourceAvailable = () => getSystemMemoryInfo !== null;
  return read;
}

function createCliGovernor({cap = () => defaultProcessCap(),countActive,peekLruIdleVictim = () => null,
  getFreeMemoryRatio = createMemoryRatioReader(),evictVictim,onAnalyticsEvent,onPressureSample,onPressureEvent,
  getTreeFootprintPercent = () => null,getTreePeakPercent = () => null,
  now = Date.now,pollIntervalMs = DEFAULTS.pollIntervalMs,minVictimIdleMs = DEFAULTS.minVictimIdleMs,
  platform = process.platform,totalMemoryBytes = os.totalmem(),warn = () => {}} = {}) {
  if(typeof countActive!=='function'||typeof cap!=='function'||typeof peekLruIdleVictim!=='function'||typeof getFreeMemoryRatio!=='function') throw new TypeError('Governor requires real process and memory source callbacks');
  if(!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1||!Number.isFinite(minVictimIdleMs)||minVictimIdleMs<0)throw new TypeError('Invalid governor timing');
  let inFlight=0,observedLevel=null,pollTimer=null,nativeUnsubscribe=null,lastEmitted=null,memoryReadFailureLogged=false,lastReadError=null,lastRatio=null;
  let queue=Promise.resolve();const subscribers=new Set(),lastSweepAt={warning:0,critical:0};
  const totalMemGb=Math.round(totalMemoryBytes/GIB);
  const emit=(name,data)=>onAnalyticsEvent?.(name,data);
  const readCap=()=>{const n=cap();if(typeof n!=='number'||n<0||Number.isNaN(n))throw new Error('Invalid CLI process cap');return n;};
  const active=()=>{const n=countActive();if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid active CLI count');return n;};
  const effective=()=>active()+inFlight;
  const passesIdleGuard=v=>v.idleSeconds*1000>=minVictimIdleMs;
  function setObservedLevel(level){
    if(level===observedLevel)return;observedLevel=level;
    for(const subscriber of subscribers)try{subscriber(level);}catch(error){warn('level subscriber threw',error);}
  }
  function currentLevel(){return Number.isFinite(readCap())?observedLevel:null;}
  async function acquireSlot(reason){
    const limit=readCap();
    const job=queue.then(()=>{
      const count=active(),pending=inFlight,total=count+pending,metrics={effective:total,count_active:count,in_flight:pending};
      if(total>=limit){
        const victim=peekLruIdleVictim('warm'),eligible=!!victim&&passesIdleGuard(victim);
        const evict=reason==='warm'&&total===limit&&eligible&&!!evictVictim;
        if(victim)emit('desktop_ccd_governor_would_evict',{reason,cap:limit,...metrics,victim_idle_seconds:victim.idleSeconds,total_mem_gb:totalMemGb,evicted:evict});
        if(reason==='user')emit('desktop_ccd_governor_soft_cap_exceeded',{cap:limit,...metrics,had_evictable:eligible,total_mem_gb:totalMemGb});
        else if(evict&&victim)evictVictim(victim.sessionId,{victim,purpose:'warm'});
        else {emit('desktop_ccd_governor_yielded',{reason,cap:limit,...metrics,had_evictable:eligible,total_mem_gb:totalMemGb});return {yielded:true,release:()=>{}};}
      }
      inFlight++;let released=false;
      return {yielded:false,release:()=>{if(!released){released=true;inFlight--;}}};
    });
    queue=job.then(()=>undefined,()=>undefined);return job;
  }
  function onPressure(level){
    if(level!=='warning'&&level!=='critical')throw new Error('Invalid memory pressure level');
    const limit=readCap(),time=now();if(time-lastSweepAt[level]<DEFAULTS.pressureSweepMs)return;
    lastSweepAt[level]=time;
    const count=active(),pending=inFlight,total=count+pending,demand=Math.max(0,total),first=peekLruIdleVictim('pressure');
    const wouldEvict=demand>0&&first?demand:0,enabled=!!evictVictim;let evicted=0;
    if(enabled){
      let previous=null;
      for(;;){
        const victim=peekLruIdleVictim('pressure');
        if(previous){if(victim?.sessionId===previous)break;evicted++;}
        if(evicted>=demand||!victim||!passesIdleGuard(victim))break;
        evictVictim(victim.sessionId,{victim,purpose:'pressure'});previous=victim.sessionId;
      }
    }
    onPressureEvent?.(level);
    const footprint=getTreeFootprintPercent(time),prior=lastEmitted;
    const repeated=wouldEvict===0&&prior?.level===level&&prior.cap===limit;
    if(repeated&&((getTreePeakPercent(time)??0)<DEFAULTS.repeatTreePeakPercent||time-prior.at<DEFAULTS.repeatPressureMs))return;
    lastEmitted={level,cap:limit,at:time};
    emit('desktop_ccd_governor_pressure',{level,would_evict:wouldEvict,evicted,effective:total,count_active:count,in_flight:pending,cap:limit,
      total_mem_gb:totalMemGb,demand,had_evictable:!!first&&passesIdleGuard(first),tree_footprint_pct_of_ram:footprint,is_repeat:!!repeated});
    if(!repeated)onPressureSample?.();
  }
  function onSignal(level){if(level)onPressure(level);else lastEmitted=null;}
  function sampleNow(){
    let ratio;
    try {ratio=getFreeMemoryRatio();if(typeof ratio!=='number')throw new TypeError('Memory ratio sampler must be synchronous and numeric');}
    catch(error){
      lastReadError=String(error.message||error);lastRatio=null;
      if(!memoryReadFailureLogged){memoryReadFailureLogged=true;warn('getFreeMemoryRatio failed; treating memory pressure as clear',error);}
      setObservedLevel(null);return null;
    }
    lastReadError=null;lastRatio=ratio;
    const level=ratio<DEFAULTS.criticalRatio?'critical':ratio<DEFAULTS.warningRatio?'warning':null;
    setObservedLevel(level);onSignal(level);return level;
  }
  function start(subscribeNative){
    if(pollTimer||nativeUnsubscribe)return;
    if(subscribeNative)nativeUnsubscribe=subscribeNative(level=>onSignal(level==='normal'?null:level));
    // The captured native class does not poll on macOS. Its native pressure
    // events drive sweeps, but do not set observedLevel; keep that boundary.
    if(platform==='darwin')return;
    pollTimer=setInterval(sampleNow,pollIntervalMs);pollTimer.unref?.();
  }
  function stop(){
    if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
    try {nativeUnsubscribe?.();}finally{nativeUnsubscribe=null;setObservedLevel(null);lastEmitted=null;}
  }
  return {effective,currentLevel,acquireSlot,sampleNow,onPressure,onSignal,start,stop,
    subscribe(fn){if(typeof fn!=='function')throw new TypeError('Invalid governor subscriber');subscribers.add(fn);return()=>subscribers.delete(fn);},
    isAtCap:()=>effective()>=readCap(),isOverCap:()=>effective()>readCap(),currentCap:readCap,headroom:()=>Math.max(0,readCap()-effective()),
    diagnostics(){return {inFlight,observedLevel,currentLevel:currentLevel(),polling:pollTimer!==null,nativeSubscribed:!!nativeUnsubscribe,lastRatio,lastReadError,
      memorySourceState:typeof getFreeMemoryRatio.sourceState==='function'?getFreeMemoryRatio.sourceState():'injected',memoryReadFailureLogged,lastSweepAt:{...lastSweepAt},lastEmitted:lastEmitted?{...lastEmitted}:null};},
    dispatchThrottle(trigger,extra){
      if(currentLevel()!=='critical')return null;
      emit('desktop_ccd_governor_throttled',{source:'scheduled_dispatch',level:'critical',trigger,...(extra?{bypassed:true,deferred_for_ms:extra.deferredForMs}:{}),total_mem_gb:totalMemGb});
      return extra?null:'memory pressure critical';
    },
  };
}
module.exports={createCliGovernor,createMemoryRatioReader,systemMemoryRatio,defaultProcessCap,DEFAULTS};
