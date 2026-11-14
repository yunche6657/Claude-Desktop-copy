import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createHybridIdentityStore}=createRequire(import.meta.url)('../desktop/hybrid-identity-store.cjs');
test('identity update preserves other slots and deployment settings and rejects stale writes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hybrid-id-')),file=path.join(dir,'claude_desktop_config.json');
 const uuid='AABBCCDD-1111-2222-3333-AABBCCDDEEFF', key='hybrid:https://example.test:unknown';
 try{fs.writeFileSync(file,JSON.stringify({deploymentMode:'3p',hybridIdentity:{other:{accountUuid:uuid}}}));
  const store=createHybridIdentityStore({file});assert.equal(store.record(key,{accountUuid:uuid}),true);
  assert.equal(store.read(key).accountUuid,uuid.toLowerCase());assert.equal(store.record(key,{accountUuid:uuid}),false);
  const before=fs.readFileSync(file);let count=0;assert.equal(store.record(key,{accountUuid:'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb'},{isCurrent:()=>++count===1}),undefined);
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(JSON.parse(before).deploymentMode,'3p');assert.equal(JSON.parse(before).hybridIdentity.other.accountUuid,uuid);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
