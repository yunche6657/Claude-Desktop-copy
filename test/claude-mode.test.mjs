import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server.mjs';

async function start(options){const server=createApp(options);server.listen(0,'127.0.0.1');await once(server,'listening');return server;}
const post=(base,route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('claude mode streams adapter events, persists them and reports config',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'desktop-claude-'));
  const calls=[];
  const engine=({executable,prompt,onEvent,onFinish})=>{
    calls.push({executable,prompt});
    setImmediate(()=>{onEvent({type:'text',text:'真实流片段'});onEvent({type:'status',status:'running'});onFinish('completed');});
    return {cancel(){calls.push({cancelled:true});}};
  };
  const server=await start({dataDir:dir,mode:'claude',executable:'C:\\fixture\\claude.exe',engine});
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const config=await (await fetch(base+'/api/config')).json();
  assert.equal(config.mode,'claude');
  assert.equal(config.tools,'disabled');
  assert.equal(config.authentication,'explicit-environment');
  assert.equal(JSON.stringify(config).includes('fixture'),false);
  const session=await (await post(base,'/api/sessions',{title:'Claude'})).json();
  const {runId}=await (await post(base,`/api/sessions/${session.id}/messages`,{text:'你好'})).json();
  const stream=await (await fetch(base+`/api/runs/${runId}/events`)).text();
  const events=stream.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
  assert.deepEqual(events.filter(e=>e.type==='text'),[{type:'text',text:'真实流片段'}]);
  assert.deepEqual(events.at(-1),{type:'done'});
  assert.equal(calls[0].executable,'C:\\fixture\\claude.exe');
  assert.match(calls[0].prompt,/user: 你好/);
  const saved=await (await fetch(base+`/api/sessions/${session.id}`)).json();
  assert.equal(saved.messages.at(-1).content,'真实流片段');
  assert.equal(saved.messages.at(-1).status,'completed');
});

test('claude mode requires an explicit executable and cancels adapter runs',async t=>{
  assert.throws(()=>createApp({dataDir:os.tmpdir(),mode:'claude'}),/CLAUDE_EXECUTABLE/);
  const dir=await mkdtemp(path.join(os.tmpdir(),'desktop-claude-'));
  const cancelled=[];
  const engine=()=>({cancel:()=>cancelled.push(true)});
  const server=await start({dataDir:dir,mode:'claude',executable:'fixture',engine});
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const session=await (await post(base,'/api/sessions',{title:'c'})).json();
  const {runId}=await (await post(base,`/api/sessions/${session.id}/messages`,{text:'stop'})).json();
  const response=await post(base,`/api/runs/${runId}/cancel`,{});
  assert.equal((await response.json()).status,'cancelled');
  assert.equal(cancelled.length,1);
});
