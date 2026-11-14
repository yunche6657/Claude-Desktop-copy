import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');

test('one native protocol registration serves signed raster and opaque audio tokens through real session IPC',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'media-bridge-'));
 const methods=new Map(),protocols=new Map();
 const kernel=createSessionKernel({emit(){},createAgent:()=>({run:async()=>({text:''})})});
 const bridge=registerBridgeServices({ipcMain:{handle:(key,fn)=>methods.set(key,fn),removeHandler:key=>methods.delete(key)},
  mediaProtocol:{handle:(scheme,fn)=>{assert.equal(protocols.has(scheme),false);protocols.set(scheme,fn);},unhandle:scheme=>protocols.delete(scheme)},
  bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>null,settings:{kernelFactory:()=>kernel},frontend:{root}});
 t.after(async()=>{await bridge.dispose();fs.rmSync(root,{recursive:true,force:true});});
 const call=(method,...args)=>methods.get(messageChannel('claude.web','LocalSessions',method))({},...args);
 const session=await call('start',{cwd:root});
 const image=Buffer.alloc(1024*1024,7),audio=Buffer.from('RIFF0000WAVE_TEST_BYTES');
 fs.writeFileSync(path.join(root,'image.png'),image);fs.writeFileSync(path.join(root,'sound.wav'),audio);
 const imageUrl=await call('getSessionImageStreamUrl',session.sessionId,path.join(root,'image.png'));
 const audioUrl=await call('getSessionMediaStreamUrl',session.sessionId,path.join(root,'sound.wav'));
 assert.equal(new URL(imageUrl).hostname,'s');assert.equal(new URL(audioUrl).hostname,'v');
 assert.equal(protocols.size,1);
 const handler=protocols.get('claude-media');
 const picture=await handler(new Request(imageUrl,{headers:{Range:'bytes=0-3'}}));
 assert.equal(picture.status,206);assert.deepEqual(Buffer.from(await picture.arrayBuffer()),image.subarray(0,4));
 const sound=await handler(new Request(audioUrl,{headers:{Range:'bytes=0-3'}}));
 assert.equal(sound.status,206);assert.equal(sound.headers.get('content-type'),'audio/wav');assert.equal(Buffer.from(await sound.arrayBuffer()).toString(),'RIFF');
 assert.equal(await call('readSessionMediaAsDataUrl',session.sessionId,path.join(root,'sound.wav')),'data:audio/wav;base64,'+audio.toString('base64'));
 await call('delete',session.sessionId);
 assert.equal((await handler(new Request(imageUrl))).status,404);assert.equal((await handler(new Request(audioUrl))).status,404);
 await bridge.dispose();assert.equal(protocols.size,0);
});
