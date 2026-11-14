import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url),Module=require('node:module'),oldLoad=Module._load;let Manager;
const windows=[];class Win extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.dead=false;windows.push(this)}removeMenu(){}loadFile(){queueMicrotask(()=>this.emit('ready-to-show'));return Promise.resolve()}show(){}showInactive(){}flashFrame(){}focus(){}setAlwaysOnTop(){}isDestroyed(){return this.dead}destroy(){this.dead=true;this.emit('closed')}}
try{Module._load=function(name,...args){if(name==='electron')return {BrowserWindow:Win,app:{isPackaged:true}};return oldLoad.call(this,name,...args)};({ConsentManager:Manager}=require('../desktop/consent-manager.cjs'));}finally{Module._load=oldLoad}
function fakeClock(){let now=1000,id=0;const timers=new Map();return {now:()=>now,set:(fn,ms)=>{const key=++id;timers.set(key,{fn,at:now+ms});return key},clear:id=>timers.delete(id),advance:ms=>{now+=ms;for(const [key,t] of [...timers])if(t.at<=now){timers.delete(key);t.fn()}},count:()=>timers.size};}

test('apply defaults to infinite wait and has no timer',async()=>{
 const clock=fakeClock(),oldNow=Date.now,oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
 Date.now=clock.now;globalThis.setTimeout=clock.set;globalThis.clearTimeout=clock.clear;
 const manager=new Manager({ipcMain:{},parentWindow:null});
 try{let settled=false;const work=manager.ask({kind:'apply',targets:[]}).then(x=>{settled=true;return x});await new Promise(r=>setImmediate(r));assert.equal(clock.count(),0);clock.advance(86400000);await Promise.resolve();assert.equal(settled,false);manager.resolve('allow');assert.equal(await work,'allow');}
 finally{manager.dispose();Date.now=oldNow;globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});

test('queued finite deadline starts at ask time and expired request opens no window',async()=>{
 const clock=fakeClock(),oldNow=Date.now,oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
 Date.now=clock.now;globalThis.setTimeout=clock.set;globalThis.clearTimeout=clock.clear;
 const manager=new Manager({ipcMain:{},parentWindow:null});
 try{const first=manager.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));const count=windows.length;
  const queued=manager.ask({kind:'run-command',command:'fixture'},{timeoutMs:500});clock.advance(501);manager.resolve('allow');assert.equal(await first,'allow');assert.equal(await queued,'timeout');assert.equal(windows.length,count);assert.equal(clock.count(),0);
 }finally{manager.dispose();Date.now=oldNow;globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});

test('queued request uses only time remaining and finite apply override works',async()=>{
 const clock=fakeClock(),oldNow=Date.now,oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
 Date.now=clock.now;globalThis.setTimeout=clock.set;globalThis.clearTimeout=clock.clear;
 const manager=new Manager({ipcMain:{},parentWindow:null});
 try{const first=manager.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));const second=manager.ask({kind:'apply',targets:[]},{timeoutMs:500});clock.advance(300);manager.resolve('allow');await first;await new Promise(r=>setImmediate(r));assert.equal(clock.count(),1);clock.advance(199);await Promise.resolve();assert.ok(manager.pending);clock.advance(1);assert.equal(await second,'timeout');assert.equal(clock.count(),0);}
 finally{manager.dispose();Date.now=oldNow;globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});
