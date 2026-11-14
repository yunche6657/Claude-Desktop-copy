import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {parseClaudeEvent,startClaude} from '../engine.mjs';
test('partial stream avoids final assistant duplication',()=>{const out=[],state={};parseClaudeEvent({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'hello'}}},state,e=>out.push(e));parseClaudeEvent({type:'assistant',message:{content:[{type:'text',text:'hello'}]}},state,e=>out.push(e));assert.equal(out.length,1);assert.throws(()=>parseClaudeEvent({type:'result',is_error:true},state,()=>{}));});
function fake(){const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.kill=()=>{c.killed=true;};return c;}
test('adapter handles chunks and stdin without shell',async()=>{const c=fake(),out=[];let done;const finished=new Promise(r=>done=r);startClaude({executable:'fixture',prompt:'user: hi',spawnImpl:(exe,args,opts)=>{assert.equal(opts.shell,false);assert.ok(args.includes('--bare'));assert.ok(args.includes('--tools'));return c;},onEvent:e=>out.push(e),onFinish:done});c.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n');c.stdout.write('{"type":"result","is_error":false}\n');c.emit('close',0);assert.equal(await finished,'completed');assert.equal(out[0].text,'ok');assert.equal(c.stdin.read().toString(),'user: hi');});
test('cancel is terminal exactly once',()=>{const c=fake(),statuses=[];const task=startClaude({executable:'fixture',prompt:'hi',spawnImpl:()=>c,onEvent:()=>{},onFinish:s=>statuses.push(s)});task.cancel();c.emit('close',1);assert.deepEqual(statuses,['cancelled']);assert.equal(c.killed,true);});
test('spawn failure is reported',()=>{const statuses=[],events=[];startClaude({executable:'fixture',prompt:'hi',spawnImpl:()=>{throw Error('missing');},onEvent:e=>events.push(e),onFinish:s=>statuses.push(s)});assert.deepEqual(statuses,['error']);assert.equal(events[0].type,'error');});
test('authentication failure from the real CLI is an error, not assistant prose',()=>{
  const events=[];
  let message;
  try{parseClaudeEvent({type:'assistant',error:'authentication_failed',message:{content:[{type:'text',text:'Not logged in'}]}},{},e=>events.push(e));}catch(error){message=error.message;}
  assert.match(message,/未登录/);
  assert.deepEqual(events,[]);
  assert.throws(()=>parseClaudeEvent({type:'result',is_error:true,result:'Not logged in'},{} ,()=>{}),/失败/);
});
