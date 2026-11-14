import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url),Module=require('node:module'),oldLoad=Module._load;let Manager,channel;const windows=[];
class Win extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.dead=false;windows.push(this)}removeMenu(){}loadFile(){queueMicrotask(()=>this.emit('ready-to-show'));return Promise.resolve()}show(){}showInactive(){}flashFrame(){}focus(){}setAlwaysOnTop(){}isDestroyed(){return this.dead}destroy(){this.dead=true;this.emit('closed')}}
try{Module._load=function(name,...args){if(name==='electron')return {BrowserWindow:Win,app:{isPackaged:true}};return oldLoad.call(this,name,...args)};({ConsentManager:Manager,CHOOSE_CHANNEL:channel}=require('../desktop/consent-manager.cjs'));}finally{Module._load=oldLoad}

test('apply allow and cancel require 500 ms after show and every focus',async()=>{
 let now=1000;const previous=Date.now;Date.now=()=>now;const handlers=new Map(),manager=new Manager({parentWindow:null,ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)}});manager.register();
 try{const work=manager.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));const w=windows.at(-1),call=choice=>handlers.get(channel)({sender:w.webContents,senderFrame:{url:'file:///consent.html',parent:null}},choice);
  now=1499;assert.deepEqual(call('allow'),{ok:false,reason:'input-protected'});assert.deepEqual(call('cancel'),{ok:false,reason:'input-protected'});
  now=1500;w.emit('focus');now=1999;assert.equal(call('allow').reason,'input-protected');now=2000;assert.deepEqual(call('allow'),{ok:true,decision:'allow'});assert.equal(await work,'allow');
 }finally{manager.dispose();Date.now=previous;}
});

test('ordinary cancel is not blocked; allow is blocked before show and at 499 ms',async()=>{
 let now=100;const previous=Date.now;Date.now=()=>now;const handlers=new Map(),manager=new Manager({parentWindow:null,ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)}});manager.register();
 try{const work=manager.ask({kind:'run-command',command:'fixture'});await new Promise(r=>setImmediate(r));const w=windows.at(-1),call=choice=>handlers.get(channel)({sender:w.webContents,senderFrame:{url:'file:///consent.html',parent:null}},choice);
  now=599;assert.equal(call('allow').reason,'input-protected');assert.equal(call('cancel').ok,true);assert.equal(await work,'cancel');
 }finally{manager.dispose();Date.now=previous;}
});

test('allow received before consent page finishes loading is ignored',async()=>{
 let release,now=100;const priorNow=Date.now,priorLoad=Win.prototype.loadFile;Date.now=()=>now;Win.prototype.loadFile=()=>new Promise(r=>release=r);
 const handlers=new Map(),manager=new Manager({parentWindow:null,ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)}});manager.register();
 try{const work=manager.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));const w=windows.at(-1),call=()=>handlers.get(channel)({sender:w.webContents,senderFrame:{url:'file:///consent.html',parent:null}},'allow');
 assert.equal(call().reason,'input-protected');release();w.emit('ready-to-show');await new Promise(r=>setImmediate(r));now=600;assert.equal(call().ok,true);assert.equal(await work,'allow');
 }finally{manager.dispose();Date.now=priorNow;Win.prototype.loadFile=priorLoad;}
});
