import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const {registerBridgeServices}=require('../desktop/bridge-services.cjs');
const digest=text=>crypto.createHash('sha256').update(text,'utf8').digest('hex');

async function fixture(check) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'session-editor-'));
  const root=path.join(dir,'workspace'),outside=path.join(dir,'outside');
  fs.mkdirSync(root);fs.mkdirSync(outside);
  const handlers=new Map();
  const kernel=createSessionKernel({emit(){},createAgent:()=>({run(){}})});
  const bridge=registerBridgeServices({ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler:c=>handlers.delete(c)},bridgeMap:require('../desktop/shim/bridge-map.json'),
    getMainWindow:()=>null,settings:{kernelFactory:()=>kernel},frontend:{root:process.cwd()}});
  const session=kernel.start({cwd:root});
  const call=(name,...args)=>{
    const channel=[...handlers.keys()].find(c=>c.includes('_$_LocalSessions_$_')&&c.endsWith('_$_'+name));
    assert.ok(channel,'missing bridge channel '+name);
    return handlers.get(channel)({},session.sessionId,...args);
  };
  try {await check({root,outside,session,kernel,call});}
  finally {bridge.dispose();assert.ok(dir.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
}

test('editor reads a canonical path and text hash, then saves through the real bridge',()=>fixture(async({root,call})=>{
  const file=path.join(root,'中文.md');fs.writeFileSync(file,'原文\r\n');
  const read=await call('readSessionFile','中文.md');
  assert.equal(read.absPath,file);assert.equal(read.hash,digest('原文\r\n'));assert.equal(read.fileSize,Buffer.byteLength('原文\r\n'));
  const saved=await call('writeSessionFile',read.absPath,'修改后\n',read.hash);
  assert.deepEqual(saved,{status:'ok',hash:digest('修改后\n')});
  assert.equal(fs.readFileSync(file,'utf8'),'修改后\n');
}));

test('a stale or deleted file conflicts without overwriting external changes',()=>fixture(async({root,call})=>{
  const file=path.join(root,'a.txt');fs.writeFileSync(file,'before');
  const read=await call('readSessionFile',file);
  fs.writeFileSync(file,'external');
  assert.deepEqual(await call('writeSessionFile',file,'mine',read.hash),{status:'conflict',currentHash:digest('external')});
  assert.equal(fs.readFileSync(file,'utf8'),'external');
  fs.unlinkSync(file);
  assert.equal((await call('writeSessionFile',file,'mine',read.hash)).status,'conflict');
  assert.equal(fs.existsSync(file),false);
}));

test('create is exclusive, creates parent folders, and never truncates an existing file',()=>fixture(async({root,call})=>{
  const file=path.join(root,'new','a.txt');
  assert.deepEqual(await call('createSessionFile',file),{status:'ok'});
  assert.equal(fs.readFileSync(file,'utf8'),'');fs.writeFileSync(file,'keep');
  assert.deepEqual(await call('createSessionFile',file),{status:'conflict'});
  assert.equal(fs.readFileSync(file,'utf8'),'keep');
  assert.equal((await call('createSessionFile','scratchpad/no.txt')).status,'denied');
  assert.equal((await call('createSessionFile','trailing/')).status,'denied');
}));

test('upstream hook-manager keys are protected while unrelated package edits remain writable',()=>fixture(async({root,call})=>{
  const file=path.join(root,'package.json');const before='{"name":"old","husky":{"a":"b"}}';fs.writeFileSync(file,before);
  assert.deepEqual(await call('writeSessionFile',file,'{"name":"new","husky":{"a":"c"}}',digest(before)),{status:'denied',deniedReason:'hook_manager_package_key'});
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal((await call('writeSessionFile',file,'{"name":"new","husky":{"a":"b"}}',digest(before))).status,'ok');
}));

test('read grants do not silently become write grants',()=>fixture(async({outside,kernel,session,call})=>{
  const file=path.join(outside,'read-only.txt');fs.writeFileSync(file,'outside');
  kernel.update(session.sessionId,{additionalDirectories:[outside]});
  const read=await call('readSessionFile',file);
  assert.equal(read.contents,'outside');assert.equal(read.hash,undefined);
  assert.equal((await call('writeSessionFile',file,'bad')).status,'denied');
  assert.equal((await call('createSessionFile',path.join(outside,'new.txt'))).status,'denied');
  assert.equal(fs.readFileSync(file,'utf8'),'outside');
}));

test('concurrent optimistic saves cannot both succeed against the same old hash',()=>fixture(async({root,call})=>{
  const file=path.join(root,'parallel.txt');fs.writeFileSync(file,'old');
  const results=await Promise.all([call('writeSessionFile',file,'one',digest('old')),call('writeSessionFile',file,'two',digest('old'))]);
  assert.deepEqual(results.map(r=>r.status).sort(),['conflict','ok']);
  assert.ok(['one','two'].includes(fs.readFileSync(file,'utf8')));
}));

test('a path alias escaping the workspace cannot be used to write another folder',()=>fixture(async({root,outside,call})=>{
  const file=path.join(outside,'keep.txt');fs.writeFileSync(file,'keep');
  fs.symlinkSync(outside,path.join(root,'alias'),process.platform==='win32'?'junction':'dir');
  assert.equal((await call('writeSessionFile',path.join(root,'alias','keep.txt'),'bad')).status,'denied');
  assert.equal(fs.readFileSync(file,'utf8'),'keep');
}));

test('the native 10 MiB text cap is separate from the smaller inline media limit',()=>fixture(async({root,call})=>{
  const file=path.join(root,'larger.txt');fs.writeFileSync(file,'x'.repeat(1024*1024+1));
  assert.equal((await call('readSessionFileWithStatus',file)).status,'ok');
  assert.equal((await call('readSessionFile',file,{includeHash:false})).hash,undefined);
}));
