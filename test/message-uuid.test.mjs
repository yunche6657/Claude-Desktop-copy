import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const ID='AF8D71CA-FBA4-4020-BE48-82549AA44ED6';
const ID2='b3b496db-cae2-48a9-83ae-7ce24d045d13';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fixture(run=async()=>({text:'reply',stopReason:'end_turn'})){const seen=[];const backend={id:'fixture',start:()=>{},cancel:()=>{},dispose:()=>{},onEvent:()=>()=>{},async sendMessage(sid,message,options){seen.push({sid,message,options});return run();}};return{seen,kernel:createSessionKernel({backend,emit:()=>{}})};}

test('a provided user UUID correlates backend options, durable row and assistant parent without changing reply UUID',async()=>{
 const {kernel,seen}=fixture();const s=kernel.start({cwd:os.tmpdir()});await kernel.sendMessage(s.sessionId,'first',{messageUuid:ID});
 const rows=kernel.getTranscript(s.sessionId);assert.equal(seen[0].options.messageUuid,ID);assert.equal(rows[0].uuid,ID);assert.equal(rows[1].parentUuid,ID);assert.match(rows[1].uuid,UUID);assert.notEqual(rows[1].uuid,ID);
 await kernel.sendMessage(s.sessionId,'second',{messageUuid:ID2});const updated=kernel.getTranscript(s.sessionId);assert.equal(updated[2].uuid,ID2);assert.equal(seen[1].options.messageUuid,ID2);assert.equal(updated[2].parentUuid,rows[1].uuid);
});

test('missing, malformed and attachment-like UUID inputs get one valid generated prompt UUID shared with backend',async()=>{
 const {kernel,seen}=fixture();const s=kernel.start({cwd:os.tmpdir()});
 for(const value of [undefined,'not-a-uuid',[{filename:'attachment.png'}]]){await kernel.sendMessage(s.sessionId,'input',{messageUuid:value});}
 const users=kernel.getTranscript(s.sessionId).filter(r=>r.type==='user');assert.equal(users.length,3);assert.equal(new Set(users.map(r=>r.uuid)).size,3);
 assert.match(users[0].uuid,UUID);assert.match(users[1].uuid,UUID);assert.match(users[2].uuid,UUID);assert.deepEqual(users.map(r=>r.uuid),seen.map(r=>r.options.messageUuid));
});

test('a failed turn retains the provided UUID including distinct retries with identical content',async()=>{
 const {kernel,seen}=fixture(async()=>{throw new Error('fixture failure')});const s=kernel.start({cwd:os.tmpdir()});await kernel.sendMessage(s.sessionId,'same',{messageUuid:ID});await kernel.sendMessage(s.sessionId,'same',{messageUuid:ID2});
 assert.deepEqual(kernel.getTranscript(s.sessionId).map(r=>r.uuid),[ID,ID2]);assert.deepEqual(seen.map(r=>r.options.messageUuid),[ID,ID2]);assert.equal(kernel.getSession(s.sessionId).isRunning,false);
});

test('landing first-turn UUID passes through start and persists across reload',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'message-uuid-'));const storePath=path.join(dir,'sessions.json');const agent={async run(){return{text:'reply',stopReason:'end_turn'}}};const kernel=createSessionKernel({createAgent:()=>agent,storePath,emit:()=>{}});
 try{const s=kernel.start({cwd:dir,message:'landing',messageUuid:ID});await new Promise(r=>setImmediate(r));kernel.flush();assert.equal(kernel.getTranscript(s.sessionId)[0].uuid,ID);
 const loaded=createSessionKernel({createAgent:()=>agent,storePath,emit:()=>{}});assert.equal(loaded.getTranscript(s.sessionId)[0].uuid,ID);loaded.dispose();
 }finally{kernel.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
