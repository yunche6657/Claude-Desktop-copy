import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const original = fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js', import.meta.url),'utf8');
const start = original.indexOf('async registerExternalSession(e){');
const end = original.indexOf('async confirmImportedSessionResume(e){',start);
assert.ok(start >= 0 && end > start);

function fixture({staging='/storage/imported-staging/.import-fixture.tmp', onSave}={}) {
 const calls=[]; const files=new Map([[staging,'fixture']]);
 const t={e4:'local_', $2:'imported-staging', $7:x=>typeof x==='string' && /^uuid-\d$/.test(x), $F:()=> 'none', oW:x=>x, iD:x=>x? 'encoded':null,
   i7:async()=>{}, u7:fn=>fn(), f7:async(p,content)=>{calls.push(['save',p]); files.set(p,content); await onSave?.(manager);}, U:()=>false,
   L5:{warn(){}}};
 const Z={default:{promises:{rename:async(a,b)=>{calls.push(['rename',a,b]); if(!files.has(a)) throw Error('missing'); files.set(b,files.get(a)); files.delete(a);}, unlink:async p=>{calls.push(['unlink',p]); files.delete(p);}}}};
 const n={hr:x=>x,kt:(id,e,cwd,createdAt,lastActivityAt,indexedAt,stagedTranscriptPath)=>({sessionId:id,cliSessionId:e.cliSessionId,cwd,stagedTranscriptPath}),Pt:x=>x};
 const Native=vm.runInNewContext(`(class { ${original.slice(start,end)} })`,{t,n,Z,X:path.posix,FD:()=>false});
 const manager=new Native(); Object.assign(manager,{currentAccountId:'acct',currentOrgId:'org',sessions:new Map(),
   waitForInitialization:async()=>{}, ensureArchivedSessionsLoaded:async()=>{}, ensureStorageDir:async()=>'/storage',
   held:()=>undefined,hasLoadedSessions:()=>true,archivedIdsHint:{note(){}}, emitSessionUpdated:()=>calls.push(['emit'])});
 return {manager,files,calls,input:{sessionId:'uuid-1',cliSessionId:'uuid-2',cwd:'/workspace',transcriptStagingPath:staging,importedFrom:'terminal-cli'}};
}

test('native registration moves private staging to new CLI UUID and persists before event',async()=>{
 const f=fixture(); assert.equal(await f.manager.registerExternalSession(f.input),'registered');
 assert.equal(f.files.get('/storage/imported-staging/uuid-2.jsonl'),'fixture');
 const record=JSON.parse(f.files.get('/storage/local_uuid-1.json'));
 assert.equal(record.stagedTranscriptPath,'/storage/imported-staging/uuid-2.jsonl');
 assert.deepEqual(f.calls.map(x=>x[0]),['rename','save','emit']);
 assert.equal(f.manager.sessions.get('local_uuid-1').homeTenancy.orgId,'org');
});

test('native registration rejects unowned staging and invalid UUID before any write',async()=>{
 const f=fixture({staging:'/elsewhere/file.tmp'}); assert.equal(await f.manager.registerExternalSession(f.input),'rejected'); assert.deepEqual(f.calls,[]);
 const g=fixture(); g.input.cliSessionId='../unsafe'; assert.equal(await g.manager.registerExternalSession(g.input),'rejected'); assert.deepEqual(g.calls,[]);
});

test('native registration removes just-created fixture files if account changes during save',async()=>{
 const f=fixture({onSave:m=>{m.currentOrgId='other';}});
 await assert.rejects(f.manager.registerExternalSession(f.input),/account changed/);
 assert.deepEqual(f.calls.map(x=>x[0]),['rename','save','unlink','unlink']);
 assert.equal(f.files.size,0); assert.equal(f.manager.sessions.size,0);
});

