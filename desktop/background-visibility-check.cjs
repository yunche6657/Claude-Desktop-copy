'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Removal from the backend's active map can precede OS process termination.
// Only ESRCH proves absence; EPERM and other errors do not prove exit.
async function waitForProcessExit(pid, {timeoutMs=5000, intervalMs=100, now=Date.now, wait=sleep, probe=process.kill.bind(process)} = {}) {
 const deadline=now()+timeoutMs;
 for (;;) {
  try { probe(pid,0); } catch(error) { if(error?.code==='ESRCH')return true; }
  const remaining=deadline-now(); if(remaining<=0)return false;
  await wait(Math.min(intervalMs,remaining));
 }
}
async function runVisibilityCheck({report,ev,getWarmLifecycleState,evictResourceProofSession,getActiveCcbProcesses}) {
 const call=(method,args=[])=>ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
 const ids=[],oldPids=[];
 const processFor=id=>getActiveCcbProcesses().find(child=>child.sessionId===id);
 for(let i=0;i<2;i++){
  const requested=i===0?'local_'+randomUUID():undefined;
  if(requested){await call('setVisibility',[requested,false,'navigation']);assert.equal(getWarmLifecycleState(requested).pendingVisibility,false);}
  const s=await call('start',[{sessionId:requested,cwd:process.env.CLAUDE_WORKSPACE,title:'Visibility warm proof '+i}]);ids.push(s.sessionId);
  await call('warmSession',[s.sessionId]);oldPids.push(processFor(s.sessionId)?.pid);assert.ok(oldPids.at(-1));
  await call('setVisibility',[s.sessionId,false]);
  const hidden=getWarmLifecycleState(s.sessionId);assert.equal(hidden.hasPendingResult,false);assert.equal(hidden.idleArmed,false);assert.equal(hidden.idleRecheckPending,true);assert.ok(hidden.idleUnarmedSince>0);
  if(requested){assert.equal(hidden.visibilityKnown,true);assert.equal(hidden.isVisible,false);assert.equal(hidden.pendingVisibility,undefined);report.pendingReplay=hidden;}
  assert.equal((await evictResourceProofSession(s.sessionId)).ok,true);
  const closed=getWarmLifecycleState(s.sessionId);assert.equal(closed.idleUnarmedSince,null);assert.equal(closed.idleRecheckPending,false);
  assert.equal(processFor(s.sessionId),undefined);
 }
 // Both requests use the actual renderer IPC. The second remains in the warm queue.
 await call('setVisibility',[ids[0],true]);
 await call('setVisibility',[ids[1],true]);
 const queued=getWarmLifecycleState(ids[1]);assert.equal(queued.warmScheduled,true);
 await call('setVisibility',[ids[1],false]);
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){
  const state=getWarmLifecycleState(ids[0]);
  if(processFor(ids[0])?.initialized&&!state.warming)break;
  await sleep(100);
 }
 await sleep(1100);
 const visibleState=getWarmLifecycleState(ids[0]);assert.equal(visibleState.idleUnarmedSince,null);assert.equal(visibleState.idleRecheckPending,false);
 const warmed=processFor(ids[0]);assert.ok(warmed?.initialized);assert.notEqual(warmed.pid,oldPids[0]);
 assert.equal(processFor(ids[1]),undefined);
 for(const id of ids)assert.equal((await call('getTranscript',[id])).length,0);
 report.pids={old:oldPids,warmed:warmed.pid};
 for(const pid of oldPids)assert.equal(await waitForProcessExit(pid),true,`old actor ${pid} did not exit within 5000 ms`);
 report.checks={actualVisibilityWarm:true,queueObserved:true,hiddenBeforeExecutionSkipped:true,newActorInitialized:true,noModelRequests:true,oldActorsStopped:true,pendingHiddenReplayed:true,emptyInitializedUnarmed:true,disconnectClearsIdle:true,visibleRewarmStaysUnarmedFalse:true};
 report.pids={old:oldPids,warmed:warmed.pid};report.lifecycle=ids.map(id=>getWarmLifecycleState(id));
 report.realModelService=false;
}
module.exports={runVisibilityCheck,waitForProcessExit};
