// R385: `cancel()` has two purposes and they must not share one behaviour.
//
// The stop path and the rewind path both call kernel.cancel(sessionId). The stop path must
// hand a host-held steer back so it survives; a rewind must NOT, because it drops every row
// after its target and the held steer is text the user just rewound past.
//
// Measured regression: with the hand-back unconditional, rewinding while a steer was held
// delivered it to the model — the fixture received A then B after the transcript had already
// been truncated to A. The fix is the keepHeldInput flag; this file pins both directions, so
// making the flag unconditional in either direction turns one of them red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../desktop/ccb-kernel.cjs',import.meta.url));
const {createCcbKernel}=require('./ccb-kernel.cjs');
const {createSessionKernel}=require('./session-kernel.cjs');

const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// The fixture reports every input it actually received, so "was it delivered" is measured on
// the wire rather than inferred from host state.
const CLI = String.raw`
const cli=process.argv[process.argv.indexOf('--session-id')+1];
const out=f=>process.stdout.write(JSON.stringify({session_id:cli,...f})+'\n');
const sys=(subtype,props)=>out({type:'system',subtype,...props});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 if(f.type==='control_request'){
  out({type:'control_response',response:{request_id:f.request_id,subtype:'success',response:{mcpServers:[]}}});
  if(f.request.subtype==='interrupt'){out({type:'result',subtype:'success',uuid:'interrupt-result',result:'',stop_reason:'end_turn'});sys('session_state_changed',{state:'idle'});}
  return;
 }
 if(f.type!=='user')return;
 const text=f.message.content[0].text;
 sys('cli_got',{text:text,uuid:f.uuid});
 sys('session_state_changed',{state:'running'});sys('init');
 if(text!=='A'){
  out({type:'assistant',message:{content:[{type:'text',text:text+' reply'}]}});
  out({type:'result',subtype:'success',uuid:text+'-result',result:text+' reply',stop_reason:'end_turn'});
  sys('session_state_changed',{state:'idle'});
 } else out({type:'assistant',message:{content:[{type:'text',text:'partial'}]}});
});`;

for (const purpose of ['stop','rewind']) {
  test(`cancel(${purpose}) decides whether a held steer is redelivered`, {timeout:20000}, async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r385-cancel-'));
    const entryPath=path.join(dir,'fixture.cjs');
    fs.writeFileSync(entryPath,CLI);
    const backend=createCcbKernel({bunPath:process.execPath,entryPath,kernelRoot:dir,cwd:dir,
      homeDir:path.join(dir,'home'),scratchDir:path.join(dir,'scratch'),nativeCycleEvents:true,turnTimeoutMs:5000});
    const session=createSessionKernel({backend,emit:()=>{}});
    t.after(async()=>{session.dispose();await backend.dispose();fs.rmSync(dir,{recursive:true,force:true})});

    const received=[],partial=Promise.withResolvers(),bAccepted=Promise.withResolvers();
    backend.onEvent(e=>{
      if(e.type==='raw'&&e.frame.subtype==='cli_got')received.push(e.frame.text);
      if(e.type==='text'&&e.text==='partial')partial.resolve();
      if(e.type==='steer_accepted'&&e.frame?.uuid===B)bAccepted.resolve();
    });

    const {sessionId}=session.start({cwd:dir});
    const first=session.sendMessage(sessionId,'A');
    await partial.promise;
    await session.sendMessage(sessionId,'B',{priority:'next',messageUuid:B});
    await bAccepted.promise;
    assert.equal(backend.hasWrittenInputUuid(sessionId,B),false,
      'B was written to the CLI, so there is nothing held to test');
    assert.ok(session.getQueuedMessages(sessionId).some(row=>row.uuid===B),'B is not shown as held');

    if(purpose==='rewind'){
      // What rewindCore does: keep the target row, drop the rest, then cancel because the
      // session still shows a spinner. The row identity does not matter here — what matters is
      // that the rewind happened before the stop, since that is when the text is discarded.
      const rows=session.getTranscript(sessionId);
      session.setTranscript(sessionId,rows.slice(0,Math.max(1,rows.length-1)).map(r=>({...r})));
      session.cancel(sessionId,{keepHeldInput:false});
    } else {
      session.cancel(sessionId);
    }
    await Promise.race([first,new Promise(r=>setTimeout(r,6000))]);
    await new Promise(r=>setTimeout(r,600));

    if(purpose==='rewind'){
      assert.deepEqual(received,['A'],
        'a rewind redelivered text the user had just rewound past');
      assert.deepEqual(session.getQueuedMessages(sessionId),[],
        'a rewound steer was left in the queue to fire later');
    } else {
      assert.deepEqual(received,['A','B'],'the stop did not hand the held steer back exactly once');
    }
  });
}
