import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';
const {createHybridBootstrapScheduler}=createRequire(import.meta.url)('../desktop/hybrid-bootstrap-scheduler.cjs');
const file=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js');
function clock(){let t=1000000,id=0;const timers=new Map(),events=new Map();return {now:()=>t,set:(fn,ms)=>{const x={id:++id,at:t+ms,ms,fn,unref(){}};timers.set(x.id,x);return x},clear:x=>timers.delete(x?.id),on:(name,fn)=>{let x=events.get(name)||[];x.push(fn);events.set(name,x);return()=>events.set(name,(events.get(name)||[]).filter(y=>y!==fn))},emit:name=>{for(const fn of events.get(name)||[])fn(name)},jump:ms=>{t+=ms}, next:()=>[...timers.values()].sort((a,b)=>a.at-b.at)[0],fire:async()=>{let x=[...timers.values()].sort((a,b)=>a.at-b.at)[0];timers.delete(x.id);t=x.at;x.fn();for(let i=0;i<8;i++)await Promise.resolve();},count:()=>timers.size};}
function native(clock,setup){const s=fs.readFileSync(file,'utf8'),a=s.indexOf('scheduleBootstrapRepolls(){'),b=s.indexOf('configRestartPending(){',a);assert.ok(a>=0&&b>a);
 const body=s.slice(a,b);const ctor=vm.runInNewContext(`(class {${body}})`,{Hu:()=>{},cvn:()=>'',rZt:()=>{},qT:async()=>{},svn:()=>{},rd:(names,fn)=>names.forEach(n=>clock.on(n,fn)),bKe:(names,fn)=>names.forEach(n=>clock.on(n,fn)),
 setTimeout:clock.set,clearTimeout:clock.clear,Date:{now:clock.now},N:{info(){}},XWe:()=>setup.reads++,fvn:[10000,30000,120000],pvn:300000,dvn:30000,
 K:()=>({lifecycle:{configRecheckIntervalMinutes:setup.minutes}}),hvn:x=>x*60000,gvn:x=>Math.round(x*(.9+setup.random*.2)),ZWe:()=>setup.quick});
 const obj=new ctor();Object.assign(obj,{_bootstrapState:{configured:true},reconcileAfterRebuild(){},publishBootstrapBundle:async()=>{},resyncMarketplacesIfChanged(){},periodicBootstrapRefresh:async()=>{setup.refreshes++},expediteBootResolveRetry:event=>setup.boot.push(event)});return obj;}
function model(clock,setup){return createHybridBootstrapScheduler({intervalMinutes:()=>setup.minutes,isConfigured:()=>true,wantsQuickConfirm:()=>setup.quick,refresh:async()=>{setup.refreshes++},rereadConfig:()=>setup.reads++,expediteBootRetry:e=>setup.boot.push(e),subscribe:clock.on,now:clock.now,random:()=>setup.random,setTimer:clock.set,clearTimer:clock.clear});}

test('native VM and scheduler match periodic jitter, quick confirm and rearm',async()=>{
 const c1=clock(),c2=clock(),a={minutes:10,random:0,quick:false,reads:0,refreshes:0,boot:[]},b={...a,boot:[]};const n=native(c1,a),m=model(c2,b);n.scheduleBootstrapRepolls();m.start();
 assert.equal(c1.next().ms,540000);assert.equal(c2.next().ms,540000);
 a.quick=b.quick=true;c1.emit('unlock');c2.emit('unlock');assert.equal(c1.next().ms,30000);assert.equal(c2.next().ms,30000);
 await c1.fire();await c2.fire();assert.equal(a.refreshes,b.refreshes);assert.equal(a.reads,b.reads);assert.equal(c1.next().ms,c2.next().ms);m.dispose();assert.equal(c2.count(),0);
});

test('native VM and scheduler match long-away wake retry sequence',async()=>{
 const c1=clock(),c2=clock(),a={minutes:60,random:.5,quick:false,reads:0,refreshes:0,boot:[]},b={...a,boot:[]};const n=native(c1,a),m=model(c2,b);n.scheduleBootstrapRepolls();m.start();
 c1.emit('suspend');c2.emit('suspend');c1.jump(300001);c2.jump(300001);c1.emit('resume');c2.emit('resume');
 for(const delay of [10000,30000,120000]){assert.equal(c1.next().ms,delay);assert.equal(c2.next().ms,delay);await c1.fire();await c2.fire();}
 assert.equal(a.refreshes,3);assert.equal(b.refreshes,3);assert.deepEqual(a.boot,b.boot);m.dispose();
});

test('short absence skips wake retry; explicit online confirmation cancels subsequent wake attempts',async()=>{
 const c=clock(),s={minutes:60,random:.5,quick:false,reads:0,refreshes:0,boot:[]};let m;
 m=createHybridBootstrapScheduler({intervalMinutes:()=>s.minutes,isConfigured:()=>true,wantsQuickConfirm:()=>false,refresh:async()=>{s.refreshes++;m.markOnline()},subscribe:c.on,now:c.now,random:()=>s.random,setTimer:c.set,clearTimer:c.clear});m.start();
 c.emit('lock');c.jump(299999);c.emit('unlock');assert.equal(c.next().ms,3600000);
 c.emit('lock');c.jump(300000);c.emit('unlock');assert.equal(c.next().ms,10000);await c.fire();assert.equal(s.refreshes,1);assert.equal(c.next().ms,3600000);m.dispose();assert.equal(c.count(),0);
});
