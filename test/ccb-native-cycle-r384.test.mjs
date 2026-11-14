import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createCcbKernel } = createRequire(import.meta.url)('../desktop/ccb-kernel.cjs');
const { createSessionKernel } = createRequire(import.meta.url)('../desktop/session-kernel.cjs');

// The control round trip releases a withheld idle deterministically. It also
// lets the test observe state after stdout has delivered every preceding frame.
function createFixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ccb-native-cycle-'));
  const entryPath=path.join(dir,'fixture.cjs');
  fs.writeFileSync(entryPath,String.raw`
const session_id=process.argv[process.argv.indexOf('--session-id')+1];
const out=frame=>process.stdout.write(JSON.stringify({session_id,...frame})+'\n');
const status=(state,extra)=>out({type:'system',subtype:'session_state_changed',state,...extra});
const result=(value,extra)=>out({type:'result',subtype:'success',uuid:value,result:value,stop_reason:'end_turn',...extra});
let sequence=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const f=JSON.parse(line);
  if(f.type==='control_request'){
    if(f.request.subtype==='mcp_status')status('idle');
    out({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{mcpServers:[]}}});
    return;
  }
  if(f.type!=='user')return;
  if(process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS!=='1')process.exit(3);
  sequence++;
  result('before-running');
  status('running');
  if(sequence===2)result('A');
  result('nested',{parent_tool_use_id:'tool-A'});
  result('foreign',{session_id:'foreign'});
  result(sequence===1?'A':'C');
  if(sequence===1)result('autonomous-B');
  status('idle',{session_id:'foreign'});
  out({type:'system',subtype:'fixture_checkpoint',sequence});
});`);
  const kernel=createCcbKernel({bunPath:process.execPath,entryPath,kernelRoot:dir,cwd:dir,homeDir:path.join(dir,'home'),
    scratchDir:path.join(dir,'scratch'),nativeCycleEvents:true,turnTimeoutMs:5000});
  t.after(()=>kernel.dispose());
  return {dir,kernel};
}

test('the pinned CCB lane waits for matching idle and isolates subsequent results', {timeout:15000}, async t => {
  const {kernel}=createFixture(t);
  const events=[];
  let checkpoint;
  kernel.onEvent(e=>{
    events.push(e);
    if(e.type==='raw' && e.frame.subtype==='fixture_checkpoint')checkpoint.resolve();
  });
  for(const [index,label] of ['A','C'].entries()){
    checkpoint=Promise.withResolvers();
    const run=kernel.sendMessage('host-session',label);
    await checkpoint.promise;
    assert.equal(events.filter(e=>e.type==='done').length,index);
    await assert.rejects(kernel.sendMessage('host-session','premature'),/already running/);
    const info=kernel.getInfo('host-session');
    await kernel.mcpServerStatus('host-session',info.actorToken);
    assert.equal((await run).text,label);
  }
  assert.deepEqual(events.filter(e=>e.type==='raw'&&e.frame.type==='result').map(e=>e.frame.result),['A','autonomous-B','C']);
  assert.deepEqual(events.filter(e=>e.type==='done').map(e=>e.text),['A','C']);
});

test('session emits one completion per host turn and releases an ordinary queued message after native idle', {timeout:15000}, async t=>{
  const {dir,kernel}=createFixture(t);
  const ui=[];
  const finished=Promise.withResolvers();
  const session=createSessionKernel({backend:kernel,emit:e=>{
    ui.push(e);
    if(e.type==='turn_finished' && e.text==='C')finished.resolve();
  }});
  t.after(()=>session.dispose());
  const {sessionId}=session.start({cwd:dir});
  const checkpoints=[Promise.withResolvers(),Promise.withResolvers()];
  kernel.onEvent(e=>{
    if(e.type==='raw' && e.frame.subtype==='fixture_checkpoint')checkpoints[e.frame.sequence-1].resolve();
  });
  const first=session.sendMessage(sessionId,'primary');
  await checkpoints[0].promise;
  await session.sendMessage(sessionId,'ordinary',{deferIfBusy:true,plainInput:true});
  assert.equal(ui.filter(e=>e.type==='turn_finished').length,0);
  assert.equal(session.getQueuedMessages(sessionId).length,1);
  const release=()=>kernel.mcpServerStatus(sessionId,kernel.getInfo(sessionId).actorToken);
  await release();
  assert.equal((await first).text,'A');
  const firstRows=ui.filter(e=>e.type==='message'&&['user','assistant'].includes(e.message?.type));
  assert.equal(firstRows[0]?.message.type,'user','user prompt must arrive before assistant snapshots');
  await checkpoints[1].promise;
  assert.deepEqual(ui.filter(e=>e.type==='turn_finished').map(e=>e.text),['A']);
  await release();
  await finished.promise;
  assert.deepEqual(ui.filter(e=>e.type==='turn_finished').map(e=>e.text),['A','C']);
  assert.deepEqual(session.getTranscript(sessionId).map(row=>row.message.content[0].text),['primary','A','ordinary','C']);
});

test('deleting the session during CLI cancellation cannot rekey input into a new actor with the same host id', {timeout:15000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ccb-steer-remove-'));
  const entryPath=path.join(dir,'fixture.cjs');
  fs.writeFileSync(entryPath,String.raw`
const cli=process.argv[process.argv.indexOf('--session-id')+1];
const out=f=>process.stdout.write(JSON.stringify({session_id:cli,...f})+'\n');
const sys=(subtype,props)=>out({type:'system',subtype,...props});
let cancel;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const f=JSON.parse(line);
  if(f.type==='control_request'){
    if(f.request.subtype==='cancel_async_message'){cancel=f.request_id;sys('cancel_received');return;}
    if(f.request.subtype==='interrupt' && cancel)out({type:'control_response',response:{request_id:cancel,subtype:'success',response:{cancelled:true}}});
    out({type:'control_response',response:{request_id:f.request_id,subtype:'success',response:{}}});return;
  }
  if(f.type!=='user')return;
  if(f.priority==='next'){sys('written_B');return;}
  sys('session_state_changed',{state:'running'});sys('init');
  if(f.message.content[0].text==='new'){
    out({type:'result',subtype:'success',uuid:'fresh-result',result:'fresh',stop_reason:'end_turn'});sys('session_state_changed',{state:'idle'});
  }else out({type:'assistant',message:{content:[{type:'tool_use',id:'open',name:'Read',input:{}}]}});
});`);
  const backend=createCcbKernel({bunPath:process.execPath,entryPath,kernelRoot:dir,cwd:dir,homeDir:path.join(dir,'home'),
    scratchDir:path.join(dir,'scratch'),nativeCycleEvents:true,turnTimeoutMs:5000});
  const ui=[],session=createSessionKernel({backend,emit:e=>ui.push(e)});
  t.after(async()=>{session.dispose();await backend.dispose()});
  const {sessionId}=session.start({cwd:dir}), oldActor=Promise.withResolvers(), written=Promise.withResolvers(), cancelling=Promise.withResolvers();
  backend.onEvent(e=>{
    if(e.type==='tool_request')oldActor.resolve();
    if(e.type==='raw' && e.frame.subtype==='written_B')written.resolve();
    if(e.type==='raw' && e.frame.subtype==='cancel_received')cancelling.resolve();
  });
  const first=session.sendMessage(sessionId,'old');await oldActor.promise;
  const oldToken=backend.getInfo(sessionId).actorToken, b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await session.sendMessage(sessionId,'only old actor owns B',{priority:'next',messageUuid:b});
  await written.promise;
  const control=session.sendSteeredNow(sessionId,b);await cancelling.promise;
  session.remove(sessionId);assert.equal(session.start({sessionId,cwd:dir}).sessionId,sessionId);
  assert.equal(await control,false);await first;
  assert.equal((await session.sendMessage(sessionId,'new')).text,'fresh');
  assert.notEqual(backend.getInfo(sessionId).actorToken,oldToken);
  assert.deepEqual(ui.filter(e=>e.type==='steers_rekeyed'||e.type==='steer_escalating'),[]);
  assert.deepEqual(session.getTranscript(sessionId).map(row=>row.message.content[0].text),['new','fresh']);
});
