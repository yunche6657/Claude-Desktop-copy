'use strict';
const assert=require('node:assert/strict');
const {createCliGovernor}=require('./cli-governor.cjs');
async function runResourceCheck({report,ev,createResourceProofBackend,getActiveCcbProcesses}) {
 const marker='R366_RESOURCE_CONTEXT';
 let backend,cap=0;
 report.checks={};report.admissions=[];report.realModelService=false;
 const governor=createCliGovernor({cap:()=>cap,countActive:()=>backend?.getActiveProcesses().length||0});
 backend=createResourceProofBackend(request=>{report.admissions.push(request.reason);return governor.acquireSlot(request.reason);});
 try {
  await assert.rejects(backend.warm('yielded',{reason:'prewarm'}),error=>error.code==='CCB_ADMISSION_YIELDED');
  assert.equal(backend.getActiveProcesses().length,0);report.checks.prewarmAtCapDoesNotSpawn=true;
  const model=process.env.CLAUDE_AGENT_MODEL,cwd=process.env.CLAUDE_WORKSPACE;
  backend.start({sessionId:'resource-user',cwd,model});await backend.initialize('resource-user');
  const first=backend.getInfo('resource-user');assert.ok(first.pid);
  assert.equal(governor.diagnostics().inFlight,0);report.checks.userSoftCapActualSpawn=true;
  const reply=await backend.sendMessage('resource-user','Reply with exactly: '+marker+'. Use no tools.',{model});
  assert.equal(reply.text.trim(),marker);
  const persistenceDeadline=Date.now()+5000;
  while(!backend.getInfo('resource-user').persistence.transcriptPath&&Date.now()<persistenceDeadline)await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(backend.getInfo('resource-user').persistence.transcriptPath,'native transcript must be verified before eviction');
  const cliId=backend.getInfo('resource-user').persistence.cliSessionId;
  const evicted=await backend.evictSession('resource-user');assert.equal(evicted.ok,true);
  let oldAlive=false;try{process.kill(first.pid,0);oldAlive=true;}catch{}assert.equal(oldAlive,false);
  report.checks.actualIdleChildStopped=true;
  const recalled=await backend.sendMessage('resource-user','Recall the exact token in your previous reply. Reply only with it; use no tools.',{model});
  assert.equal(recalled.text.trim(),marker);
  const resumed=backend.getInfo('resource-user');assert.notEqual(resumed.pid,first.pid);assert.equal(resumed.persistence.cliSessionId,cliId);
  report.pids={first:first.pid,resumed:resumed.pid};report.checks.sameNativeSessionResumed=true;
  cap=2;await backend.warm('empty-draft',{reason:'prewarm',cwd,model});assert.ok(backend.getInfo('empty-draft').init);
  const draftActor=backend.getActiveProcesses().find(child=>child.sessionId==='empty-draft');
  assert.ok(draftActor.protection);assert.equal(draftActor.protection.coverage.backgroundSnapshot,false);
  assert.ok(Object.values(draftActor.protection.flags).every(value=>value===false));
  report.checks.actualCliInitialLedgerEmpty=true;
  assert.equal((await backend.evictSession('empty-draft',{actorToken:'stale-actor'})).reason,'stale-candidate');
  assert.ok(backend.getActiveProcesses().some(child=>child.pid===draftActor.pid));report.checks.staleActorRetainsActualProcess=true;
  let requestedEviction;
  const candidateGovernor=createCliGovernor({cap:()=>2,countActive:()=>backend.getActiveProcesses().length,
    peekLruIdleVictim:()=>{const child=backend.getActiveProcesses().find(child=>child.sessionId==='empty-draft'&&child.idleEligible);return child?{...child,idleSeconds:61}:null;},
    evictVictim:(sessionId,{victim,purpose})=>{assert.equal(purpose,'warm');requestedEviction=backend.evictSession(sessionId,{pid:victim.pid,actorToken:victim.actorToken,protectionVersion:victim.protection.version});}});
  try {
    const slot=await candidateGovernor.acquireSlot('warm');assert.equal(slot.yielded,false);slot.release();
    assert.ok(requestedEviction);assert.equal((await requestedEviction).ok,true);
    let draftAlive=false;try{process.kill(draftActor.pid,0);draftAlive=true;}catch{}assert.equal(draftAlive,false);
    report.checks.governorCallbackStopsActualCli=true;
    report.governorEligibility='Controlled empty-draft selection and idleSeconds=61; real governor admission, actor checks and process close. Natural idle/OS pressure not simulated.';
  } finally {candidateGovernor.stop();}
  await backend.warm('empty-draft',{reason:'prewarm',cwd,model});
  assert.notEqual(backend.getInfo('empty-draft').pid,draftActor.pid);
  assert.notEqual(backend.getInfo('empty-draft').actorToken,draftActor.actorToken);
  report.checks.evictedEmptyActorStartsNewEpoch=true;
  assert.equal((await backend.evictSession('empty-draft')).ok,true);report.checks.realWarmAcknowledged=true;
  assert.equal(governor.diagnostics().inFlight,0);report.checks.noSlotLeak=true;
  const call=(method,args=[])=>ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const count=(await call('getAll')).length;
  const draft=await call('prewarmLocal',[{cwd,model}]);assert.equal(draft.kind,'spare');assert.equal(draft.ready,true);
  assert.equal((await call('getAll')).length,count);
  assert.ok(getActiveCcbProcesses().some(child=>child.sessionId===draft.sessionId&&child.initialized));
  assert.equal((await call('discardPrewarm',[draft.sessionId])).discarded,true);
  report.checks.rendererDraftActualInitialization=true;
  report.checks.draftNotInSidebar=true;
 } finally {await backend.dispose();governor.stop();}
}
module.exports={runResourceCheck};
