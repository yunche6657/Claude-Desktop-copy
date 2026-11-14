import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createHybridIdentityStore}=require('../desktop/hybrid-identity-store.cjs');
const {createHybridIdentityController}=require('../desktop/hybrid-identity-controller.cjs');
test('validated grant updates owner before commit and relaunches once after persisted identity',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'identity-controller-')), file=path.join(dir,'config.json');
 const slot='hybrid:https://example.test:unknown', oidc={storeKey:slot}, uuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 try {const store=createHybridIdentityStore({file}),events=[];
  const controller=createHybridIdentityController({launchSlot:slot,store,invalidateBearer:()=>events.push('invalidate'),relaunch:()=>events.push('relaunch')});
  controller.beforePersist({oidc,accountUuid:uuid});assert.equal(controller.state.current(),uuid);assert.deepEqual(events,['invalidate']);
  await controller.afterPersist({oidc,accountUuid:uuid,isCurrent:()=>true});assert.equal(store.read(slot).accountUuid,uuid);assert.deepEqual(events,['invalidate','relaunch']);
  await controller.afterPersist({oidc,accountUuid:uuid,isCurrent:()=>true});assert.deepEqual(events,['invalidate','relaunch']);
  const restarted=createHybridIdentityController({launchSlot:slot,store,relaunch:()=>events.push('unexpected')});
  await restarted.afterPersist({oidc,accountUuid:uuid,isCurrent:()=>true});assert.deepEqual(events,['invalidate','relaunch']);
  const stale=createHybridIdentityController({launchSlot:slot,store,relaunch:()=>events.push('unexpected')});
  await stale.afterPersist({oidc,accountUuid:'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',isCurrent:()=>false});assert.equal(store.read(slot).accountUuid,uuid);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('cancelled commit cannot request relaunch even if a later current check changes',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'identity-stale-')),file=path.join(dir,'config.json');
 const store=createHybridIdentityStore({file});let checks=0,relaunches=0;
 const controller=createHybridIdentityController({launchSlot:'slot',store,relaunch:()=>relaunches++});
 try {
  await controller.afterPersist({oidc:{storeKey:'slot'},accountUuid:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',isCurrent:()=>++checks!==2});
  assert.equal(relaunches,0);assert.equal(store.read('slot'),undefined);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
