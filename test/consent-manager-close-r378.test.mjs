import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url),Module=require('node:module'),original=Module._load,windows=[];let Manager;
class Win extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.dead=false;this.hang=false;this.closes=0;this.destroys=0;windows.push(this)}removeMenu(){}loadFile(){return Promise.resolve()}show(){}showInactive(){}flashFrame(){}isDestroyed(){return this.dead}isFocused(){return false}close(){this.closes++;this.emit('close');if(!this.hang){this.dead=true;this.emit('closed')}}destroy(){this.destroys++;this.dead=true;this.emit('closed')}}
try{Module._load=function(name,...args){if(name==='electron')return {BrowserWindow:Win,app:{isPackaged:true}};return original.call(this,name,...args)};({ConsentManager:Manager}=require('../desktop/consent-manager.cjs'));}finally{Module._load=original}
function clock(){let t=0,id=0;const items=new Map();return {set:(fn,ms)=>{const x={id:++id,at:t+ms,unref(){}};items.set(x.id,{...x,fn});return x},clear:x=>items.delete(x?.id),advance:ms=>{t+=ms;for(const [k,v] of [...items])if(v.at<=t){items.delete(k);v.fn()}},count:()=>items.size};}

test('normal selection closes window, settles on closed and cancels fallback',async()=>{
 const c=clock(),oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;globalThis.setTimeout=c.set;globalThis.clearTimeout=c.clear;const m=new Manager({ipcMain:{}});
 try{const result=m.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));const w=windows.at(-1);w.emit('ready-to-show');m.resolve('allow');assert.equal(await result,'allow');assert.equal(w.closes,1);assert.equal(w.destroys,0);assert.equal(c.count(),0);c.advance(5000);assert.equal(w.destroys,0);}
 finally{m.dispose();globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});
test('hung close waits five seconds then destroys once and settles original choice',async()=>{
 const c=clock(),oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;globalThis.setTimeout=c.set;globalThis.clearTimeout=c.clear;const m=new Manager({ipcMain:{}});
 try{let done=false;const result=m.ask({kind:'apply',targets:[]}).then(v=>{done=true;return v});await new Promise(r=>setImmediate(r));const w=windows.at(-1);w.hang=true;w.emit('ready-to-show');m.resolve('cancel');c.advance(4999);await Promise.resolve();assert.equal(done,false);assert.equal(w.destroys,0);c.advance(1);assert.equal(await result,'cancel');assert.equal(w.destroys,1);assert.equal(c.count(),0);}
 finally{m.dispose();globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});
test('dispose pending window uses same close fallback and frees timer',async()=>{
 const c=clock(),oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;globalThis.setTimeout=c.set;globalThis.clearTimeout=c.clear;const m=new Manager({ipcMain:{}});
 try{const result=m.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));const w=windows.at(-1);w.hang=true;m.dispose();assert.equal(w.closes,1);c.advance(5000);assert.equal(await result,'cancel');assert.equal(w.destroys,1);assert.equal(c.count(),0);}
 finally{m.dispose();globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});
