import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url),Module=require('node:module'),original=Module._load,windows=[];let Manager;
class Win extends EventEmitter{static focused=null;static getFocusedWindow(){return Win.focused}constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.dead=false;this.focused=false;this.events=[];windows.push(this)}removeMenu(){}loadFile(){this.events.push('load');return Promise.resolve()}show(){this.events.push('show')}showInactive(){this.events.push('showInactive')}flashFrame(v){this.events.push(['flash',v])}focus(){this.events.push('focus');this.focused=true;this.emit('focus')}isFocused(){return this.focused}isDestroyed(){return this.dead}destroy(){this.events.push('destroy');this.dead=true;this.emit('closed')}}
try{Module._load=function(name,...args){if(name==='electron')return {BrowserWindow:Win,app:{isPackaged:true}};return original.call(this,name,...args)};({ConsentManager:Manager}=require('../desktop/consent-manager.cjs'));}finally{Module._load=original}
function parent(){const p=new EventEmitter();p.focusCount=0;p.dead=false;p.visible=true;p.isDestroyed=()=>p.dead;p.isVisible=()=>p.visible;p.focus=()=>p.focusCount++;return p;}

test('ready-to-show controls display and focused child returns focus to visible parent',async()=>{
 const p=parent(),m=new Manager({parentWindow:p,ipcMain:{}});
 try{const work=m.ask({kind:'run-command',command:'fixture'});await new Promise(r=>setImmediate(r));const w=windows.at(-1);assert.deepEqual(w.events,['load']);w.emit('ready-to-show');assert.deepEqual(w.events,['load','show','focus']);m.resolve('allow');assert.equal(await work,'allow');assert.equal(p.focusCount,1);assert.equal(w.dead,true);}
 finally{m.dispose();}
});
test('inactive apply signals attention; explicit user action can focus via parent and removes listener',async()=>{
 const p=parent(),m=new Manager({parentWindow:p,ipcMain:{}});Win.focused=null;
 try{const work=m.ask({kind:'apply',targets:[]},{userAction:true});await new Promise(r=>setImmediate(r));const w=windows.at(-1);w.emit('ready-to-show');assert.deepEqual(w.events,['load','showInactive',['flash',true]]);assert.equal(p.listenerCount('focus'),1);p.emit('focus');assert.equal(w.focused,true);assert.equal(p.listenerCount('focus'),0);m.resolve('cancel');assert.equal(await work,'cancel');assert.equal(p.focusCount,1);}
 finally{m.dispose();}
});
test('close, load failure and dispose settle once without showing late or focusing destroyed parent',async()=>{
 let p=parent(),m=new Manager({parentWindow:p,ipcMain:{}});
 try{const work=m.ask({kind:'apply',targets:[]},{userAction:true});await new Promise(r=>setImmediate(r));const w=windows.at(-1);w.emit('ready-to-show');assert.equal(p.listenerCount('focus'),1);p.dead=true;w.focused=true;w.emit('close');w.dead=true;w.emit('closed');assert.equal(await work,'cancel');assert.equal(p.focusCount,0);assert.equal(p.listenerCount('focus'),0);
 m.dispose();p=parent();m=new Manager({parentWindow:p,ipcMain:{}});
 const later=m.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));const x=windows.at(-1);x.webContents.emit('did-fail-load',{},-6,'failed','file:///consent.html',true);assert.equal(await later,'error');x.emit('ready-to-show');assert.equal(x.events.includes('showInactive'),false);
 const pending=m.ask({kind:'apply',targets:[]});await new Promise(r=>setImmediate(r));m.dispose();assert.equal(await pending,'cancel');
 }finally{m.dispose();}
});
