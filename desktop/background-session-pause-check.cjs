'use strict';
const assert=require('node:assert/strict');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runSessionPauseCheck({report,ev,evictResourceProofSession,getActiveCcbProcesses}) {
 const call=(method,args=[])=>ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
 const marker='R366_RESOURCE_CONTEXT',cwd=process.env.CLAUDE_WORKSPACE;
 const session=await call('start',[{cwd,title:'Native pause proof'}]),sid=session.sessionId;
 report.sessionId=sid;report.realModelService=false;report.checks={};
 const child=()=>getActiveCcbProcesses().find(row=>row.sessionId===sid);
 await ev(`window.__pauseEvents=[];window.__pauseUnsubscribe=window['claude.web'].LocalSessions.onOnEvent(event=>{if(event.sessionId===${JSON.stringify(sid)}&&event.type==='paused')window.__pauseEvents.push(event);});true`);
 try {
  const first=await call('sendMessage',[sid,'Reply with exactly: '+marker+'. Use no tools.']);assert.equal(first.ok,true);assert.equal(first.text.trim(),marker);
  const before=await call('getSession',[sid]),rows=await call('getTranscript',[sid]);const oldPid=child()?.pid;assert.ok(oldPid);const cliId=before.cliSessionId;
  await call('setVisibility',[sid,false,'navigation']);
  let paused;const end=Date.now()+5000;
  while(Date.now()<end){paused=await evictResourceProofSession(sid);if(paused.ok)break;assert.ok(['no-verified-transcript','not-idle'].includes(paused.reason),JSON.stringify(paused));await sleep(50);}
  assert.equal(paused?.ok,true);let alive=false;try{process.kill(oldPid,0);alive=true;}catch{}assert.equal(alive,false);report.checks.actualPidClosed=true;
  const eventEnd=Date.now()+3000;let events=[];while(Date.now()<eventEnd){events=await ev('window.__pauseEvents');if(events.length)break;await sleep(30);}
  assert.equal(events.length,1);assert.deepEqual(Object.keys(events[0]).sort(),['session','sessionId','type']);assert.equal(events[0].sessionId,sid);assert.equal(events[0].session.cliSessionId,cliId);assert.equal(events[0].session.isRunning,false);assert.equal('isPaused' in events[0].session,false);report.checks.nativePausedEvent=true;
  assert.equal((await call('getSession',[sid])).cliSessionId,cliId);assert.deepEqual(await call('getTranscript',[sid]),rows);assert.equal(child(),undefined);report.checks.sessionAndTranscriptPreserved=true;
  await call('warmSession',[sid]);const newPid=child()?.pid;assert.ok(newPid&&newPid!==oldPid);assert.equal(child().initialized,true);assert.equal((await call('getSession',[sid])).cliSessionId,cliId);report.checks.publicWarmResumesActualActor=true;
  const recalled=await call('sendMessage',[sid,'Recall the exact token in your previous reply. Reply only with it; use no tools.']);assert.equal(recalled.ok,true);assert.equal(recalled.text.trim(),marker);report.checks.resumedTurnCompleted=true;
  report.pids={old:oldPid,resumed:newPid};report.events=events;report.checks.noPublicPausedFlag=true;
 } finally {await ev('window.__pauseUnsubscribe?.();true');await call('delete',[sid]);}
}
module.exports={runSessionPauseCheck};
