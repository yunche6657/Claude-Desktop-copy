import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url),Module=require('node:module'),original=Module._load,windows=[];let Manager;
class Win extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.dead=false;windows.push(this)}removeMenu(){}loadFile(){queueMicrotask(()=>this.emit('ready-to-show'));return Promise.resolve()}show(){}showInactive(){}flashFrame(){}focus(){}setAlwaysOnTop(){}isDestroyed(){return this.dead}destroy(){this.dead=true;this.emit('closed')}}
try{Module._load=function(name,...args){if(name==='electron')return {BrowserWindow:Win,app:{isPackaged:true}};return original.call(this,name,...args)};({ConsentManager:Manager}=require('../desktop/consent-manager.cjs'));}finally{Module._load=original}
function input(win,args){let prevented=false;win.webContents.emit('before-input-event',{preventDefault(){prevented=true}},args);return prevented;}
test('apply Ctrl/Cmd-W is blocked before 500 ms and repeated key remains blocked',async()=>{
 let time=1000;const old=Date.now;Date.now=()=>time;const manager=new Manager({parentWindow:null,ipcMain:{}});
 try{const result=manager.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));const w=windows.at(-1);
  time=1499;assert.equal(input(w,{type:'keyDown',control:true,key:'w'}),true);
  time=1500;assert.equal(input(w,{type:'keyDown',meta:true,key:'W'}),false);
  assert.equal(input(w,{type:'keyDown',meta:true,code:'KeyW',key:'ц',isAutoRepeat:true}),true);
  assert.equal(input(w,{type:'keyUp',control:true,key:'w',isAutoRepeat:true}),false);
  assert.equal(input(w,{type:'keyDown',control:true,key:'x',isAutoRepeat:true}),false);
  assert.equal(input(w,{type:'keyDown',key:'w',isAutoRepeat:true}),false);
  w.emit('focus');time=1999;assert.equal(input(w,{type:'keyDown',control:true,key:'w'}),true);
  manager.resolve('cancel');assert.equal(await result,'cancel');
 }finally{manager.dispose();Date.now=old;}
});
test('ordinary prompt never blocks Ctrl-W',async()=>{
 let time=100;const old=Date.now;Date.now=()=>time;const manager=new Manager({parentWindow:null,ipcMain:{}});
 try{const result=manager.ask({kind:'run-command',command:'fixture'});await new Promise(r=>setImmediate(r));const w=windows.at(-1);assert.equal(input(w,{type:'keyDown',control:true,key:'w',isAutoRepeat:true}),false);manager.resolve('cancel');await result;}
 finally{manager.dispose();Date.now=old;}
});
