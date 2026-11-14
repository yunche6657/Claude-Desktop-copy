'use strict';
const assert=require('node:assert/strict');
async function runWindowQuitCheck({phase,report,ev,win,screen,getActiveCcbProcesses}) {
 const area=screen.getPrimaryDisplay().workArea;
 report.workArea=area;report.initialBounds=win.getBounds();
 if(phase==='window-quit-seed') {
  const width=Math.min(1000,area.width),height=Math.min(700,area.height);
  const expected={x:area.x+Math.max(0,Math.floor((area.width-width)/2)),y:area.y+Math.max(0,Math.floor((area.height-height)/2)),width,height};
  assert.deepEqual(report.initialBounds,expected);
  report.offscreenRestored=true;
  win.setBounds({x:area.x+20,y:area.y+20,width:Math.min(900,area.width),height:Math.min(600,area.height)});
 } else {
  assert.equal(report.initialBounds.width,Math.min(900,area.width));
  assert.equal(report.initialBounds.height,Math.min(600,area.height));
  report.previousQuitStateRestored=true;
 }
 const s=await ev(`window['claude.web'].LocalSessions.start(${JSON.stringify({cwd:process.env.CLAUDE_WORKSPACE,title:'Hidden ordinary quit proof'})})`);
 report.childPid=getActiveCcbProcesses().find(c=>c.sessionId===s.sessionId)?.pid;
 assert.ok(report.childPid);report.expectedPersistedBounds=win.getBounds();
 report.realModelCalled=false;
}
module.exports={runWindowQuitCheck};
