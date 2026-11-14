import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const {createMcpRelayRuntime}=createRequire(import.meta.url)('../desktop/mcp-relay-runtime.cjs');
const {createMcpRelayAdapter}=createRequire(import.meta.url)('../desktop/mcp-relay-adapter.cjs');
const root=path.resolve('.');
test('injection failure closes the registration without exposing the injector error',async()=>{
 const events=[],actor={},ac=new AbortController();
 const adapter=createMcpRelayAdapter({isCurrent:()=>true,authorize:()=>true,onStatus:e=>events.push(e),inject:()=>{throw Error('private-bootstrap-value')}});
 await assert.rejects(adapter.register({actor,server:'one',source:{name:'one',kind:'project',revision:1,conflicts:()=>false},authorityRevision:1,signal:ac.signal,command:process.execPath}),e=>e.message==='relay injection failed');
 const closed=events.find(e=>e.state==='closed');assert.ok(closed);assert.equal(closed.reason,'authority invalidated');adapter.dispose();
});
test('requires current snapshotted authority and separates servers for an actor',async()=>{
 let current=true;const actor={},ac=new AbortController(),r=createMcpRelayRuntime({isCurrent:s=>current&&s.authorityRevision===7,authorize:()=>true});
 const base={actor,authorityRevision:7,signal:ac.signal,command:process.execPath,args:[]};
 const a=await r.register({...base,server:'a',source:{name:'a',kind:'project',revision:1,conflicts:()=>false}});
 await assert.rejects(r.register({...base,server:'a',source:{name:'a',kind:'project',revision:1,conflicts:()=>false}}),/already registered/);
 const b=await r.register({...base,server:'b',source:{name:'b',kind:'project',revision:1,conflicts:()=>false}});assert.notDeepEqual(a.launch.args,b.launch.args);
 ac.abort();assert.throws(()=>r.status(a.handle),/not connected/);assert.throws(()=>r.status(b.handle),/not connected/);current=false;
 await assert.rejects(r.register({...base,signal:new AbortController().signal,server:'c',source:{name:'c',kind:'project',revision:1,conflicts:()=>false}}),/stale/);r.dispose();
});
test('real CCB uses two independent relay connections and both servers exit', {timeout:60000}, async()=>{
 const base=mkdtempSync(path.join(os.tmpdir(),'relay-runtime-test-')),dir=path.join(base,'run');
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'tools/proof-mcp-relay-runtime-r378.cjs'),dir],{cwd:root,env:process.env,stdio:['ignore','ignore','pipe'],windowsHide:true});let error='';child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('exit',code=>code===0?resolve(code):reject(Error(error||`proof exited ${code}`)))});
 assert.equal(code,0);const report=JSON.parse(readFileSync(path.join(dir,'report.json'),'utf8'));assert.equal(report.ok,true);assert.equal(Object.keys(report.checks).length,7);
});
import net from 'node:net';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{for(let i=0;i<200;i++){if(await fn())return;await delay(10)}throw Error('timeout')};
const makeArgs=(actor,dir)=>({actor,server:'one',source:{name:'one',kind:'project',revision:1,conflicts:()=>false},authorityRevision:1,signal:new AbortController().signal,command:process.execPath,args:[path.join(root,'tools/proof-mcp-relay-runtime-r378.cjs'),'fixture',dir,'one']});
const connect=async launch=>{const socket=net.createConnection(launch.args[1]);socket.on('error',()=>{});await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)});return socket};
const secret=registration=>Object.values(registration.bootstrapEnv)[0];
test('untrusted first connections do not prevent a valid bootstrap',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'relay-runtime-untrusted-')),args=makeArgs({},dir),events=[],r=createMcpRelayRuntime({isCurrent:()=>true,authorize:()=>true,onStatus:e=>events.push(e)});
 const a=await r.register(args),silent=await connect(a.launch),bad=await connect(a.launch);bad.write('wrong\n');await until(()=>bad.destroyed||bad.readableEnded);bad.destroy();
 const oversize=await connect(a.launch);oversize.write('x'.repeat(129));await until(()=>oversize.destroyed||oversize.readableEnded);oversize.destroy();
 const good=await connect(a.launch);good.write(secret(a)+'\n');await until(()=>{try{return !!r.status(a.handle)}catch{return false}});
 assert.equal(events.some(e=>e.handle===a.handle&&e.state==='closed'),false);r.dispose();silent.destroy();good.destroy();
});
test('client removes every relay bootstrap variable from its own environment',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'relay-runtime-env-')),args=makeArgs({},dir),r=createMcpRelayRuntime({isCurrent:()=>true,authorize:()=>true});
 const a=await r.register(args),probe=path.join(dir,'probe.cjs'),out=path.join(dir,'env.json');
 writeFileSync(probe,"setImmediate(()=>require('node:fs').writeFileSync(process.env.RELAY_ENV_PROBE,JSON.stringify(Object.keys(process.env).filter(k=>/^CCD_MCP_RELAY_/i.test(k)))));");
 const child=spawn(a.launch.command,a.launch.args,{env:{...process.env,...a.bootstrapEnv,CCD_MCP_RELAY_OTHER:'other-secret',RELAY_ENV_PROBE:out,NODE_OPTIONS:`--require=${JSON.stringify(probe)}`},stdio:['pipe','ignore','pipe'],windowsHide:true});child.stderr.resume();const exited=new Promise(resolve=>child.once('exit',resolve));
 try{await until(()=>existsSync(out));assert.deepEqual(JSON.parse(readFileSync(out,'utf8')),[]);await until(()=>{try{return !!r.status(a.handle)}catch{return false}})}finally{r.dispose();child.stdin.end();await exited}
});
test('bootstrap secret is separate from launch configuration and required by client',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'relay-runtime-private-')),args=makeArgs({},dir),r=createMcpRelayRuntime({isCurrent:()=>true,authorize:()=>true});
 const a=await r.register(args);assert.equal(JSON.stringify(a.launch).includes(secret(a)),false);assert.equal(a.launch.args[2],Object.keys(a.bootstrapEnv)[0]);
 const child=spawn(a.launch.command,a.launch.args,{env:{...process.env,[a.launch.args[2]]:''},stdio:'ignore',windowsHide:true});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});assert.equal(code,1);assert.throws(()=>r.status(a.handle),/not connected/);r.dispose();
});
test('closing keeps actor/server reserved until its direct child exits',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'relay-runtime-close-')),args=makeArgs({},dir),r=createMcpRelayRuntime({isCurrent:()=>true,authorize:()=>true});
 const a=await r.register(args),socket=await connect(a.launch);socket.write(secret(a)+'\n');await until(()=>{try{return !!r.status(a.handle)}catch{return false}});
 r.invalidate(a.handle);await assert.rejects(r.register(args),/already registered/);
 let replacement;await until(async()=>{try{replacement=await r.register(args);return true}catch(e){if(!/already registered/.test(e.message))throw e;return false}});assert.ok(replacement);r.dispose();socket.destroy();
});
test('unconnected and silent bootstrap expire and allow fresh registration',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'relay-runtime-timeout-')),args=makeArgs({},dir),events=[],r=createMcpRelayRuntime({isCurrent:()=>true,authorize:()=>true,onStatus:x=>events.push(x),bootstrapTimeoutMs:70});
 const a=await r.register(args);await until(()=>events.some(e=>e.handle===a.handle&&e.reason==='bootstrap timeout'));
 const b=await r.register(args),socket=await connect(b.launch);socket.resume();await until(()=>events.some(e=>e.handle===b.handle&&e.reason==='bootstrap timeout'));await until(()=>socket.destroyed||socket.readableEnded);const c=await r.register(args);assert.ok(c);r.dispose();socket.destroy();
});
test('throwing authority on handshake fails closed without spawning child',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'relay-runtime-authority-')),args=makeArgs({},dir),events=[];let throws=false;
 const r=createMcpRelayRuntime({isCurrent:()=>{if(throws)throw Error('authority failed');return true},authorize:()=>true,onStatus:x=>events.push(x)});const a=await r.register(args),socket=await connect(a.launch);throws=true;socket.write(secret(a)+'\n');await until(()=>events.some(e=>e.handle===a.handle&&e.state==='closed'));assert.throws(()=>r.status(a.handle),/not connected/);assert.equal((await import('node:fs')).existsSync(path.join(dir,'pids.log')),false);r.dispose();socket.destroy();
});
test('throwing authority after handshake revokes the connected runtime',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'relay-runtime-current-')),args=makeArgs({},dir),events=[];let throws=false;
 const r=createMcpRelayRuntime({isCurrent:()=>{if(throws)throw Error('provider internals');return true},authorize:()=>true,onStatus:x=>events.push(x)});
 const a=await r.register(args),socket=await connect(a.launch);socket.write(secret(a)+'\n');await until(()=>{try{return !!r.status(a.handle)}catch{return false}});
 throws=true;assert.throws(()=>r.status(a.handle),/stale authority/);assert.ok(events.some(e=>e.handle===a.handle&&e.state==='closed'));
 assert.throws(()=>r.status(a.handle),/not connected/);r.dispose();socket.destroy();
});
