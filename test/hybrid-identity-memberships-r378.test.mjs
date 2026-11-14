import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createHybridIdentityController}=require('../desktop/hybrid-identity-controller.cjs');
const {createHybridIdentityStore}=require('../desktop/hybrid-identity-store.cjs');
const {createHybridMemberships}=require('../desktop/hybrid-memberships.cjs');
const {deriveHybridOidc}=require('../desktop/hybrid-oidc-session.cjs');
const url='https://api.anthropic.com/v1/desktop/orgs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/bootstrap';
const slot=deriveHybridOidc(url).storeKey, first='11111111-2222-3333-4444-555555555555', second='aaaaaaaa-2222-3333-4444-555555555555';
const response=(id,tag)=>({ok:true,json:async()=>({uuid:id,tagged_id:tag,memberships:[]})});

test('membership owner and tagged identity are persisted without applying/relaunching',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'identity-membership-r378-'));
 try {
  const store=createHybridIdentityStore({file:path.join(dir,'config.json')});store.record(slot,{accountUuid:first,accountTaggedId:'old'});
  let restarts=0,events=0;
  const controller=createHybridIdentityController({launchSlot:slot,store,relaunch:()=>{restarts++}});
  controller.state.onChange(()=>events++);
  const members=createHybridMemberships({fetch:async()=>response(second.toUpperCase(),'new-tag'),...controller.membershipIdentity});
  await members.prime('https://fixture.invalid','fixture',false,{bootstrapUrl:url});
  assert.equal(controller.state.current(),second);assert.equal(events,1);assert.equal(controller.state.matchesLaunch(),false);
  assert.deepEqual(store.read(slot),{accountUuid:second,accountTaggedId:'new-tag'});assert.equal(restarts,0);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('membership generation guard blocks late storage and does not trigger relaunch',async()=>{
 let release,started;const wait=new Promise(r=>release=r),entered=new Promise(r=>started=r);let writes=0,restarts=0;
 const store={read:()=>({accountUuid:first}),record:async(_slot,_identity,{isCurrent})=>{started();await wait;if(!isCurrent())return undefined;writes++;return true;}};
 const controller=createHybridIdentityController({launchSlot:slot,store,relaunch:()=>{restarts++}});
 const members=createHybridMemberships({fetch:async()=>response(second,'tag'),...controller.membershipIdentity});
 const pending=members.prime('https://fixture.invalid','fixture',false,{bootstrapUrl:url});
 await entered;members.invalidate();release();await pending;
 assert.equal(writes,0);assert.equal(restarts,0);
});

test('unchanged account without tag preserves existing tag and apply does not restart same launch identity',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'identity-tag-r378-'));
 try{
  const store=createHybridIdentityStore({file:path.join(dir,'config.json')});store.record(slot,{accountUuid:first,accountTaggedId:'saved'});
  let restarts=0;const c=createHybridIdentityController({launchSlot:slot,store,relaunch:()=>{restarts++}});
  const m=createHybridMemberships({fetch:async()=>response(first.toUpperCase(),undefined),...c.membershipIdentity});
  await m.prime('https://fixture.invalid','fixture',false,{bootstrapUrl:url});
  assert.deepEqual(store.read(slot),{accountUuid:first,accountTaggedId:'saved'});
  await c.afterPersist({oidc:{storeKey:slot},accountUuid:first,isCurrent:()=>true});assert.equal(restarts,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('latched non-hybrid launch relaunches once on applied hybrid identity; membership alone does not',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'identity-nonhybrid-r378-'));
 try{
  const store=createHybridIdentityStore({file:path.join(dir,'config.json')});let restarts=0;
  const c=createHybridIdentityController({launchSlot:undefined,store,relaunch:()=>{restarts++}});
  const m=createHybridMemberships({fetch:async()=>response(first,'fixture-tag'),...c.membershipIdentity});
  await m.prime('https://fixture.invalid','fixture',false,{bootstrapUrl:url});
  assert.equal(restarts,0);
  await c.afterPersist({oidc:{storeKey:slot},accountUuid:first,isCurrent:()=>true});
  assert.equal(restarts,1);
  await c.afterPersist({oidc:{storeKey:slot},accountUuid:first,isCurrent:()=>true});
  assert.equal(restarts,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
