// R385: a stop must hand back only what the host still holds.
//
// The stop path now calls the steer ledger's turn-boundary hand-back before the turn is
// aborted, and that hand-back skips entries already written to the CLI. Without the skip a
// stop would re-deliver an input the CLI already owns, and the model would see it twice.
//
// stop-held-r385.test.mjs can only observe the HELD half: its fixture answers with plain
// assistant text, so every steer stays on the host. This file covers the other half and the
// mixed case:
//
//   written-only      a tool call is open, so the input is dispatched at once. The stop must
//                     not park it, must not re-queue it, and the CLI must see it exactly once.
//   written-and-held  the tool result arrives (turn.tools empties), then a second input stays
//                     on the host. The stop must park exactly that one.
//
// The fixture mirrors the two protocol details the real CLI provides and this behaviour
// depends on: each accepted user frame is replayed back with isReplay:true (the ledger retires
// a written entry only on its own echo), and an interrupt is answered with a result frame
// followed by idle (that is what closes the native cycle).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../desktop/ccb-kernel.cjs',import.meta.url));
const {createCcbKernel}=require('./ccb-kernel.cjs');
const {createSessionKernel}=require('./session-kernel.cjs');

const WRITTEN='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const HELD='dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const CLI = String.raw`
const cli=process.argv[process.argv.indexOf('--session-id')+1];
const out=f=>process.stdout.write(JSON.stringify({session_id:cli,...f})+'\n');
const sys=(subtype,props)=>out({type:'system',subtype,...props});
let opened=false;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 if(f.type==='control_request'){
  out({type:'control_response',response:{request_id:f.request_id,subtype:'success',response:{mcpServers:[]}}});
  if(f.request.subtype==='interrupt'){
   out({type:'result',subtype:'success',uuid:'interrupt-result',result:'',stop_reason:'end_turn'});
   sys('session_state_changed',{state:'idle'});
  }
  return;
 }
 if(f.type!=='user')return;
 // Marker frame: proves the CLI itself received this input. The replay echo below returns
 // early in the kernel (it is an input-observation signal, not a transcript row), so it
 // cannot serve as this evidence.
 sys('user_frame',{uuid:f.uuid,priority:f.priority??null});
 // Real CLI behaviour: an accepted input is replayed back so the host can retire it.
 // session_id must be the CLI's own id, not the host session id in the inbound frame.
 out({...f,session_id:cli,isReplay:true});
 if(!opened){
  opened=true;
  sys('session_state_changed',{state:'running'});sys('init');
  out({type:'assistant',message:{content:[{type:'tool_use',id:'open',name:'Read',input:{}}]}});
  return;
 }
 if(f.message?.content?.[0]?.text==='unblock'){
  // A tool result arrives as a user frame; that is the branch which empties turn.tools.
  out({type:'user',parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:'open',content:'ok'}]}});
 }
});`;

for (const mode of ['written-only','written-and-held']) {
  test(`a stop never resends a steer the CLI already owns: ${mode}`, {timeout:20000}, async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r385-written-'));
    const entryPath=path.join(dir,'fixture.cjs');
    fs.writeFileSync(entryPath,CLI);
    const backend=createCcbKernel({bunPath:process.execPath,entryPath,kernelRoot:dir,cwd:dir,
      homeDir:path.join(dir,'home'),scratchDir:path.join(dir,'scratch'),nativeCycleEvents:true,turnTimeoutMs:5000});
    const events=[],session=createSessionKernel({backend,emit:e=>events.push(e)});
    t.after(async()=>{session.dispose();await backend.dispose();fs.rmSync(dir,{recursive:true,force:true})});

    const {sessionId}=session.start({cwd:dir});
    // steer_parked is a backend-level signal: session-kernel consumes it into the deferred
    // queue and does not forward it to the renderer, so it is collected from the hub.
    const parked=[],seen=[],toolReady=Promise.withResolvers(),writtenSeen=Promise.withResolvers(),
      toolClosed=Promise.withResolvers(),heldAccepted=Promise.withResolvers();
    backend.onEvent(e=>{
      if(e.type==='steer_parked')parked.push(e.frame.uuid);
      if(e.type==='raw'&&e.frame.subtype==='user_frame')seen.push(e.frame);
      if(e.type==='tool_request')toolReady.resolve();
      if(e.type==='tool_result')toolClosed.resolve();
      if(e.type==='steer_observed'&&e.frame?.uuid===WRITTEN)writtenSeen.resolve();
      if(e.type==='steer_accepted'&&e.frame?.uuid===HELD)heldAccepted.resolve();
    });

    const first=session.sendMessage(sessionId,'A');
    await toolReady.promise;

    // A tool call is open, so this steer goes to the CLI immediately and its echo retires it.
    await session.sendMessage(sessionId,'W',{priority:'next',messageUuid:WRITTEN});
    await writtenSeen.promise;
    assert.equal(backend.hasWrittenInputUuid(sessionId,WRITTEN),true,
      'the fixture never received the written steer, so this case proves nothing');

    if(mode==='written-and-held'){
      await session.sendMessage(sessionId,'unblock',{priority:'next'});
      await toolClosed.promise;
      // The tool is closed again, so this one stays on the host side.
      await session.sendMessage(sessionId,'H',{priority:'next',messageUuid:HELD});
      await heldAccepted.promise;
      assert.equal(backend.hasWrittenInputUuid(sessionId,HELD),false,
        'the held steer was written, so the mixed case degenerated into written-only');
      assert.deepEqual(backend.getSteerUuids(sessionId),[HELD],'the ledger does not hold exactly the held steer');
    }

    assert.equal(session.cancel(sessionId).ok,true);
    await first;

    const queued=session.getQueuedMessages(sessionId).map(row=>row.uuid);
    assert.ok(!parked.includes(WRITTEN),'a written steer was handed back to the host on stop');
    assert.ok(!queued.includes(WRITTEN),'a written steer re-entered the deferred queue');
    assert.equal(seen.filter(f=>f.uuid===WRITTEN).length,1,'the CLI received the written steer more than once');
    assert.equal(events.filter(e=>e.type==='message'&&e.message?.uuid===WRITTEN).length,1,
      'the written steer was announced to the renderer more than once');

    if(mode==='written-and-held'){
      assert.deepEqual(parked,[HELD],'the stop did not hand back exactly the held steer');
      // The parked entry does not sit in the queue: the turn's own teardown drains it into a
      // fresh turn, which is what the original does when it redispatches deferred sends after
      // a stop. Survival therefore shows up as exactly one arrival at the CLI, never two.
      const deadline=Date.now()+3000;
      while(!seen.some(f=>f.uuid===HELD)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
      assert.equal(seen.filter(f=>f.uuid===HELD).length,1,
        'the held steer did not reach the CLI exactly once after the stop');
    } else {
      assert.deepEqual(parked,[],'a stop with nothing held still parked something');
    }
  });
}
