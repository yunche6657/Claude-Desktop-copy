import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('desktop goal continues across completed turns and stops on verified completion marker',async()=>{
 let turns=0;const events=[];
 const k=createSessionKernel({emit:e=>events.push(e),createAgent:()=>({run:async()=>({text:++turns===2?'done <desktop-goal-complete/>':'still working',stopReason:'end_turn'})})});
 try{const {sessionId}=k.start({});await k.sendMessage(sessionId,'/goal finish fixture');
 for(let n=0;n<30&&k.getSession(sessionId).desktopGoal.status==='active';n++)await wait(30);
 assert.equal(turns,2);assert.equal(k.getSession(sessionId).desktopGoal.status,'complete');
 assert.ok(events.some(e=>e.type==='message'&&e.message?.message?.content?.[0]?.text.includes('目标已设置')));
 }finally{k.dispose();}
});
test('goal controls bypass a busy backend and survive restart paused',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-goal-'));const storePath=path.join(dir,'sessions.json');
 let calls=0;let k=createSessionKernel({storePath,emit:()=>{},createAgent:()=>({run:async()=>{calls++;return {text:'work',stopReason:'end_turn'}}})});
 try{const {sessionId}=k.start({});await k.sendMessage(sessionId,'/goal fixture');await k.sendMessage(sessionId,'/goal pause');await wait(140);assert.equal(calls,0);
 assert.equal(k.getSession(sessionId).desktopGoal.status,'paused');
 await k.sendMessage(sessionId,'/goal resume');k.flush?.();k.dispose();
 k=createSessionKernel({storePath,emit:()=>{},createAgent:()=>({run:async()=>({text:'x'})})});
 assert.equal(k.getSession(sessionId).desktopGoal.status,'paused');
 assert.match((await k.sendMessage(sessionId,'/goal')).text,/fixture/);
 await k.sendMessage(sessionId,'/goal clear');assert.equal(k.getSession(sessionId).desktopGoal,null);
 }finally{k.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
