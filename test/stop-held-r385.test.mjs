// R385: a stop must not drop an input the host is still holding.
//
// Measured before the fix: 'A' opens a turn, 'B' is sent as a mid-turn steer while no tool is
// in flight (so the ledger HOLDS it on this side), then the user stops. B vanished — it was
// never written to the CLI, so the CLI could never replay it, and the turn that owned the
// steer ledger was torn down right after. The original main bundle does not do this:
// interruptSession calls transferHeldSteersToDeferred before stopping.
//
// What each mode proves, stated so it cannot be over-read later:
//
//   one / two / withdraw  B (and C) are HELD on the host, the stop hands them back, and each
//                         reaches the model exactly once. "Exactly once" is counted by the
//                         reply TEXT, not by uuid: a duplicate delivery would be re-keyed by
//                         session-kernel and would escape a uuid-shaped assertion.
//   delete                after remove + restart the parked entry must not resurrect. Asserted
//                         with a probe message, so an empty transcript cannot pass by accident.
//
// NOT covered here: an input already WRITTEN to the CLI. This fixture answers with plain
// assistant text, so turn.tools is always empty and every steer is held. The written half is
// covered by stop-park-world-r385.test.mjs, which counts the frames the CLI actually received.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../desktop/ccb-kernel.cjs',import.meta.url));
const {createCcbKernel}=require('./ccb-kernel.cjs');
const {createSessionKernel}=require('./session-kernel.cjs');

// The fixture asserts the two preconditions this behaviour depends on and reports a violation
// as a frame, so a silent change to the kernel wiring becomes a named failure rather than a
// quietly different scenario. ccb-native-cycle-r384.test.mjs checks the env the same way.
const CLI = String.raw`
const cli=process.argv[process.argv.indexOf('--session-id')+1];
const out=f=>process.stdout.write(JSON.stringify({session_id:cli,...f})+'\n');
const sys=(subtype,props)=>out({type:'system',subtype,...props});
if(!process.argv.includes('--replay-user-messages'))sys('precondition_failed',{what:'argv --replay-user-messages'});
if(process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS!=='1')sys('precondition_failed',{what:'env CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS'});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 if(f.type==='control_request'){
  out({type:'control_response',response:{request_id:f.request_id,subtype:'success',response:{mcpServers:[]}}});
  if(f.request.subtype==='interrupt'){out({type:'result',subtype:'success',uuid:'interrupt-result',result:'',stop_reason:'end_turn'});sys('session_state_changed',{state:'idle'});}
  return;
 }
 if(f.type==='user'){
  sys('session_state_changed',{state:'running'});sys('init');
  const text=f.message.content[0].text;
  if(text!=='A'){
   out({type:'assistant',message:{content:[{type:'text',text:text+' reply'}]}});
   out({type:'result',subtype:'success',uuid:text+'-result',result:text+' reply',stop_reason:'end_turn'});
   sys('session_state_changed',{state:'idle'});
  } else out({type:'assistant',message:{content:[{type:'text',text:'partial'}]}});
 }
});`;

const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C='cccccccc-cccc-4ccc-8ccc-cccccccccccc';

for (const mode of ['one','two','withdraw','delete']) {
  test(`stop hands back a held steer: ${mode}`, {timeout:20000}, async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r385-stop-')), entry=path.join(dir,'fixture.cjs');
    fs.writeFileSync(entry,CLI);
    const backend=createCcbKernel({bunPath:process.execPath,entryPath:entry,kernelRoot:dir,cwd:dir,
      homeDir:path.join(dir,'home'),scratchDir:path.join(dir,'scratch'),nativeCycleEvents:true,turnTimeoutMs:5000});
    const events=[],session=createSessionKernel({backend,emit:e=>events.push(e)});
    t.after(async()=>{session.dispose();await backend.dispose();fs.rmSync(dir,{recursive:true,force:true})});

    const {sessionId}=session.start({cwd:dir});
    const partial=Promise.withResolvers(),bAccepted=Promise.withResolvers(),
      cAccepted=Promise.withResolvers(),bReplied=Promise.withResolvers();
    backend.onEvent(e=>{
      if(e.type==='text'&&e.text==='partial')partial.resolve();
      if(e.type==='steer_accepted'&&e.frame?.uuid===B)bAccepted.resolve();
      if(e.type==='steer_accepted'&&e.frame?.uuid===C)cAccepted.resolve();
      if(e.type==='raw'&&e.frame?.type==='result'&&e.frame.result==='B reply')bReplied.resolve();
    });

    const first=session.sendMessage(sessionId,'A');
    await partial.promise;
    assert.deepEqual(events.filter(e=>e.type==='meta'||e.type==='precondition_failed')
      .filter(e=>e.type==='precondition_failed'),[],
      'the fixture did not get the native-cycle wiring this behaviour depends on');

    // B is sent while no tool call is in flight, so the ledger holds it on this side.
    await session.sendMessage(sessionId,'B',{priority:'next',messageUuid:B});
    await bAccepted.promise;
    assert.equal(backend.hasWrittenInputUuid(sessionId,B),false,
      'B was written to the CLI, so this is no longer the held-input scenario');

    if(mode==='two'||mode==='withdraw'){
      await session.sendMessage(sessionId,'C',{priority:'next',messageUuid:C});
      await cAccepted.promise;
    }
    if(mode==='withdraw')assert.equal(await session.cancelQueuedMessage(sessionId,C),true);

    const expected=mode==='two'?[B,C]:[B];
    assert.deepEqual(session.getQueuedMessages(sessionId).map(x=>x.uuid),expected,
      'the queued view is not what this mode expects before the stop');

    assert.equal(session.cancel(sessionId).ok,true);
    await first;

    if(mode==='delete'){
      session.remove(sessionId);
      session.start({sessionId,cwd:dir});
      await session.sendMessage(sessionId,'probe');
      const rows=session.getTranscript(sessionId);
      assert.deepEqual(rows.filter(r=>r.type==='user').map(r=>r.message?.content?.[0]?.text),['probe'],
        'a parked entry from the deleted session reappeared after the restart');
      assert.deepEqual(session.getQueuedMessages(sessionId),[]);
      return;
    }

    await bReplied.promise;
    // The result frame and the transcript row it produces are not the same observation point.
    // Wait for the row itself rather than assuming it is already there.
    const textRows=()=>session.getTranscript(sessionId).filter(r=>r.message?.content?.[0]?.text);
    const deadline=Date.now()+5000;
    while(!textRows().some(r=>r.message.content[0].text==='B reply')&&Date.now()<deadline)
      await new Promise(r=>setTimeout(r,20));
    const rows=session.getTranscript(sessionId);
    // Counted by text: a duplicate delivery would be re-keyed by session-kernel and would pass
    // any uuid-shaped assertion.
    assert.equal(rows.filter(r=>r.message?.content?.[0]?.text==='B reply').length,1,
      'B did not reach the model exactly once');
    assert.equal(rows.filter(r=>r.message?.content?.[0]?.text==='C reply').length,Number(mode==='two'),
      'C reached the model the wrong number of times');
    assert.equal(rows.filter(r=>r.type==='user'&&r.uuid===B).length,1,'B appears as more than one prompt');
    assert.deepEqual(backend.getSteerUuids(sessionId),[],'the ledger still holds a steer after the turn');
  });
}
