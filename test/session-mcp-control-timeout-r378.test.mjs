import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createCcbKernel}=require('../desktop/ccb-kernel.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');

test('a CCB timeout keeps the same actor/server lane blocked despite the late control', {timeout:10000}, async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ccb-control-timeout-')),script=path.join(dir,'fixture.cjs'),log=path.join(dir,'requests.log');
 fs.writeFileSync(script,`const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{const f=JSON.parse(l);if(f.type!=='control_request')return;const r=f.request;fs.appendFileSync(${JSON.stringify(log)},r.subtype+'\\n');const body=r.subtype==='mcp_status'?{mcpServers:[{name:'srv',status:'needs-auth',scope:'project',config:{type:'http',url:'https://fixture.invalid/mcp'}}]}:{};if(r.subtype==='mcp_authenticate')return;process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:body}})+'\\n')});`);
 const backend=createCcbKernel({bunPath:process.execPath,entryPath:script,kernelRoot:dir,cwd:dir,homeDir:path.join(dir,'home'),scratchDir:path.join(dir,'scratch'),mcpControlTimeoutMs:100});
 const kernel=createSessionKernel({backend,emit(){}});t.after(async()=>{kernel.dispose();await backend.dispose();fs.rmSync(dir,{recursive:true,force:true})});
 kernel.start({sessionId:'s',cwd:dir});await backend.initialize('s');await kernel.refreshCliMcpStatus('s');
 assert.match((await kernel.mcpAuthenticateConfigServer('s','srv')).error,/did not answer/);
 assert.match((await kernel.mcpAuthenticateConfigServer('s','srv')).error,/state unknown/);
 const requests=fs.readFileSync(log,'utf8').trim().split('\n');assert.equal(requests.filter(x=>x==='mcp_authenticate').length,1);
});
