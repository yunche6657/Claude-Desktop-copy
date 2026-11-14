import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createPreviewLaunch,readConfigurations,buildLaunchCommand}=require('../desktop/preview-launch.cjs');
const root=path.resolve('.tmp/preview-launch-tests');
fs.mkdirSync(root,{recursive:true});
async function fixture(source,port=0){
 const dir=fs.mkdtempSync(path.join(root,'case-'));
 fs.mkdirSync(path.join(dir,'.claude'));
 fs.writeFileSync(path.join(dir,'server.cjs'),source);
 fs.writeFileSync(path.join(dir,'.claude/launch.json'),JSON.stringify({configurations:[{name:'fixture',runtimeExecutable:process.execPath,runtimeArgs:[path.join(dir,'server.cjs')],port}]}));
 return {dir,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
const serverSource="const h=require('node:http').createServer((q,r)=>r.end('REAL_PREVIEW_BYTES'));h.listen(0,'127.0.0.1',()=>{console.log('http://127.0.0.1:'+h.address().port);console.error('stderr-visible');});";
async function get(url){return new Promise((resolve,reject)=>{http.get(url,r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(s));}).on('error',reject);});}
async function isOpen(port){return new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});}

test('only trusted project configuration can start a process',async()=>{
 const f=await fixture(serverSource);const host=createPreviewLaunch();
 try{assert.equal(readConfigurations(f.dir)[0].name,'fixture');const r=await host.startFromConfig(f.dir,'fixture');assert.equal(r.refused,true);assert.deepEqual(host.getActiveServers(),[]);assert.deepEqual(await host.startFromConfig(path.join(f.dir,'missing')), {error:'Project directory is unavailable'});}
 finally{await host.dispose();f.cleanup();}
});

test('real HTTP readiness, logs, snapshots and concurrent starts share one owned process',async()=>{
 const f=await fixture(serverSource);const events=[];const host=createPreviewLaunch({isTrusted:()=>true,emit:(...a)=>events.push(a)});
 let port;
 try{const [a,b]=await Promise.all([host.startFromConfig(f.dir,'fixture','session-fixture'),host.startFromConfig(f.dir,'fixture','session-fixture')]);assert.ok(a.serverId);assert.equal(a.serverId,b.serverId);assert.equal(host.getActiveServers().length,1);const row=host.getActiveServers()[0];port=row.port;assert.equal(row.status,'running');assert.equal(row.sessionId,'session-fixture');assert.equal(await get(host.getPreviewUrl(a.serverId)),'REAL_PREVIEW_BYTES');assert.ok(host.getLogs(a.serverId).some(x=>x.stream==='stderr'&&x.line==='stderr-visible'));assert.ok(events.some(e=>e[0]==='activeServers'&&e[1][0].status==='starting'));assert.ok(events.some(e=>e[0]==='activeServers'&&e[1][0].status==='running'));const copy=host.getActiveServers();copy[0].status='fake';assert.equal(host.getActiveServers()[0].status,'running');assert.equal(await host.stopServer(a.serverId),true);assert.equal(host.getPreviewUrl(a.serverId),null);assert.equal(host.getActiveServers()[0].status,'stopped');assert.equal(await isOpen(port),false);assert.equal(await host.stopServer('foreign-pid'),false);}
 finally{await host.dispose();f.cleanup();}
});

test('busy port is refused without adopting an unrelated HTTP service',async()=>{
 const server=http.createServer((q,r)=>r.end('FOREIGN'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;const f=await fixture(serverSource,port);const host=createPreviewLaunch({isTrusted:()=>true});
 try{const r=await host.startFromConfig(f.dir);assert.match(r.error,/already in use/);assert.deepEqual(host.getActiveServers(),[]);assert.equal(await get('http://127.0.0.1:'+port),'FOREIGN');}
 finally{await host.dispose();await new Promise(r=>server.close(r));f.cleanup();}
});

test('timeout and spawn errors are explicit and never produce ready URLs',async()=>{
 const f=await fixture("console.log('not-ready');setInterval(()=>{},1000);");const host=createPreviewLaunch({isTrusted:()=>true,startTimeoutMs:300,pollIntervalMs:20});
 try{const r=await host.startFromConfig(f.dir);assert.match(r.error,/timeout/);const row=host.getActiveServers()[0];assert.equal(row.status,'error');assert.equal(host.getPreviewUrl(row.serverId),null);assert.equal(await host.stopServer(row.serverId),true);}
 finally{await host.dispose();f.cleanup();}
 const bad=await fixture(serverSource);const config=path.join(bad.dir,'.claude/launch.json');fs.writeFileSync(config,JSON.stringify({configurations:[{name:'bad',runtimeExecutable:path.join(bad.dir,'absent.exe'),runtimeArgs:[]}]}));const failed=createPreviewLaunch({isTrusted:()=>true,startTimeoutMs:500});
 try{const r=await failed.startFromConfig(bad.dir);assert.match(r.error,/Could not start/);assert.equal(failed.getActiveServers()[0].status,'error');assert.equal(failed.getPreviewUrl(failed.getActiveServers()[0].serverId),null);}
 finally{await failed.dispose();bad.cleanup();}
});

test('dispose cancels pending launch and refuses any subsequent startup',async()=>{
 const f=await fixture("setInterval(()=>{},1000);");const host=createPreviewLaunch({isTrusted:()=>true,startTimeoutMs:5000,pollIntervalMs:20});
 try{const pending=host.startFromConfig(f.dir);await new Promise(r=>setTimeout(r,100));await host.dispose();const result=await pending;assert.match(result.error,/cancelled/);assert.equal(host.getActiveServers()[0].status,'stopped');assert.match((await host.startFromConfig(f.dir)).error,/closed/);await host.dispose();}
 finally{await host.dispose();f.cleanup();}
});

test('owned process-tree stop closes an actual descendant HTTP server',async()=>{
 const source="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"+JSON.stringify(serverSource)+"],{windowsHide:true,stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);";
 const f=await fixture(source);const host=createPreviewLaunch({isTrusted:()=>true});
 try{const r=await host.startFromConfig(f.dir);assert.ok(r.serverId);const port=host.getActiveServers()[0].port;assert.equal(await isOpen(port),true);await host.dispose();assert.equal(await isOpen(port),false);assert.equal(host.getActiveServers()[0].status,'stopped');}
 finally{await host.dispose();f.cleanup();}
});

test('Windows batch commands use literal arguments and reject shell expansion',()=>{
 const c=buildLaunchCommand('C:\\tools\\npm.cmd',['run','dev','--','a b'],{},'win32');assert.match(c.executable,/cmd.exe$/i);assert.equal(c.windowsVerbatimArguments,true);assert.equal(c.args[0],'/d');assert.throws(()=>buildLaunchCommand('npm.cmd',['run','dev&calc'],{},'win32'),/shell characters/);assert.throws(()=>buildLaunchCommand('node',['bad\narg'],{},'win32'),/Invalid/);
});


test('configuration symlink cannot redirect launch.json outside the project',async()=>{
 const f=await fixture(serverSource);const outside=await fixture(serverSource);
 try{fs.unlinkSync(path.join(f.dir,'.claude/launch.json'));fs.rmdirSync(path.join(f.dir,'.claude'));fs.symlinkSync(path.join(outside.dir,'.claude'),path.join(f.dir,'.claude'),'junction');assert.deepEqual(readConfigurations(f.dir),[]);}
 finally{f.cleanup();outside.cleanup();}
});

test('unexpected process exit revokes its URL and bounded logs do not expose mutable state',async()=>{
 const source="console.log('x'.repeat(30000));console.log('line-two');console.log('line-three');"+serverSource+"setTimeout(()=>process.exit(9),500);";
 const f=await fixture(source);const host=createPreviewLaunch({isTrusted:()=>true,maxLogLines:3,maxLogBytes:20000});
 try{const r=await host.startFromConfig(f.dir);assert.ok(r.serverId);assert.ok(host.getPreviewUrl(r.serverId));const logs=host.getLogs(r.serverId);assert.ok(logs.length<=3);assert.ok(logs.reduce((n,x)=>n+Buffer.byteLength(x.line),0)<=20000);logs[0].line='MUTATED';assert.ok(host.getLogs(r.serverId).every(x=>x.line!=='MUTATED'));await new Promise(r=>setTimeout(r,650));assert.equal(host.getActiveServers()[0].status,'error');assert.equal(host.getPreviewUrl(r.serverId),null);assert.ok(host.getLogs(r.serverId).some(x=>x.line.includes('exited (9)')));}
 finally{await host.dispose();f.cleanup();}
});
