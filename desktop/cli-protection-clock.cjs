'use strict';
// Native startTimeoutDetection uses wall clock. A late one-minute tick records
// a wake for cron grace, but does not shift loop deadlines as a resume does.
function createProtectionClock({now=Date.now}={}) {
 let lastSuspendedAt=null,firstUnpairedSuspendAt=null,lastSystemWakeAt=null,lastClockGapEndedAt=null;
 let previousTick=now(),timer=null,monitor=null;const listeners=new Set();
 const snapshot=()=>({lastSuspendedAt,firstUnpairedSuspendAt,lastSystemWakeAt,lastClockGapEndedAt});
 const emit=(kind,at)=>{const event={kind,at,context:snapshot()};for(const fn of listeners)fn(event);return event;};
 function suspend(at=now()){firstUnpairedSuspendAt??=at;lastSuspendedAt=at;return emit('suspend',at);}
 function resume(at=now()){lastSuspendedAt=firstUnpairedSuspendAt=null;lastSystemWakeAt=at;return emit('resume',at);}
 function sample(at=now()){const gap=at-previousTick-60000;previousTick=at;if(gap<=90000)return null;lastSystemWakeAt=Math.max(lastSystemWakeAt??0,at);lastClockGapEndedAt=at;return emit('clock-gap',at);}
 const onSuspend=()=>suspend(),onResume=()=>resume();
 function start(powerMonitor){if(timer)return;monitor=powerMonitor;monitor?.on('suspend',onSuspend);monitor?.on('resume',onResume);previousTick=now();timer=setInterval(sample,60000);timer.unref?.();}
 function stop(){if(timer)clearInterval(timer);timer=null;monitor?.removeListener('suspend',onSuspend);monitor?.removeListener('resume',onResume);monitor=null;}
 return {snapshot,suspend,resume,sample,start,stop,onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
}
module.exports={createProtectionClock};
