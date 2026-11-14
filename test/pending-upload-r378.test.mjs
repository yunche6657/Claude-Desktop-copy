import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {savePendingUpload}=require('../desktop/pending-upload.cjs');

test('unrestricted staged upload uses a unique name and preserves bytes', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pending-upload-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const args={userDataDir:dir,fileName:'fixture.txt',content:Buffer.from('fixture bytes').toString('base64'),isCurrent:()=>true};
  const first=await savePendingUpload(args),second=await savePendingUpload(args);
  assert.notEqual(first,second); assert.equal(path.dirname(first),path.join(dir,'pending-uploads'));
  assert.match(path.basename(first),/^[0-9a-f-]{36}-fixture\.txt$/);
  assert.equal(fs.readFileSync(first,'utf8'),'fixture bytes'); assert.equal(fs.readFileSync(second,'utf8'),'fixture bytes');
});

test('a revoked deployment mode removes its staged file and a junction is refused', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pending-upload-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0;
  assert.equal(await savePendingUpload({userDataDir:dir,fileName:'a',content:'YQ==',isCurrent:()=>++calls<3}),null);
  assert.deepEqual(fs.readdirSync(path.join(dir,'pending-uploads')),[]);
  fs.rmdirSync(path.join(dir,'pending-uploads'));
  const outside=path.join(dir,'outside');fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(dir,'pending-uploads'),'junction');
  assert.equal(await savePendingUpload({userDataDir:dir,fileName:'a',content:'YQ==',isCurrent:()=>true}),null);
  assert.deepEqual(fs.readdirSync(outside),[]);
});

test('3p bridge stages pasted files under its isolated userData rather than the workspace', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pending-bridge-'));
  const oldLocal=process.env.LOCALAPPDATA,oldApp=process.env.APPDATA;
  t.after(()=>{if(oldLocal===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=oldLocal;if(oldApp===undefined)delete process.env.APPDATA;else process.env.APPDATA=oldApp;fs.rmSync(dir,{recursive:true,force:true});});
  process.env.LOCALAPPDATA=path.join(dir,'local');process.env.APPDATA=path.join(dir,'app');
  const configDir=path.join(process.env.LOCALAPPDATA,'Claude-3p');fs.mkdirSync(configDir,{recursive:true});
  fs.writeFileSync(path.join(configDir,'claude_desktop_config.json'),JSON.stringify({deploymentMode:'3p'}));
  const userData=path.join(dir,'userdata'),workspace=path.join(dir,'workspace');fs.mkdirSync(userData);fs.mkdirSync(workspace);
  const handlers=new Map();
  require('../desktop/bridge-services.cjs').registerBridgeServices({ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn),removeHandler:ch=>handlers.delete(ch)},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>null,settings:{dataDir:path.join(dir,'data'),projectPath:workspace},frontend:{root:workspace},coworkMemoryUserDataDir:userData});
  const handler=[...handlers].find(([key])=>key.endsWith('_$_FileSystem_$_savePastedFile'))?.[1];assert.ok(handler);
  const result=await handler({},Buffer.from('isolated').toString('base64'),'text/plain','notes.txt');
  assert.equal(path.dirname(result.path),path.join(userData,'pending-uploads'));
  assert.equal(fs.readFileSync(result.path,'utf8'),'isolated');assert.deepEqual(fs.readdirSync(workspace),[]);
});
