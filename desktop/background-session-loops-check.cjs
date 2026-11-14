'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runSessionLoopsCheck({report,ev,getActiveCcbProcesses,win,evictResourceProofSession}) {
 const cwd=process.env.CLAUDE_WORKSPACE,cron=process.env.CLAUDE_LOOPS_PROOF_CRON,marker=process.env.CLAUDE_LOOPS_PROOF_MARKER;
 const call=(method,args=[])=>ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
 const session=await call('start',[{cwd,title:'Controlled session loops proof'}]);const sid=session.sessionId;assert.ok(sid);report.sessionId=sid;report.realModelService=false;report.tasksUiProven=false;report.approvals=[];
 await ev(`window.__loopUpdates=[];window.__loopUnsubscribe=window['claude.web'].LocalSessions.onOnEvent(e=>{if(e.type==='session_updated'&&e.sessionId===${JSON.stringify(sid)})window.__loopUpdates.push({loops:e.session?.loops});});true`);
 const waitTurn=async (prompt,expectedDeleteId)=>{
  await ev(`window.__loopProofTurn={done:false}; window['claude.web'].LocalSessions.sendMessage(${JSON.stringify(sid)},${JSON.stringify(prompt)}).then(value=>{window.__loopProofTurn={done:true,value}},error=>{window.__loopProofTurn={done:true,error:String(error)}});true`);
  const deadline=Date.now()+25000;let turn;
  while(Date.now()<deadline){
   const state=await call('getSession',[sid]);
   for(const request of state.pendingToolPermissions||[]){
    const input=request.input||{};const keys=Object.keys(input).sort().join(',');
    const allow=request.toolName==='CronCreate'&&keys==='cron,durable,prompt,recurring'&&input.cron===cron&&input.prompt===marker&&input.durable===false&&input.recurring===false || request.toolName==='CronDelete'&&keys==='id'&&typeof expectedDeleteId==='string'&&input.id===expectedDeleteId || ['SearchExtraTools','ToolSearch'].includes(request.toolName)&&keys==='query'&&['select:CronCreate','select:CronDelete'].includes(input.query);
    report.approvals.push({toolName:request.toolName,decision:allow?'allow':'deny'});
    const result=await call('respondToToolPermission',[request.requestId,allow?'allow':'deny']);assert.ok(result?.ok,'permission response failed');
    assert.ok(allow,'unexpected tool permission denied');
   }
   turn=await ev('window.__loopProofTurn');if(turn.done)break;await sleep(100);
  }
  assert.ok(turn?.done,'turn timed out');assert.ok(!turn.error,turn.error);assert.equal(turn.value?.ok,true,JSON.stringify(turn.value));
 };
 const findResult=async name=>{
  const rows=await call('getTranscript',[sid]);const blocks=rows.flatMap(row=>row?.message?.content||[]);
  const use=blocks.find(b=>b.type==='tool_use'&&b.name===name);assert.ok(use,`${name} tool_use missing`);
  const result=blocks.find(b=>b.type==='tool_result'&&b.tool_use_id===use.id);assert.ok(result,`${name} result missing`);assert.notEqual(result.is_error,true,`${name} failed`);return {use,result};
 };
 try{
  await ev(`history.pushState({},'', '/epitaxy/'+${JSON.stringify(sid)});dispatchEvent(new PopStateEvent('popstate'));true`);
  await waitTurn('LOOPS_PROOF_CREATE');await findResult('CronCreate');
  const before=await call('getSession',[sid]);report.loopsAfterCreate=before.loops;assert.ok(Array.isArray(before.loops),'session.loops must be an array');const matching=before.loops.filter(loop=>loop.prompt===marker);assert.equal(matching.length,1,'expected exactly one loop with proof prompt');const id=matching[0].id;assert.ok(typeof id==='string'&&/^[\w-]+$/.test(id),'invalid created Cron id');report.createdId=id;
  if(before.ccbResume){report.isolation={cwd:before.ccbResume.cwd,homeDir:before.ccbResume.homeDir,scratchDir:before.ccbResume.scratchDir};for(const value of Object.values(report.isolation)){assert.ok(typeof value==='string'&&value,'missing isolated CCB path');const rel=path.relative(cwd,value);assert.ok(rel!== '..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel),'CCB path outside test workspace');}}
  assert.equal(matching[0].cron,cron);assert.equal(matching[0].recurring,false);assert.ok(Number.isFinite(matching[0].nextRunAt));assert.ok(matching[0].nextRunAt>Date.now()+24*3600000,'scheduled fixture must be remote from the test window');
  const roster=await call('getAll');assert.ok(roster.find(row=>row.sessionId===sid)?.loops?.some(row=>row.id===id));
  const updates=await ev('window.__loopUpdates');assert.ok(updates.some(update=>update.loops?.some(row=>row.id===id)),'no create session_updated loop payload');
  await sleep(300);
  report.tasksButton=await ev(`(()=>{const buttons=[...document.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.height>0});const b=buttons.find(b=>/^(?:1\\s*(?:个)?.*任务|1\\s+task)/i.test((b.innerText||b.getAttribute('aria-label')||'').trim()));if(!b)return null;const label=(b.innerText||b.getAttribute('aria-label')||'').trim();b.click();return label;})()`);
  await sleep(300);report.domAfterCreate=await ev("document.body.innerText.slice(-7000)");
  report.tasksUiProven=!!report.tasksButton && report.domAfterCreate.includes(marker);
  if(win)fs.writeFileSync(path.join(process.env.CLAUDE_CHECK_OUT,'loops-panel.png'),(await win.webContents.capturePage()).toPNG());
  report.processes=getActiveCcbProcesses().filter(p=>p.sessionId===sid).map(p=>({pid:p.pid,sessionId:p.sessionId}));assert.ok(report.processes.length,'actual CCB process missing');
  if(process.env.CLAUDE_LOOPS_PROOF_STOP_UI==='1'){
   assert.equal((await evictResourceProofSession(sid)).reason,'protected','live actual cron must refuse idle pause');report.activeCronPauseRefused=true;
   assert.equal(report.tasksUiProven,true,'task panel must open before stop');
   report.stopButton=await ev(`(()=>{const buttons=[...document.querySelectorAll('button[aria-label]')].filter(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.height>0&&/stop.*(?:scheduled|loop)|停止.*(?:提示|计划|循环)/i.test(b.getAttribute('aria-label')||'')});if(buttons.length!==1)throw Error('Expected one scheduled task stop button; found '+buttons.length);const b=buttons[0];window.__loopStopButton=b;window.__loopStopOriginalLabel=b.getAttribute('aria-label');b.click();return {label:window.__loopStopOriginalLabel};})()`);
   const control=process.env.CLAUDE_LOOPS_PROOF_CONTROL_URL;
   let status;const holdDeadline=Date.now()+8000;
   while(Date.now()<holdDeadline){
    const trusted=await ev(`(()=>{const buttons=[...document.querySelectorAll('button')].filter(b=>/^(?:信任工作区|Trust workspace)$/i.test((b.innerText||'').trim()));for(const b of buttons){let container=b.parentElement;while(container&&container!==document.body&&!((container.innerText||'').includes(${JSON.stringify(cwd)})))container=container.parentElement;if(!container||container===document.body)continue;const label=(b.innerText||'').trim();const role=container.getAttribute('role');b.click();return {label,role};}return null;})()`);
    if(trusted)report.workspaceTrustDialog=trusted;
    status=await (await fetch(control+'/proof-status')).json();if(status.heldStop)break;await sleep(50);
   }
   if(!status?.heldStop){report.stopFailureSession=await call('getSession',[sid]);report.stopFailureDom=await ev('document.body.innerText.slice(-8000)');}
   assert.equal(status?.heldStop,true,'actual UI stop request did not reach upstream');
   assert.equal((await call('checkTrust',[cwd])).trusted,true,'normal workspace trust flow must complete');
   report.pendingStop=await ev(`(()=>{const b=window.__loopStopButton;return {connected:b?.isConnected,label:b?.getAttribute('aria-label'),originalLabel:window.__loopStopOriginalLabel,disabled:b?.disabled,text:document.body.innerText.slice(-2500)}})()`);
   assert.equal(report.pendingStop.connected,true);assert.notEqual(report.pendingStop.label,report.pendingStop.originalLabel,'stop pending aria label must change');
   assert.ok((await call('getSession',[sid])).loops?.some(loop=>loop.id===id),'job must remain while upstream is held');
   if(win)fs.writeFileSync(path.join(process.env.CLAUDE_CHECK_OUT,'loops-stop-pending.png'),(await win.webContents.capturePage()).toPNG());
   await fetch(control+'/proof-release');
   const end=Date.now()+25000;let completed;
   while(Date.now()<end){completed=await call('getSession',[sid]);if(!completed.isRunning&&!completed.loops?.some(loop=>loop.id===id))break;await sleep(100);}
   assert.ok(completed&&!completed.isRunning&&!completed.loops?.some(loop=>loop.id===id),'stop UI turn must complete');
   await sleep(250);report.domAfterStop=await ev('document.body.innerText.slice(-5000)');assert.equal(report.domAfterStop.includes(marker),false,'task card must disappear');
   const transcript=await call('getTranscript',[sid]);const expected='Cancel the recurring loop with job ID `'+id+'` by calling CronDelete, then confirm.';
   const user=transcript.find(row=>row.type==='user'&&JSON.stringify(row.message?.content).includes(expected));assert.ok(user,'actual stop request missing from owning transcript');
   report.stopUserUuid=user.uuid||user.id;assert.match(report.stopUserUuid,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
   if(win)fs.writeFileSync(path.join(process.env.CLAUDE_CHECK_OUT,'loops-stop-complete.png'),(await win.webContents.capturePage()).toPNG());
   report.naturalStopProven=true;
  }else await waitTurn('LOOPS_PROOF_DELETE id='+id,id);
  const deleted=await findResult('CronDelete');report.deleteResult=String(deleted.result.content).slice(0,300);
  const after=await call('getSession',[sid]);report.loopsAfterDelete=after.loops;assert.ok(Array.isArray(after.loops));assert.ok(!after.loops.some(loop=>loop.id===id),'deleted Cron remains in session.loops');
  report.dom=await ev("(()=>{const m=document.querySelector('main');return m?(m.innerText||'').slice(-1200):''})()");report.checks={createToolSucceeded:true,createdInSessionLoops:true,getAllConsistent:true,createEventObserved:true,futureNextRunComputed:true,deleteToolSucceeded:true,removedFromSessionLoops:true,actualCcb:true,hidden:win?.isVisible()===false};
  const updatesAfter=await ev('window.__loopUpdates');const createdIndex=updatesAfter.findIndex(update=>update.loops?.some(row=>row.id===id));assert.ok(createdIndex>=0&&updatesAfter.slice(createdIndex+1).some(update=>Array.isArray(update.loops)&&update.loops.length===0),'no delete session_updated loop payload after create');report.checks.deleteEventObserved=true;
  if(report.naturalStopProven)Object.assign(report.checks,{actualStopButtonClicked:true,pendingStopObserved:true,naturalStopTurnCompleted:true,stopMessageUuidValid:true,taskCardRemoved:true,workspaceTrustAccepted:!!report.workspaceTrustDialog,activeCronPauseRefused:report.activeCronPauseRefused===true});
 }finally{await ev('window.__loopUnsubscribe?.();true');await call('delete',[sid]);}
}
module.exports={runSessionLoopsCheck};
