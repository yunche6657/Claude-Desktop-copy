import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const {createImportOwnershipProvider}=createRequire(import.meta.url)('../desktop/history-import-ownership.cjs');
const {createImportTransaction}=createRequire(import.meta.url)('../desktop/history-import-transaction.cjs');

function inventory() {
  return {complete:true,coverage:{allAccountsAndOrgs:true,loadedSessions:true,deletingSessions:true,tombstones:true},
    version:'v1',isCurrent:()=>true, tombstones:['DELETED'],liveClaims:['LOADED','DELETING'],records:[
      {stem:'OWN',currentTenant:true,record:{cliSessionId:'CLI',unarchivedCliSessionId:'UNARCHIVED',priorCliSessionIds:['PRIOR']}},
      {stem:'FOREIGN',currentTenant:false,record:{cliSessionId:'OTHER'}}]};
}
test('complete isolated inventory retains own, foreign, historical, loaded and deleted claims',async()=>{
  const source=inventory(), provider=createImportOwnershipProvider({readInventory:()=>source});
  const snapshot=await provider();
  assert.deepEqual([...snapshot.cliSessionIds].sort(),['cli','deleted','deleting','foreign','loaded','other','own','prior','unarchived']);
  source.records[0].record.cliSessionId='changed';
  assert.equal(snapshot.cliSessionIds.has('changed'),false);
  assert.equal(snapshot.version,'v1'); assert.equal(await snapshot.isCurrent(),true);
});
test('incomplete, malformed or stale inventory fails closed',async()=>{
  for (const mutate of [x=>x.coverage.allAccountsAndOrgs=false,x=>delete x.coverage.loadedSessions,
    x=>x.records[0].record.priorCliSessionIds=['ok',null],x=>x.records[0].record.cliSessionId=123,
    x=>x.tombstones.push(''),x=>x.isCurrent=()=>false]) {
    const x=inventory(); mutate(x);
    await assert.rejects(createImportOwnershipProvider({readInventory:()=>x})(),/inventory/i);
  }
});
test('freshness remains tied to the inventory version after projection',async()=>{
  let version=1; const source=inventory(); source.version=version; source.isCurrent=()=>version===source.version;
  const snapshot=await createImportOwnershipProvider({readInventory:()=>source})();
  assert.equal(await snapshot.isCurrent(),true); version++;
  assert.equal(await snapshot.isCurrent(),false);
});
test('transaction blocks a foreign historical claim without calling registration',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'import-ownership-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const id='12345678-1234-1234-1234-123456789abc', source=inventory();
  source.records[1].record.priorCliSessionIds=[id.toUpperCase()];
  let registered=false;
  const tx=createImportTransaction({directory:dir,getIdentity:()=>({accountId:'a',orgId:'o',generation:'g'}),
    getOwnedCliSessionIds:()=>new Set(),getOwnershipSnapshot:createImportOwnershipProvider({readInventory:()=>source}),
    register:()=>{registered=true; return 'registered';}});
  assert.deepEqual(await tx.run({sourceSessionId:id,sourceToken:'fixture'}),{status:'already-owned'});
  assert.equal(registered,false);
});
