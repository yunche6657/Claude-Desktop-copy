import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const require=createRequire(import.meta.url);
const {createCcbKernel}=require('../desktop/ccb-kernel.cjs');
const {createProtectionClock}=require('../desktop/cli-protection-clock.cjs');
const peer=String.raw`
const send=f=>process.stdout.write(JSON.stringify(f)+'\n');
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);if(f.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{models:[]}}});
 if(f.type==='fixture')send(f.frame);if(f.type==='stderr')process.stderr.write('fixture diagnostic only\n');
});`;
async function until(fn){const deadline=Date.now()+5000;while(Date.now()<deadline){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('fixture deadline');}
test('fixture child: backend power signals protect a live actor, rebase deadline and permit verified expiry',async t=>{
 let now=20_000_000_000,child;const clock=createProtectionClock({now:()=>now});
 const dir=mkdtempSync(path.join(tmpdir(),'r369-power-'));const entry=path.join(dir,'peer.cjs');writeFileSync(entry,peer);
 const backend=createCcbKernel({bunPath:process.execPath,entryPath:entry,kernelRoot:dir,cwd:dir,disposeTimeoutMs:1000,protectionNow:()=>now,protectionClock:clock,spawnImpl:(...args)=>child=spawn(...args)});
 t.after(()=>backend.dispose());await backend.warm('s');const original=backend.getActiveProcesses()[0];
 const emit=async frame=>{const version=backend.getProtectionState('s').version;child.stdin.write(JSON.stringify({type:'fixture',frame})+'\n');await until(()=>backend.getProtectionState('s').version>version);};
 await emit({type:'assistant',message:{content:[{type:'tool_use',id:'w',name:'ScheduleWakeup',input:{delaySeconds:60}}]}});
 await emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'w'}]},tool_use_result:{clampedDelaySeconds:60}});
 const at=backend.getProtectionState('s').loop.scheduledFor;
 assert.equal((await backend.evictSession('s')).reason,'protected');clock.suspend(now);now+=7200000;
 assert.equal(backend.getProtectionState('s').flags.loopWakeup,true);assert.equal((await backend.evictSession('s')).reason,'protected');
 clock.resume(now);const newDeadline=backend.getProtectionState('s').loop.scheduledFor;assert.equal(newDeadline,at+7200000);
 const old=backend.getActiveProcesses()[0];clock.resume(now+1);now=backend.getProtectionState('s').loop.scheduledFor+960001;
 await emit({type:'keep_alive'});await emit({type:'control_response',response:{request_id:'unmatched',subtype:'success'}});
 child.stdin.write(JSON.stringify({type:'stderr'})+'\n');
 assert.equal(backend.getProtectionState('s').flags.loopWakeup,false);
 assert.equal((await backend.evictSession('s',{pid:old.pid,actorToken:old.actorToken,protectionVersion:old.protection.version})).reason,'stale-candidate');
 assert.equal((await backend.evictSession('s')).ok,true);assert.throws(()=>process.kill(original.pid,0));
 await backend.warm('s');assert.notEqual(backend.getInfo('s').actorToken,original.actorToken);assert.equal(backend.getProtectionState('s').loop,null);
});
