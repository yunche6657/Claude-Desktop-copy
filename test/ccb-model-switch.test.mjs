import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCcbKernel } = require('../desktop/ccb-kernel.cjs');

test('active model control is acknowledged before the turn finishes and failed controls recover safely', {timeout:15000}, async t => {
 const dir=mkdtempSync(path.join(tmpdir(),'ccb-control-'));
 const script=path.join(dir,'fake.cjs');
 writeFileSync(script, String.raw`
 const readline=require('node:readline'),fs=require('node:fs'),path=require('node:path'); let model=process.argv[process.argv.indexOf('--model')+1], active=false;
 const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const f=JSON.parse(line);
  if(f.type==='control_request'){
   if(f.request.subtype==='initialize') return out({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{}}});
   if(f.request.subtype==='interrupt'){out({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{}}});if(active){active=false;out({type:'result',subtype:'success',result:'cancelled'});}return;}
   if(f.request.subtype==='set_model'){
    fs.appendFileSync(path.join(__dirname,'controls.log'),f.request.model+'\n');
    if(f.request.model==='timeout') return;
    if(f.request.model==='delayed') return setTimeout(()=>{model='delayed';out({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{}}});},40);
    if(f.request.model==='reject') return out({type:'control_response',response:{subtype:'error',request_id:f.request_id,error:'rejected'}});
    model=f.request.model; return out({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{}}});
   }
  }
  if(f.type==='user') {active=true;const slow=Array.isArray(f.message?.content) && f.message.content.some(block => block.type === 'text' && block.text === 'slow');if(!slow){active=false;out({type:'result',subtype:'success',result:model});}}
 });`);
 const kernel=createCcbKernel({bunPath:process.execPath,entryPath:script,kernelRoot:dir,cwd:dir,homeDir:path.join(dir,'home'),scratchDir:path.join(dir,'scratch'),modelControlTimeoutMs:100,interruptGraceMs:100,model:'backend-default'});
 t.after(async()=>kernel.dispose());
 kernel.start({sessionId:'legacy'});
 assert.equal((await kernel.sendMessage('legacy','hi')).text,'backend-default');
 assert.equal(kernel.getInfo('legacy').confirmedModel,'backend-default');
 await assert.rejects(kernel.setModel('legacy','reject'),e=>e.code==='CCB_CONTROL_REJECTED'&&e.confirmedModel==='backend-default');
 assert.equal(kernel.getInfo('legacy').confirmedModel,'backend-default');
 kernel.start({sessionId:'a',model:'first'});
 const first=await kernel.sendMessage('a','hi',{model:'first'}); assert.equal(first.text,'first');
 const pid=kernel.getInfo('a').pid;
 const turn=kernel.sendMessage('a','slow',{model:'first'});
 await new Promise(r=>setTimeout(r,50));
 const change=kernel.setModel('a','delayed');
 const next=kernel.setModel('a','second');
 await Promise.all([change,next]);
 assert.equal(kernel.cancel('a').ok,true); assert.equal(kernel.cancel('a').ok,false);
 await turn;
 const second=await kernel.sendMessage('a','hi',{model:'first'}); assert.equal(second.text,'second'); assert.equal(kernel.getInfo('a').pid,pid);
 await assert.rejects(kernel.setModel('a','reject'),e => e.code === 'CCB_CONTROL_REJECTED');
 assert.equal((await kernel.sendMessage('a','hi',{model:'second'})).text,'second');
 assert.equal(kernel.getInfo('a').pid,pid);
 await assert.rejects(kernel.setModel('a','timeout'),e => e.code === 'CCB_CONTROL_TIMEOUT');
 await assert.rejects(kernel.sendMessage('a','hi',{model:'second'}),/no verified native transcript/);
 const saved=kernel.getInfo('a').persistence;
 const project=path.join(saved.homeDir,'projects',dir.replace(/[^a-zA-Z0-9]/g,'-')); mkdirSync(project,{recursive:true});
 writeFileSync(path.join(project,saved.cliSessionId+'.jsonl'),JSON.stringify({sessionId:saved.cliSessionId,cwd:dir,type:'user',message:{role:'user',content:'hi'}})+'\n');
 const restored=await kernel.sendMessage('a','after failure',{model:'second'});
 assert.equal(restored.text,'second'); assert.notEqual(kernel.getInfo('a').pid,pid);

 kernel.start({sessionId:'b',model:'first'}); await kernel.sendMessage('b','hi',{model:'first'});
 await assert.rejects(kernel.setModel('b','timeout'),/did not answer/);
 await assert.rejects(kernel.sendMessage('b','hi',{model:'first'}),/no verified native transcript/);
 kernel.start({sessionId:'empty',model:'first'});
 await assert.rejects(kernel.setModel('empty','timeout'),/did not answer/);
 await kernel.setModel('empty','first');
 assert.equal((await kernel.sendMessage('empty','hi',{model:'first'})).text,'first');
 writeFileSync(path.join(dir,'controls.log'),'');
 kernel.start({sessionId:'remove',model:'first'});
 const removedTurn=kernel.sendMessage('remove','slow',{model:'first'}).catch(e=>e);
 await new Promise(r=>setTimeout(r,40));
 const pending=kernel.setModel('remove','delayed').catch(e=>e);
 const queued=kernel.setModel('remove','second_after_delete').catch(e=>e);
 const log=path.join(dir,'controls.log');
 for(let i=0;i<100 && (!existsSync(log) || !readFileSync(log,'utf8').includes('delayed\n'));i++) await new Promise(r=>setTimeout(r,2));
 assert.ok(readFileSync(log,'utf8').includes('delayed\n'));
 assert.equal(kernel.removeSession('remove').ok,true);
 assert.equal((await pending).code,'CCB_SESSION_REMOVED');
 assert.equal((await queued).code,'CCB_SESSION_REMOVED');
 assert.equal((await removedTurn).code,'CCB_SESSION_REMOVED');
 kernel.start({sessionId:'remove',model:'first'});
 assert.equal((await kernel.sendMessage('remove','hi',{model:'first'})).text,'first');
 assert.equal(readFileSync(log,'utf8').includes('second_after_delete\n'),false);
 const controller=new AbortController();controller.abort();
 await assert.rejects(kernel.sendMessage('c','do not send',{model:'first',signal:controller.signal}),/cancelled before/);
 assert.equal(kernel.getInfo('c').pid,null);
});
