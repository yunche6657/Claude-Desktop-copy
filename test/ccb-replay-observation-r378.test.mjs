import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createCcbKernel } = createRequire(import.meta.url)('../desktop/ccb-kernel.cjs');
const { createSessionKernel } = createRequire(import.meta.url)('../desktop/session-kernel.cjs');

const fake = String.raw`
const readline=require('node:readline');
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
const replay=process.argv.includes('--replay-user-messages');
if(process.env.OLD_CLI==='1'&&replay){process.stderr.write('unknown option\n');process.exit(2)}
out({type:'system',subtype:'init',session_id:'fake'});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 if(f.type==='control_request') {out({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{}}});return}
 if(f.type!=='user')return;
 if(JSON.stringify(f.message?.content).includes('EXIT_BEFORE_REPLAY'))process.exit(9);
 if(replay){const row={type:'user',isReplay:true,uuid:f.uuid,message:{role:'user',content:[{type:'tool_result',tool_use_id:'fake',content:'must not publish'}]}};
  out(row);out(row);out({...row,uuid:'unmatched'});
 }
 out({type:'user',uuid:'tool-result',message:{role:'user',content:[{type:'tool_result',tool_use_id:'actual',content:'ok'}]}});
 out({type:'assistant',message:{content:[{type:'text',text:'done'}]}});
 out({type:'result',subtype:'success',result:'done',stop_reason:'end_turn'});
});`;
function kernel(opts={}) {
 const dir=mkdtempSync(path.join(tmpdir(),'ccb-replay-'));const entryPath=path.join(dir,'cli-bun.js');writeFileSync(entryPath,fake);
 return createCcbKernel({bunPath:process.execPath,entryPath,kernelRoot:dir,startupTimeoutMs:5000,turnTimeoutMs:5000,disposeTimeoutMs:1000,...opts});
}

test('replay observes a written UUID once, never reaches raw or tool transcript events', async t=>{
 const k=kernel({replayUserMessages:true});t.after(()=>k.dispose());const events=[];const off=k.onEvent(e=>events.push(e));
 const id='99bb0f4b-46fa-40b9-909e-5e3bf28b8d69';
 const result=await k.sendMessage('s','test',{cwd:tmpdir(),messageUuid:id});
 assert.equal(result.text,'done');
 const observed=events.filter(e=>e.type==='user_input_observed');assert.equal(observed.length,1);
 assert.equal(observed[0].messageUuid,id);assert.equal(observed[0].sessionId,'s');assert.equal(typeof observed[0].actorToken,'string');
 assert.equal(events.filter(e=>e.type==='raw'&&e.frame?.isReplay===true).length,0);
 assert.deepEqual(events.filter(e=>e.type==='tool_result').map(e=>e.id),['actual']);off();
});

test('legacy CLI receives no optional flag by default and completes its turn', async t=>{
 const k=kernel({env:{OLD_CLI:'1'}});t.after(()=>k.dispose());const events=[];k.onEvent(e=>events.push(e));
 assert.equal((await k.sendMessage('s','test',{cwd:tmpdir()})).text,'done');
 assert.equal(events.some(e=>e.type==='user_input_observed'),false);
});

test('explicit opt-in against an unsupported CLI fails without inventing observation', async t=>{
 const k=kernel({env:{OLD_CLI:'1'},replayUserMessages:true});t.after(()=>k.dispose());const events=[];k.onEvent(e=>events.push(e));
 await assert.rejects(k.sendMessage('s','test',{cwd:tmpdir()}));
 assert.equal(events.some(e=>e.type==='user_input_observed'),false);
});

test('exit before replay does not manufacture an observation', async t=>{
 const k=kernel({replayUserMessages:true});t.after(()=>k.dispose());const events=[];k.onEvent(e=>events.push(e));
 await assert.rejects(k.sendMessage('s','EXIT_BEFORE_REPLAY',{cwd:tmpdir()}));
 assert.equal(events.some(e=>e.type==='user_input_observed'),false);
});

test('session transcript retains one prompt and one real tool result when replay is enabled', async t=>{
 const backend=kernel({replayUserMessages:true});
 const session=createSessionKernel({backend,emit() {}});t.after(async()=>{session.dispose();await backend.dispose()});
 const opened=session.start({cwd:tmpdir()});
 const result=await session.sendMessage(opened.sessionId,'PROMPT_ONCE');assert.equal(result.ok,true);
 const rows=session.getTranscript(opened.sessionId);
 assert.equal(rows.filter(row=>row.type==='user'&&JSON.stringify(row.message).includes('PROMPT_ONCE')).length,1);
 assert.equal(rows.filter(row=>JSON.stringify(row.message).includes('must not publish')).length,0);
 assert.equal(rows.filter(row=>JSON.stringify(row.message).includes('"tool_use_id":"actual"')).length,1);
});
