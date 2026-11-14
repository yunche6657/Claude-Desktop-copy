import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createTerminalHistoryImport}=createRequire(import.meta.url)('../desktop/history-import-terminal.cjs');
const id='c63d48ea-53e7-48a7-95bb-b8f3ef2e7ec5';
async function setup(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-terminal-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const projectsRoot=path.join(root,'projects'), stagingDir=path.join(root,'stage'), folder=path.join(projectsRoot,'project');
 await fs.mkdir(folder,{recursive:true}); await fs.mkdir(stagingDir);
 const file=path.join(folder,`${id}.jsonl`); let identity={accountId:'a',orgId:'o',generation:'one'}; const owned=new Set(); const trusted=new Set(['/work']);
 const api=createTerminalHistoryImport({projectsRoot,stagingDir,getIdentity:()=>identity,getOwnedCliSessionIds:()=>owned,resolveTrustedCwd:cwd=>trusted.has(cwd)?cwd:null});
 return {root,file,folder,stagingDir,owned,trusted,api,setIdentity:value=>{identity=value;}};
}
const transcript=(cwd='/work')=>[JSON.stringify({type:'user',cwd,sessionId:'secret',toolUseResult:{agentId:'private',value:'ok'}}),JSON.stringify({type:'assistant',cwd,text:'hello'}),JSON.stringify({type:'queue-operation',private:'must be skipped'})].join('\n');

test('restricted terminal scan and staged copy strip ownership identifiers and require trust',async t=>{
 const f=await setup(t); await fs.writeFile(f.file,transcript());
 const list=await f.api.scan(); assert.equal(list.length,1); assert.equal(list[0].sessionId,id);
 const staged=await f.api.stage(list[0].sourceToken); assert.equal(staged.safeCwd,'/work');
 const text=await fs.readFile(staged.stagingPath,'utf8'); assert.equal(text.includes('secret'),false); assert.equal(text.includes('private'),false); assert.equal(text.split('\n').filter(Boolean).length,2);
 assert.equal(await f.api.stage(list[0].sourceToken),null); assert.equal(await fs.readFile(f.file,'utf8'),transcript());
});

test('source changes, ownership and identity changes stop staging',async t=>{
 const f=await setup(t); await fs.writeFile(f.file,transcript());
 let [entry]=await f.api.scan(); await fs.appendFile(f.file,'\n'); assert.equal(await f.api.stage(entry.sourceToken),null);
 [entry]=await f.api.scan(); f.owned.add(id); assert.equal(await f.api.stage(entry.sourceToken),null); f.owned.clear();
 [entry]=await f.api.scan(); f.setIdentity({accountId:'a',orgId:'different',generation:'two'}); assert.equal(await f.api.stage(entry.sourceToken),null);
 assert.deepEqual(await fs.readdir(f.stagingDir),[]);
});

test('untrusted cwd, unknown entrypoint and hardlinked source are excluded',async t=>{
 const f=await setup(t); await fs.writeFile(f.file,transcript('/other')); assert.equal((await f.api.scan()).length,0);
 await fs.writeFile(f.file,JSON.stringify({type:'user',cwd:'/work',entrypoint:'other'})); assert.equal((await f.api.scan()).length,0);
 await fs.writeFile(f.file,transcript()); const link=path.join(f.root,'hardlink'); await fs.link(f.file,link); assert.equal((await f.api.scan()).length,0);
});

test('ambiguous duplicate IDs are not offered and concurrent staging runs once',async t=>{
 const f=await setup(t); await fs.writeFile(f.file,transcript());
 const other=path.join(path.dirname(f.folder),'other'); await fs.mkdir(other); await fs.writeFile(path.join(other,`${id}.jsonl`),transcript());
 assert.equal((await f.api.scan()).length,0);
 await fs.rm(path.join(other,`${id}.jsonl`)); const [entry]=await f.api.scan();
 const values=await Promise.all([f.api.stage(entry.sourceToken),f.api.stage(entry.sourceToken)]);
 assert.equal(values.filter(Boolean).length,1); assert.equal((await fs.readdir(f.stagingDir)).length,1);
});

test('a failed scan invalidates all earlier source tokens',async t=>{
 const f=await setup(t); await fs.writeFile(f.file,transcript()); const [entry]=await f.api.scan();
 f.setIdentity(null); await assert.rejects(f.api.scan(),/identity unavailable/);
 f.setIdentity({accountId:'a',orgId:'o',generation:'one'});
 assert.equal(await f.api.stage(entry.sourceToken),null);
 assert.deepEqual(await fs.readdir(f.stagingDir),[]);
});

test('failed scan invalidates a stage already waiting for cwd trust',async t=>{
 const f=await setup(t); await fs.writeFile(f.file,transcript());
 let identity={accountId:'a',orgId:'o',generation:'one'}, pause=false, release, signal;
 const entered=new Promise(resolve=>{signal=resolve;});
 const resume=new Promise(resolve=>{release=resolve;});
 const api=createTerminalHistoryImport({projectsRoot:path.dirname(f.folder),stagingDir:f.stagingDir,getIdentity:()=>identity,getOwnedCliSessionIds:()=>new Set(),resolveTrustedCwd:async cwd=>{if(pause){signal(); await resume;}return cwd;}});
 const [entry]=await api.scan(); pause=true;
 const staging=api.stage(entry.sourceToken); await entered;
 identity=null; await assert.rejects(api.scan(),/identity unavailable/);
 identity={accountId:'a',orgId:'o',generation:'one'}; release();
 await assert.rejects(staging,/scan changed/);
 assert.deepEqual(await fs.readdir(f.stagingDir),[]);
});

test('SSH sources are excluded and accepted staged timestamps reflect rows with cwd',async t=>{
 const f=await setup(t); const ssh=path.join(path.dirname(f.folder),'ssh-server'); await fs.mkdir(ssh);
 await fs.writeFile(path.join(ssh,`${id}.jsonl`),transcript()); assert.deepEqual(await f.api.scan(),[]);
 const rows=[{type:'user',cwd:'/work',timestamp:'2024-02-02T00:00:00Z'},{type:'assistant',cwd:'/work',timestamp:'2024-01-01T00:00:00Z'},{type:'system',timestamp:'2000-01-01T00:00:00Z'}];
 await fs.writeFile(f.file,rows.map(row=>JSON.stringify(row)).join('\n'));
 const [entry]=await f.api.scan(); assert.equal(entry.title,'Terminal session'); assert.equal(entry.accountId,'');
 const staged=await f.api.stage(entry.sourceToken); assert.equal(staged.createdAt,Date.parse('2024-01-01T00:00:00Z')); assert.equal(staged.lastActivityAt,Date.parse('2024-02-02T00:00:00Z'));
});
