import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const impl=require('../desktop/history-import-account-manifest.cjs');
const original=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const start=original.indexOf('async function SZa(e)');
const end=original.indexOf('var TZa=',start);
assert.ok(start>=0 && end>start);
function native(read) { return vm.runInNewContext(`${original.slice(start,end)}; SZa`,{DB:read,xZa:67108864,P:e=>e?.code,N:{warn(){}}}); }
const plain=x=>JSON.parse(JSON.stringify(x));
test('original SZa VM: state and normalized fields match varied records',async()=>{
 const run={startedAt:1,completedAt:2,registeredSessionIds:['r'],createdSpaceIds:[],counts:{conversations:'3',projects:null,files:2,skipped:'bad'},extra:'kept'};
 for(const body of ['null','bad',JSON.stringify({runs:[run,{startedAt:1}],projects:{a:{spaceId:'s',name:'A',folderPath:'/a',extra:2},b:{name:'B',spaceId:'s'},c:{name:2}},localSessions:['one',4],autoCopiedSourceIds:['a',3],exports:[1],errors:[2],unknown:3}),'{}']) {
  assert.deepEqual(plain(await impl.readAccountManifest(async()=>body,'x')),plain(await native(async()=>body)('x')));
 }
 for(const code of ['ENOENT','EACCES']) {
  const read=async()=>{throw Object.assign(Error(),{code});};
  assert.deepEqual(plain(await impl.readAccountManifest(read,'x')),plain(await native(read)('x')));
 }
});
test('serialized updates merge fresh account manifest; corrupt/unreadable and stale identity do not write',async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'manifest-fixture-'));
 try {
  const file=impl.accountManifestPath(dir); let tail=Promise.resolve(); let current=true; let writes=0;
  const lock=fn=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;};
  const read=async p=>fsp.readFile(p,'utf8');
  const write=async(p,data)=>{writes++;const temp=path.join(dir,`temp-${writes}`);await fsp.writeFile(temp,data);await fsp.rename(temp,p);};
  const store=impl.createAccountManifestStore({file,readFile:read,writeAtomic:write,runExclusive:lock,isCurrent:()=>current});
  const add=id=>m=>{m.localSessions=[...new Set([...m.localSessions,id])];};
  assert.deepEqual(await Promise.all([store.update(add('a')),store.update(add('b')),store.update(add('a'))]),[true,true,true]);
  assert.deepEqual(JSON.parse(await fsp.readFile(file,'utf8')).localSessions,['a','b']);
  await fsp.writeFile(file,'{broken'); const count=writes;
  assert.equal(await store.update(add('c')),false); assert.equal(await fsp.readFile(file,'utf8'),'{broken'); assert.equal(writes,count);
  await fsp.writeFile(file,'{}'); current=false; assert.equal(await store.update(add('c')),false); assert.equal(writes,count);
  current=true; const bad=impl.createAccountManifestStore({file,readFile:async()=>{throw Object.assign(Error(),{code:'EACCES'});},writeAtomic:write,runExclusive:lock,isCurrent:()=>true});
  assert.equal(await bad.update(add('d')),false); assert.equal(writes,count);
  assert.equal(await store.update(()=>false),false); assert.equal(await store.update(add('e')),true);
 } finally {await fsp.rm(dir,{recursive:true,force:true});}
});
test('rejects async mutator and reports writer failure without hiding read failures',async()=>{
 const base={file:'synthetic',readFile:async()=>'{"localSessions":["a"]}',writeAtomic:async()=>{throw Error('write');},runExclusive:fn=>fn(),isCurrent:()=>true};
 const store=impl.createAccountManifestStore(base);
 await assert.rejects(store.update(async()=>{}),/Synchronous/);
 assert.equal(await store.update(m=>m.localSessions.push('b')),false);
 assert.equal((await impl.readAccountManifest(async()=>Buffer.alloc(impl.MAX_BYTES+1),'x')).state,'unreadable');
});
