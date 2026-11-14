import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url);
const Module=require('node:module');
const original=Module._load;
const windows=[];
class MockWindow extends EventEmitter {
 constructor() {super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.destroyed=false;windows.push(this);}
 removeMenu(){} loadFile(){queueMicrotask(()=>this.emit('ready-to-show'));return Promise.resolve()} show(){} showInactive(){} flashFrame(){} focus(){} setAlwaysOnTop(){} isDestroyed(){return this.destroyed} destroy(){this.destroyed=true;this.emit('closed')}
}
let ConsentManager,CHOOSE_CHANNEL;
try { Module._load=function(request,...args){if(request==='electron')return {BrowserWindow:MockWindow,app:{isPackaged:true}};return original.call(this,request,...args)};
 ({ConsentManager,CHOOSE_CHANNEL}=require('../desktop/consent-manager.cjs'));
} finally {Module._load=original;}

test('only current consent window top-level frame can answer pending IPC',async()=>{
 const handlers=new Map();const ipcMain={handle:(c,fn)=>handlers.set(c,fn),removeHandler:c=>handlers.delete(c)};
 const manager=new ConsentManager({parentWindow:null,ipcMain});manager.register();
 const invoke=(sender,frame,choice='allow')=>handlers.get(CHOOSE_CHANNEL)({sender,senderFrame:frame},choice);
 const goodFrame={url:'file:///localExecConsent.html',parent:null}, childFrame={url:'file:///localExecConsent.html',parent:{}};
 try {
  assert.throws(()=>invoke({},goodFrame),/untrusted/);
  const result=manager.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));
  const active=windows.at(-1);assert.ok(active);
  assert.throws(()=>invoke({},goodFrame),/untrusted/);
  assert.throws(()=>invoke(active.webContents,childFrame),/untrusted/);
  assert.throws(()=>invoke(active.webContents,{url:'https://example.invalid',parent:null}),/untrusted/);
  assert.throws(()=>invoke(active.webContents,goodFrame,'invalid'),/unsupported/);
  manager.pending.shownAt=Date.now()-500;
  assert.deepEqual(invoke(active.webContents,goodFrame),{ok:true,decision:'allow'});
  assert.equal(await result,'allow');
  assert.throws(()=>invoke(active.webContents,goodFrame),/untrusted/);
  const next=manager.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));
  const second=windows.at(-1);assert.notEqual(second,active);
  assert.throws(()=>invoke(active.webContents,goodFrame),/untrusted/);
  manager.pending.shownAt=Date.now()-500;
  assert.deepEqual(invoke(second.webContents,goodFrame,'cancel'),{ok:true,decision:'cancel'});
  assert.equal(await next,'cancel');
 }finally{manager.dispose();}
});
