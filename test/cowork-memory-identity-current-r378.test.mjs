import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createCoworkGlobalMemory}=createRequire(import.meta.url)('../desktop/cowork-global-memory.cjs');

test('memory does not publish a write after its identity becomes stale',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-identity-current-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let current=true;const identity={accountId:'account',orgId:'org',isCurrent:()=>current};
 const memory=createCoworkGlobalMemory({userDataDir:root,getAccountContext:()=>identity});
 assert.equal(await memory.writeGlobalMemory('original'),true);
 const write=fs.writeFileSync;try{fs.writeFileSync=function(file,...args){const result=write.call(this,file,...args);if(String(file).endsWith('.tmp'))current=false;return result};
  assert.equal(await memory.writeGlobalMemory('stale'),false);
 }finally{fs.writeFileSync=write}
 current=true;assert.equal(await memory.readGlobalMemory(),'original');current=false;assert.equal(await memory.readGlobalMemory(),null);
});
