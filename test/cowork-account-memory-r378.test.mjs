import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createCoworkGlobalMemory, ACCOUNT_MAX_BYTES, MAX_BYTES} = require('../desktop/cowork-global-memory.cjs');
const account = 'account-a', org = 'org-a';
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-account-'));
  const dir = path.join(root, 'local-agent-mode-sessions', account, org, 'memory', 'memory');
  fs.mkdirSync(dir, {recursive:true});
  let identity = {accountId: account, orgId: org};
  const store = createCoworkGlobalMemory({userDataDir:root, getAccountContext:()=>identity});
  return {root, dir, store, setIdentity: value => {identity = value;}, cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('account memories match fixed native VM for normal operations', async () => {
  const f=setup();
  try {
    const nativeDir=path.join(f.root,'native'); fs.mkdirSync(nativeDir);
    for (const dir of [f.dir,nativeDir]) {
      fs.writeFileSync(path.join(dir,'one.md'),'one'); fs.writeFileSync(path.join(dir,'two.md'),'two');
      fs.writeFileSync(path.join(dir,'MEMORY.md'),'index'); fs.writeFileSync(path.join(dir,'not.MD'),'ignored');
      fs.utimesSync(path.join(dir,'one.md'),new Date('2020-01-01'),new Date('2020-01-01'));
      fs.utimesSync(path.join(dir,'two.md'),new Date('2021-01-01'),new Date('2021-01-01'));
    }
    const source=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
    const start=source.indexOf('async function Gda('), end=source.indexOf('async function Xda(',start);
    assert.ok(start>=0 && end>start);
    const box={n:path,p:fs.promises,y4t:()=>nativeDir,
      a3:async file=>{try {const stat=await fs.promises.lstat(file); if(!stat.isFile()||stat.size>ACCOUNT_MAX_BYTES)return null;return {content:await fs.promises.readFile(file,'utf8'),mtime:stat.mtime};}catch{return null;}},
      Pda:async(file,content)=>{try {if(!(await fs.promises.lstat(file)).isFile())return false;await fs.promises.writeFile(file,content);return true;}catch{return false;}}};
    vm.createContext(box);vm.runInContext(source.slice(start,end),box);
    const nativeList=await box.Gda(account,org,true);
    assert.deepEqual(JSON.parse(JSON.stringify(nativeList)),await f.store.listAccountMemories());
    assert.deepEqual(JSON.parse(JSON.stringify(await box.Gda(account,org,false))),await f.store.listAccountMemories(false));
    assert.deepEqual(JSON.parse(JSON.stringify(await box.qda(account,org,'../one.md'))),await f.store.readAccountMemory('../one.md'));
    assert.equal(await box.Jda(account,org,'one.md','changed'),await f.store.writeAccountMemory('one.md','changed'));
    assert.equal(await box.Yda(account,org,'two.md'),await f.store.deleteAccountMemory('two.md'));
    assert.equal(await f.store.writeAccountMemory('missing.md','no'),false);
    assert.equal(await f.store.deleteAccountMemory('MEMORY.md'),false);
    assert.equal(await f.store.readAccountMemory('not.MD'),null);
  } finally {f.cleanup();}
});

test('identity, unavailable paths, basename and size boundaries', async () => {
  const f=setup();
  try {
    fs.writeFileSync(path.join(f.dir,'limit.md'),'x'.repeat(ACCOUNT_MAX_BYTES));
    fs.writeFileSync(path.join(f.dir,'large.md'),'x'.repeat(ACCOUNT_MAX_BYTES+1));
    fs.writeFileSync(path.join(f.dir,'eight.md'),'x'.repeat(MAX_BYTES));
    assert.equal((await f.store.readAccountMemory('limit.md')).content.length,ACCOUNT_MAX_BYTES);
    assert.equal(await f.store.readAccountMemory('large.md'),null);
    assert.equal(await f.store.readAccountMemory('eight.md'),null);
    assert.deepEqual((await f.store.listAccountMemories()).map(x=>x.path),['limit.md']);
    assert.equal((await f.store.listAccountMemories(false)).length,3);
    assert.equal(await f.store.writeAccountMemory('../missing.md','no'),false);
    assert.equal(await f.store.writeAccountMemory('limit.md','x'.repeat(MAX_BYTES+1)),true);
    assert.equal(await f.store.readAccountMemory('limit.md'),null);
    f.setIdentity(null);
    assert.deepEqual(await f.store.listAccountMemories(),[]);
    assert.equal(await f.store.readAccountMemory('limit.md'),null);
    assert.equal(await f.store.writeAccountMemory('limit.md','x'),false);
    assert.equal(await f.store.deleteAccountMemory('limit.md'),false);
    f.setIdentity({accountId:'../outside',orgId:org});
    assert.deepEqual(await f.store.listAccountMemories(),[]);
    f.setIdentity({accountId:account,orgId:'unknown'});
    assert.deepEqual(await f.store.listAccountMemories(),[]);
    assert.equal(await f.store.writeAccountMemory('new.md','x'),false);
  } finally {f.cleanup();}
});

test('symbolic links are not read, written, listed or deleted', async t => {
  const f=setup();
  try {
    const outside=path.join(f.root,'outside.md');fs.writeFileSync(outside,'outside');
    try {fs.symlinkSync(outside,path.join(f.dir,'link.md'),'file');}
    catch (error) {if (['EPERM','EACCES','ENOSYS'].includes(error.code)) return t.skip('file symlink creation unavailable');throw error;}
    assert.equal(await f.store.readAccountMemory('link.md'),null);
    assert.equal(await f.store.writeAccountMemory('link.md','changed'),false);
    assert.equal(await f.store.deleteAccountMemory('link.md'),false);
    assert.deepEqual(await f.store.listAccountMemories(false),[]);
    assert.equal(fs.readFileSync(outside,'utf8'),'outside');
  } finally {f.cleanup();}
});

test('redirected account memory directory is rejected', async t => {
  const f=setup();
  try {
    const outside=path.join(f.root,'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside,'secret.md'),'outside');
    fs.rmdirSync(f.dir);
    try { fs.symlinkSync(outside,f.dir,'junction'); }
    catch (error) { if (['EPERM','EACCES','ENOSYS'].includes(error.code)) return t.skip('directory junction unavailable'); throw error; }
    assert.deepEqual(await f.store.listAccountMemories(),[]);
    assert.equal(await f.store.readAccountMemory('secret.md'),null);
    assert.equal(await f.store.writeAccountMemory('secret.md','changed'),false);
    assert.equal(await f.store.deleteAccountMemory('secret.md'),false);
    assert.equal(fs.readFileSync(path.join(outside,'secret.md'),'utf8'),'outside');
  } finally {f.cleanup();}
});
