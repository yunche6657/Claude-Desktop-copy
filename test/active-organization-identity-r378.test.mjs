import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createAccountStore} = require('../desktop/account-store.cjs');
const {createActiveOrganizationIdentity} = require('../desktop/active-organization-identity.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-org-fixture-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return createAccountStore({filePath:path.join(root, 'accounts.json')});
}
const token = (account, org, email='same@example.invalid') => ({
  accessToken:'fixture-secret', account:{uuid:account,email}, organization:{uuid:org}
});

test('account selections persist separately and unknown or foreign organizations are refused', t => {
  const store=setup(t);
  const a=store.upsertFromTokens(token('account-a','org-1'));
  store.upsertFromTokens(token('account-a','org-2'));
  assert.equal(store.list().length,1);
  assert.equal(store.setActiveOrganization('account-a','org-1'),true);
  assert.deepEqual(store.getActiveIdentity(),{accountId:'account-a',orgId:'org-1'});
  const b=store.upsertFromTokens(token('account-b','org-3'));
  assert.equal(store.list().length,2);
  assert.equal(store.setActiveOrganization('account-a','org-2'),false);
  assert.equal(store.setActiveOrganization('account-b','org-2'),false);
  store.setActive(a.id);
  assert.deepEqual(store.getActiveIdentity(),{accountId:'account-a',orgId:'org-1'});
  store.setActive(b.id);
  assert.deepEqual(store.getActiveIdentity(),{accountId:'account-b',orgId:'org-3'});
  assert.equal(JSON.stringify(store.list()).includes('fixture-secret'),false);
});

test('authoritative account-bound source changes the active org and its lease revokes', async t => {
  const store=setup(t); store.upsertFromTokens(token('account-a','org-1'));
  let epoch=1, org='org-2';
  const resolver=createActiveOrganizationIdentity({accountStore:store,readOrganization:async context=>{
    const captured=epoch;
    return {accountId:context.accountId,orgId:org,isCurrent:()=>captured===epoch};
  }});
  const identity=await resolver.acquire();
  assert.equal(identity.accountId,'account-a');assert.equal(identity.orgId,'org-2');assert.equal(identity.isCurrent(),true);
  epoch++;org='org-3';assert.equal(identity.isCurrent(),false);
  assert.equal((await resolver.acquire()).orgId,'org-3');
});

test('rejects unbound sources, expired sources, and account switch ABA during acquisition', async t => {
  const store=setup(t);const a=store.upsertFromTokens(token('account-a','org-1'));
  const b=store.upsertFromTokens(token('account-b','org-2'),{makeActive:false});
  for(const source of [null,{accountId:'account-b',orgId:'org-2',isCurrent:()=>true},
    {accountId:'account-a',orgId:'org-1'}, {accountId:'account-a',orgId:'org-1',isCurrent:()=>false}]) {
    const resolver=createActiveOrganizationIdentity({accountStore:store,readOrganization:async()=>source});
    assert.equal(await resolver.acquire(),null);
  }
  let release;const gate=new Promise(r=>release=r);
  const resolver=createActiveOrganizationIdentity({accountStore:store,readOrganization:async()=>{
    await gate;return {accountId:'account-a',orgId:'org-1',isCurrent:()=>true};
  }});
  const pending=resolver.acquire();store.setActive(b.id);store.setActive(a.id);release();
  assert.equal(await pending,null);
});
