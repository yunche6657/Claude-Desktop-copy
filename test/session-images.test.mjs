import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {createSessionImages,userContent,MAX_IMAGE_BYTES}=require('../desktop/session-images.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const bytes=Buffer.from([0,1,2,255,128,10]);
const images=[{base64:bytes.toString('base64'),mimeType:'image/png',filename:'binary.png'}];
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-images-'));const cwd=path.join(root,'work');fs.mkdirSync(cwd);return{root,cwd,service:createSessionImages({getSession:id=>id==='s'?{cwd}:null}),clean:()=>fs.rmSync(root,{recursive:true,force:true})};}

test('session image reads actual binary bytes and refuses foreign files, unknown sessions and nonimages',async()=>{
 const f=fixture();try{fs.writeFileSync(path.join(f.cwd,'image.png'),bytes);fs.writeFileSync(path.join(f.root,'outside.png'),bytes);fs.writeFileSync(path.join(f.cwd,'secret.txt'),bytes);
 assert.equal(await f.service.readSessionImageAsDataUrl('s','image.png'),'data:image/png;base64,'+bytes.toString('base64'));
 assert.equal(await f.service.readSessionImageAsDataUrl('s','../outside.png'),null);
 assert.equal(await f.service.readSessionImageAsDataUrl('unknown',path.join(f.cwd,'image.png')),null);
 assert.equal(await f.service.readSessionImageAsDataUrl('s','secret.txt'),null);
 assert.equal(await f.service.readSessionImageAsDataUrl('s','missing.png'),null);
 }finally{f.clean();}
});

test('image reads reject external junction traversal and oversized files',async()=>{
 const f=fixture();try{const external=path.join(f.root,'external');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'x.png'),bytes);fs.symlinkSync(external,path.join(f.cwd,'linked'),process.platform==='win32'?'junction':'dir');
 assert.equal(await f.service.readSessionImageAsDataUrl('s','linked/x.png'),null);
 const fd=fs.openSync(path.join(f.cwd,'large.png'),'w');fs.ftruncateSync(fd,MAX_IMAGE_BYTES+1);fs.closeSync(fd);
 assert.equal(await f.service.readSessionImageAsDataUrl('s','large.png'),null);
 }finally{f.clean();}
});

test('malformed attachments fail before a turn starts rather than being silently discarded',async()=>{
 assert.throws(()=>userContent('x',[{base64:'%bad',mimeType:'image/png'}]),/Invalid image/);
 assert.throws(()=>userContent('x',{}),/array/);
 const k=createSessionKernel({emit:()=>{},createAgent:()=>({run:()=>{throw new Error('must not run');}})});
 const s=k.start({cwd:os.tmpdir()});
 await assert.rejects(k.sendMessage(s.sessionId,'x',{images:[{base64:'bad?',mimeType:'image/png'}]}),/Invalid image/);
 assert.equal(k.getSession(s.sessionId).isRunning,false);assert.deepEqual(k.getTranscript(s.sessionId),[]);
});

test('multimodal turns reach the backend, persist on disk and remain in next-turn history',async()=>{
 const f=fixture();let seen=[];const backend={id:'fixture',start:()=>{},cancel:()=>{},dispose:()=>{},onEvent:()=>()=>{},async sendMessage(id,text,options){seen.push(options);return{text:'fixture reply',stopReason:'end_turn'};}};
 const storePath=path.join(f.root,'sessions.json');const k=createSessionKernel({backend,emit:()=>{},storePath});
 try{const s=k.start({cwd:f.cwd});await k.sendMessage(s.sessionId,'inspect',{images});k.flush();
 assert.deepEqual(seen[0].images,images);assert.deepEqual(seen[0].messages.at(-1).content,userContent('inspect',images));
 assert.deepEqual(k.getTranscript(s.sessionId)[0].message.content,userContent('inspect',images));
 const restored=createSessionKernel({backend,emit:()=>{},storePath});
 assert.deepEqual(restored.getTranscript(s.sessionId)[0].message.content,userContent('inspect',images));
 await restored.sendMessage(s.sessionId,'next');
 assert.deepEqual(seen[1].messages[0].content,userContent('inspect',images));
 }finally{f.clean();}
});

test('a failed backend retains the user image in the durable transcript',async()=>{
 const k=createSessionKernel({emit:()=>{},createAgent:()=>({run:async()=>{throw new Error('provider failed');}})});
 const s=k.start({cwd:os.tmpdir()});const r=await k.sendMessage(s.sessionId,'inspect',{images});
 assert.equal(r.ok,false);assert.deepEqual(k.getTranscript(s.sessionId)[0].message.content,userContent('inspect',images));
});


test('landing image-only first turn retains attachments when no text is supplied',async()=>{
 const seen=[];const backend={id:'fixture',start:()=>{},cancel:()=>{},dispose:()=>{},onEvent:()=>()=>{},async sendMessage(id,text,options){seen.push({text,options});return{text:'first-image-reply',stopReason:'end_turn'};}};
 const k=createSessionKernel({backend,emit:()=>{}});const session=k.start({cwd:os.tmpdir(),message:'',images});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(seen.length,1);assert.equal(seen[0].text,'');assert.deepEqual(seen[0].options.images,images);
 assert.deepEqual(k.getTranscript(session.sessionId)[0].message.content,userContent('',images));
});
