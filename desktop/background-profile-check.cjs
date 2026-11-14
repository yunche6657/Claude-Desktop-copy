'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
async function runProfileCheck({phase,out,report,ev,getActiveCcbProcesses,getCcbRuntimeInfo,app,win}) {
 if(process.env.CLAUDE_PROOF_RELAUNCH_ARGS==='1') report.argv=process.argv.slice(1);
 const windowProof=process.env.CLAUDE_PROOF_WINDOW_RESET==='1';
 const windowFile=path.join(app.getPath('userData'),'window-state.json');
 const markerFile=path.join(app.getPath('userData'),'config.json');
 if(windowProof){
  report.initialBounds=win.getBounds();
  assert.equal(report.initialBounds.width,phase==='profile-apply'?1000:1200);
  assert.equal(report.initialBounds.height,phase==='profile-apply'?700:800);
 }
 const call=(service,method,args=[])=>ev(`window['claude.settings'][${JSON.stringify(service)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`);
 const local=(method,args=[])=>ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
 const expected=phase==='profile-apply'?'R363_PROFILE_ALPHA':'R363_PROFILE_BETA';
 const start=await local('start',[{cwd:process.env.CLAUDE_WORKSPACE}]);report.sessionId=start.sessionId;
 const turn=async()=>{
  const result=await local('sendMessage',[start.sessionId,'Reply with exactly: '+expected+'. Use no tools.']);
  assert.equal(result.ok,true);assert.equal(result.text.trim(),expected);
 };
 await turn();
 report.childPid=getActiveCcbProcesses().find(c=>c.sessionId===start.sessionId)?.pid;
 assert.ok(report.childPid);report.model=process.env.CLAUDE_AGENT_MODEL;
 report.backend=getCcbRuntimeInfo().selection.id;assert.equal(report.backend,'ccb');
 if(phase==='profile-apply') {
  const result=await ev(`window['claude.settings'].Custom3pSetup.setAppliedConfig('22222222-2222-4222-8222-222222222222').then(value=>({undefinedResult:value===undefined}))`);
  assert.equal(result.undefinedResult,true);
  if(windowProof){
   assert.equal(fs.existsSync(windowFile),false);
   const marker=JSON.parse(fs.readFileSync(markerFile,'utf8'));
   assert.equal(Object.hasOwn(marker,'windowSizeWasSignedIn'),false);assert.equal(marker.preservedField,'R364');
   assert.deepEqual(win.getBounds(),report.initialBounds);
   const config=await call('AppConfig','getAppConfig');assert.equal(config.deploymentMode,'3p');
   report.modeCacheUpdated=true;report.windowStateDiscarded=true;report.markerPreservedOtherKeys=true;report.currentBoundsUnchanged=true;
  }
  await turn();report.oldActorStillUsesPreviousProfile=true;
  report.ok=true;fs.writeFileSync(path.join(out,phase+'.json'),JSON.stringify(report,null,2));
  process.env.CLAUDE_CHECK_PHASE='profile-relaunched';
  await call('Custom3pSetup','relaunchApp');
  return 'relaunching';
 }
 const old=JSON.parse(fs.readFileSync(path.join(out,'profile-apply.json'),'utf8'));
 assert.notEqual(report.pid,old.pid);assert.notEqual(report.childPid,old.childPid);
 let alive=false;try{process.kill(old.childPid,0);alive=true;}catch{}
 assert.equal(alive,false,'old CCB must terminate before the next process');
 report.previousChildStopped=true;report.newProfileLoaded=true;
 if(windowProof)report.defaultBoundsRestored=true;
 assert.equal(report.model,'deepseek-v4-pro');
 const meta=JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA,'Claude-3p/configLibrary/_meta.json'),'utf8'));
 assert.equal(meta.appliedId,'22222222-2222-4222-8222-222222222222');
}
module.exports={runProfileCheck};
