import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCcbKernel } = require('../desktop/ccb-kernel.cjs');
function setup(extra = {}) {
 const dir = mkdtempSync(path.join(tmpdir(), 'ccb-admit-'));
 const script = path.join(dir, 'mock.cjs');
 writeFileSync(script, String.raw`
 const readline = require('node:readline'), fs = require('node:fs'), path = require('node:path');
 fs.appendFileSync(path.join(__dirname,'argv.log'),JSON.stringify(process.argv)+'\n');
 const send=x=>process.stdout.write(JSON.stringify(x)+'\n');let initialized=false;
 readline.createInterface({input:process.stdin}).on('line',l=>{const f=JSON.parse(l);
 if(f.type==='control_request') {
  if(f.request.subtype==='initialize'&&initialized)send({type:'control_response',response:{subtype:'error',request_id:f.request_id,error:'Already initialized'}});
  else {if(f.request.subtype==='initialize')initialized=true;send({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{models:[]}}});}
 }
 if(f.type==='user' && (typeof f.message?.content==='string'?f.message.content:f.message?.content?.find(b=>b.type==='text')?.text)!=='hold') send({type:'result',subtype:'success',result:'ok'});
 });`);
 return { dir, kernel: createCcbKernel({bunPath:process.execPath,entryPath:script,kernelRoot:dir,cwd:dir,disposeTimeoutMs:200,...extra}) };
}
test('admission is shared across concurrent calls and released after spawn; warm yield is retryable', async t => {
 let resolveSlot, releases=0, calls=[];
 const {kernel}=setup({acquireSlot: arg=>{calls.push(arg.reason); if(arg.sessionId==='yield') return {yielded:true,release(){releases++}}; return new Promise(r=>{resolveSlot=r})}});
 t.after(()=>kernel.dispose());
 const a=kernel.warm('a'); const b=kernel.initialize('a');
 await new Promise(r=>setTimeout(r,10)); assert.deepEqual(calls,['warm']);
 resolveSlot({yielded:false,release(){releases++}});
 await Promise.all([a,b]); assert.equal(releases,1); assert.equal(kernel.getActiveProcesses().length,1);
 await assert.rejects(kernel.warm('yield',{reason:'prewarm'}), e=>e.code==='CCB_ADMISSION_YIELDED');
 assert.equal(releases,2); assert.deepEqual(calls,['warm','prewarm']);
});
test('eviction protects active work and resumes a verified transcript', async t => {
 const {kernel,dir}=setup(); t.after(()=>kernel.dispose());
 await kernel.warm('a'); const initial=kernel.getInfo('a');
 assert.equal(kernel.getActiveProcesses()[0].idleEligible,true);
 assert.equal((await kernel.sendMessage('a','hi')).text,'ok');
 assert.deepEqual(await kernel.evictSession('a'),{ok:false,reason:'no-verified-transcript'});
 const saved=kernel.getInfo('a').persistence;
 const project=path.join(saved.homeDir,'projects',dir.replace(/[^a-zA-Z0-9]/g,'-')); mkdirSync(project,{recursive:true});
 writeFileSync(path.join(project,saved.cliSessionId+'.jsonl'),JSON.stringify({sessionId:saved.cliSessionId,cwd:dir,type:'user',message:{role:'user',content:'hi'}})+'\n');
 const out=await kernel.evictSession('a'); assert.equal(out.ok,true); assert.equal(out.pid,initial.pid);
 assert.equal((await kernel.sendMessage('a','again')).text,'ok');
 assert.notEqual(kernel.getInfo('a').pid,initial.pid);
 const args=readFileSync(path.join(dir,'argv.log'),'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(args[1].includes('--resume')); assert.ok(args[1].includes(saved.cliSessionId));
 const running=kernel.sendMessage('a','hold').catch(()=>{});
 await new Promise(r=>setTimeout(r,50)); assert.equal(kernel.getActiveProcesses()[0].idleEligible,false);
 assert.equal((await kernel.evictSession('a')).reason,'not-idle'); kernel.removeSession('a'); await running;
});
test('cancelled admission releases its slot and never spawns', async t => {
 let finish, released=0; const controller=new AbortController();
 const {kernel}=setup({acquireSlot:()=>new Promise(r=>{finish=r})}); t.after(()=>kernel.dispose());
 const pending=kernel.warm('a',{signal:controller.signal}); await new Promise(r=>setTimeout(r,10));
 controller.abort(); finish({release(){released++}});
 await assert.rejects(pending,/cancelled/); assert.equal(released,1); assert.equal(kernel.getActiveProcesses().length,0);
});
