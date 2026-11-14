import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {createCoworkGlobalMemory, MAX_BYTES}=createRequire(import.meta.url)('../desktop/cowork-global-memory.cjs');
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-memory-'));
const a='11111111-aaaa-bbbb-cccc-111111111111', b='22222222-aaaa-bbbb-cccc-222222222222';
const o='33333333-aaaa-bbbb-cccc-333333333333';

test('global instructions follow account and organisation and persist', async () => {
  const dir=fixture(); let identity=null;
  try {
    const opts={userDataDir:dir,getAccountContext:()=>identity};
    const store=createCoworkGlobalMemory(opts);
    assert.equal(await store.readGlobalMemory(),null);
    assert.equal(await store.writeGlobalMemory('one'),false);
    identity={accountId:a,orgId:o};
    assert.equal(await store.readGlobalMemory(),null);
    assert.equal(await store.writeGlobalMemory('one'),true);
    const file=path.join(dir,'local-agent-mode-sessions',a,o,'memory','CLAUDE.md');
    assert.equal(fs.readFileSync(file,'utf8'),'one');
    assert.equal(await createCoworkGlobalMemory(opts).readGlobalMemory(),'one');
    identity={accountId:b,orgId:o};
    assert.equal(await store.readGlobalMemory(),null);
    assert.equal(await store.writeGlobalMemory('two'),true);
    identity={accountId:a,orgId:b};
    assert.equal(await store.readGlobalMemory(),null);
    identity={accountId:a,orgId:o};
    assert.equal(await store.readGlobalMemory(),'one');
    identity={accountId:'../escape',orgId:o};
    assert.equal(await store.writeGlobalMemory('bad'),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('native read and write functions agree on missing and normal content', async () => {
  const dir=fixture();
  try {
    const source=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
    const start=source.indexOf('function Fda(e,t)');
    const end=source.indexOf('async function Bda(',start);
    assert.ok(start>=0 && end>start);
    const box={n:path,p:fs.promises,v4t:(account,org)=>path.join(dir,'native',account,org,'memory'),
      a3:async file=>{try{return {content:await fs.promises.readFile(file,'utf8')}}catch{return null}},
      ci:async folder=>fs.promises.mkdir(folder,{recursive:true}),Qr:async(file,text)=>fs.promises.writeFile(file,text)};
    vm.createContext(box);vm.runInContext(source.slice(start,end),box);
    const store=createCoworkGlobalMemory({userDataDir:dir,getAccountContext:()=>({accountId:a,orgId:o})});
    assert.equal(await box.Rda(a,o),await store.readGlobalMemory());
    assert.equal(await box.zda(a,o,'example'),await store.writeGlobalMemory('example'));
    assert.equal(await box.Rda(a,o),await store.readGlobalMemory());
    const largerThanReadLimit='x'.repeat(MAX_BYTES+1);
    assert.equal(await box.zda(a,o,largerThanReadLimit),await store.writeGlobalMemory(largerThanReadLimit));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('8 MiB boundary, unsafe target and short path compatibility', async () => {
  const dir=fixture();
  try {
    const opts={userDataDir:dir,getAccountContext:()=>({accountId:a,orgId:o})};
    const store=createCoworkGlobalMemory(opts);
    const exact='x'.repeat(MAX_BYTES);
    assert.equal(await store.writeGlobalMemory(exact),true);
    assert.equal((await store.readGlobalMemory()).length,MAX_BYTES);
    assert.equal(await store.writeGlobalMemory(exact+'x'),true);
    assert.equal(await store.readGlobalMemory(),null);
    const file=path.join(dir,'local-agent-mode-sessions',a,o,'memory','CLAUDE.md');
    fs.writeFileSync(file,exact+'x');
    assert.equal(await store.readGlobalMemory(),null);
    const shortStore=createCoworkGlobalMemory({...opts,shortPaths:true});
    assert.equal(await shortStore.writeGlobalMemory('legacy'),true);
    assert.equal(fs.readFileSync(file,'utf8'),'legacy');
    fs.unlinkSync(file); fs.mkdirSync(file);
    assert.equal(await store.writeGlobalMemory('blocked'),false);
    assert.equal(await store.readGlobalMemory(),null);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
