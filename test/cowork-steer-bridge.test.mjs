import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const {registerBridgeServices,messageChannel}=createRequire(import.meta.url)('../desktop/bridge-services.cjs');
test('Cowork running sends reach native steer admission with original UUID',async()=>{
 const handlers=new Map(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-steer-'));let received;
 const bridge=registerBridgeServices({ipcMain:{handle:(key,fn)=>handlers.set(key,fn),on(){},removeHandler(){}},bridgeMap:{'claude.web':{LocalAgentModeSessions:['sendMessage']}},getMainWindow:()=>null,settings:{dataDir:dir,kernelFactory:()=>({getSession:()=>({isRunning:true}),sendMessage:async(...args)=>{received=args;return {ok:true}},getAll:()=>[]})}});
 try{const fn=handlers.get(messageChannel('claude.web','LocalAgentModeSessions','sendMessage'));await fn({},'session','补充要求',[],[],'12345678-1234-1234-1234-123456789012');assert.equal(received[2].priority,'now');assert.equal(received[2].deferIfBusy,true);assert.equal(received[2].messageUuid,'12345678-1234-1234-1234-123456789012');}
 finally{bridge.dispose?.();fs.rmSync(dir,{recursive:true,force:true});}
});
