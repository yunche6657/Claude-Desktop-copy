// R385: a rewind must not redeliver a steer the host is still holding.
//
// cancel(sessionId) serves two purposes:
//   - stop   (keepHeldInput defaults true): hand the held steer back so it survives;
//   - rewind (keepHeldInput:false):         discard it, because the rewind just dropped the
//                                           text that would be re-sent.
//
// Measured regression: with the hand-back unconditional, a rewind taken while a steer was held
// made the CLI receive that steer (fixture saw A then B) after the transcript had already been
// truncated to A. cancel-purpose-r385.test.mjs pins the kernel flag; THIS file pins the call
// site, through the real bridge channel — the line that has to pass the flag.
//
//   mutation: drop `{ keepHeldInput: false }` from bridge-services.cjs → this file goes red,
//   and (measured) nothing else does.
//
// The scenario has to be staged in this order or the test proves nothing:
//   1. a FIRST turn completes, so the transcript actually holds rows to rewind to. With an
//      empty transcript rewindCore answers `unknown_session` and never reaches cancel — the
//      assertion would then be vacuously true.
//   2. a SECOND turn opens and stays open, so the session is running when the rewind happens.
//   3. an input is held on the host during that second turn (no tool in flight → not written).
//   4. the rewind targets the first turn's row.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// A CCB-shaped fixture that reports every input it actually received, so delivery is measured
// on the wire rather than inferred from host state.
//   'A'  a complete turn (assistant text + result + idle) — this produces transcript rows
//   'C'  opens a turn and stays there, which is the state a rewind interrupts
//   else a complete turn in reply
const CLI = String.raw`
const cli=process.argv[process.argv.indexOf('--session-id')+1];
const out=f=>process.stdout.write(JSON.stringify({session_id:cli,...f})+'\n');
const sys=(subtype,props)=>out({type:'system',subtype,...props});
const finish=(text)=>{out({type:'assistant',message:{content:[{type:'text',text:text+' reply'}]}});
  out({type:'result',subtype:'success',uuid:text+'-result',result:text+' reply',stop_reason:'end_turn'});
  sys('session_state_changed',{state:'idle'});};
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
 if(text==='C'){out({type:'assistant',message:{content:[{type:'text',text:'partial'}]}});return;}
 finish(text);
});`;

const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('rewinding through the bridge does not redeliver a held steer', {timeout:30000}, async t=>{
  const {createCcbKernel}=require(path.join(ROOT,'desktop','ccb-kernel.cjs'));
  const {createSessionKernel}=require(path.join(ROOT,'desktop','session-kernel.cjs'));
  const {registerBridgeServices}=require(path.join(ROOT,'desktop','bridge-services.cjs'));

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r385-rewind-bridge-'));
  const entryPath=path.join(dir,'fixture.cjs');
  fs.writeFileSync(entryPath,CLI);
  const backend=createCcbKernel({bunPath:process.execPath,entryPath,kernelRoot:dir,cwd:dir,
    homeDir:path.join(dir,'home'),scratchDir:path.join(dir,'scratch'),nativeCycleEvents:true,turnTimeoutMs:5000});
  const kernel=createSessionKernel({backend,emit:()=>{},storePath:path.join(dir,'store.json')});

  const handlers=new Map();
  const bridge=registerBridgeServices({
    ipcMain:{handle:(c,fn)=>handlers.set(c,fn),removeHandler:c=>handlers.delete(c)},
    bridgeMap:require(path.join(ROOT,'desktop','shim','bridge-map.json')),
    getMainWindow:()=>({isDestroyed:()=>false,webContents:{send(){}}}),
    settings:{sidebarMode:'epitaxy',themeMode:'system',kernelFactory:()=>kernel},
    frontend:{root:ROOT},
  });
  t.after(async()=>{bridge.dispose();kernel.dispose();await backend.dispose();fs.rmSync(dir,{recursive:true,force:true})});

  const call=(service,method,...args)=>{
    const channel=[...handlers.keys()].find(c=>c.includes(`_$_${service}_$_`)&&c.endsWith(`_$_${method}`));
    if(!channel)throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({},...args);
  };

  const received=[],partial=Promise.withResolvers(),bAccepted=Promise.withResolvers(),
    firstDone=Promise.withResolvers();
  backend.onEvent(e=>{
    if(e.type==='raw'&&e.frame.subtype==='cli_got')received.push(e.frame.text);
    if(e.type==='text'&&e.text==='partial')partial.resolve();
    if(e.type==='steer_accepted'&&e.frame?.uuid===B)bAccepted.resolve();
    // A result frame is {type:'result',subtype:'success'}; matching on subtype would never fire
    // and the test would hang instead of failing on its assertion.
    if(e.type==='raw'&&e.frame.type==='result'&&e.frame.result==='A reply')firstDone.resolve();
  });

  const {sessionId}=kernel.start({cwd:dir});

  // 1. A complete first turn, so the transcript holds a row to rewind to.
  await kernel.sendMessage(sessionId,'A');
  await firstDone.promise;
  const seeded=kernel.getTranscript(sessionId);
  assert.ok(seeded.length>=2,'the first turn left no transcript rows; the rewind would never reach cancel');

  // 2. A second turn that stays open.
  const second=kernel.sendMessage(sessionId,'C');
  await partial.promise;

  // 3. An input held on the host: no tool is in flight, so the ledger holds it here.
  await kernel.sendMessage(sessionId,'B',{priority:'next',messageUuid:B});
  await bAccepted.promise;
  assert.equal(backend.hasWrittenInputUuid(sessionId,B),false,
    'B was written to the CLI, so there is nothing held for the rewind to mishandle');
  assert.ok(kernel.getQueuedMessages(sessionId).some(row=>row.uuid===B),'B is not shown as held');

  // 4. Rewind to the first turn's row.
  const answer=await call('LocalSessions','rewindV2',sessionId,seeded[0].uuid);
  assert.equal(answer.refusal,undefined,'the rewind was refused, so cancel never ran: '+JSON.stringify(answer));

  // The queue must already be clean the moment the rewind answers. Waiting for the turn to
  // settle first would let a late cleanup pass for a correct one: the entry could have been
  // sitting in the queue the whole time and only been cleared by the teardown.
  assert.deepEqual(kernel.getQueuedMessages(sessionId),[],
    'the rewound steer stayed in the queue after the rewind answered');
  assert.equal(backend.getSteerUuids(sessionId).includes(B),false,
    'the rewound steer stayed in the backend ledger after the rewind answered');

  await Promise.race([second,new Promise(r=>setTimeout(r,6000))]);
  await new Promise(r=>setTimeout(r,800));

  assert.ok(!received.includes('B'),
    'rewinding through the bridge redelivered a steer the user had just rewound past: '+JSON.stringify(received));
  assert.deepEqual(kernel.getQueuedMessages(sessionId),[],
    'the rewound steer was left in the queue to fire later');
});
