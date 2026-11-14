import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createDeploymentMode}=require('../desktop/deployment-mode.cjs');
const {createHybridIdentityStore}=require('../desktop/hybrid-identity-store.cjs');

test('parallel application tasks preserve mode, identity slots and unrelated keys in the shared file',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hybrid-config-concurrency-')),file=path.join(dir,'claude_desktop_config.json');
 const identity=createHybridIdentityStore({file});const mode=createDeploymentMode({getConfigPath:()=>file});
 const uuid=i=>`${i.toString(16).padStart(8,'0')}-1111-2222-3333-444444444444`;
 try {
  fs.writeFileSync(file,JSON.stringify({deploymentMode:'1p',unrelated:{keep:true}}));
  await Promise.all(Array.from({length:20},(_,i)=>Promise.resolve().then(()=>identity.record(`slot-${i}`,{accountUuid:uuid(i)}))).concat([Promise.resolve().then(()=>mode.set('3p'))]));
  const data=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(data.deploymentMode,'3p');assert.deepEqual(data.unrelated,{keep:true});
  for(let i=0;i<20;i++)assert.equal(data.hybridIdentity[`slot-${i}`].accountUuid,uuid(i));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('failed identity commit leaves existing deployment file intact',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hybrid-config-failure-')),file=path.join(dir,'claude_desktop_config.json');
 const store=createHybridIdentityStore({file}), original=fs.renameSync;
 try {fs.writeFileSync(file,JSON.stringify({deploymentMode:'3p',unrelated:'preserve'}));const before=fs.readFileSync(file);
  fs.renameSync=()=>{const e=Error('fixture failure');e.code='EIO';throw e;};
  assert.throws(()=>store.record('slot',{accountUuid:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}),/fixture failure/);
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(dir),['claude_desktop_config.json']);
 } finally {fs.renameSync=original;fs.rmSync(dir,{recursive:true,force:true});}
});
