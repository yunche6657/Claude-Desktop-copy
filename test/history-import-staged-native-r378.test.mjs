import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js', import.meta.url), 'utf8');
const begin = source.indexOf('async confirmImportedSessionResume(e){');
const end = source.indexOf('async deleteSession(e,t){', begin);
assert.ok(begin >= 0 && end > begin);

function fixture({renameError, targetExists = false, cwdKey = 'encoded', cliSessionId = 'cli-id', saveError} = {}) {
  const files = new Map([['/stage/transcript.jsonl', 'staged'], ...(targetExists ? [['/home/projects/encoded/cli-id.jsonl', 'existing']] : [])]);
  const calls = [];
  const promises = {
    async rename(from, to) { calls.push('rename'); if (renameError) throw Object.assign(new Error(renameError), {code:renameError}); files.set(to, files.get(from)); files.delete(from); },
    async rm(to) { calls.push('rm'); files.delete(to); },
    async copyFile(from, to) { calls.push('copy'); if (files.has(to)) throw Object.assign(new Error('exists'), {code:'EEXIST'}); files.set(to, files.get(from)); },
    async open() { calls.push('open'); return {async sync(){calls.push('sync');}, async close(){calls.push('close');}}; },
    async unlink(from) { calls.push('unlink'); files.delete(from); },
    async lstat(to) { calls.push('lstat'); if (!files.has(to)) throw Object.assign(new Error('missing'), {code:'ENOENT'}); return {isFile:()=>true}; },
  };
  const api = { e4:'local_', iD:()=>cwdKey, _L:()=>'/home', u7:fn=>fn() };
  const Native = vm.runInNewContext(`(class { ${source.slice(begin, end)} })`, {t:api, X:path.posix, Z:{default:{promises, constants:{COPYFILE_EXCL:1}}}, TC:async()=>{calls.push('mkdir');}});
  const session = {importedFrom:'terminalCli', cwd:'/work', cliSessionId, stagedTranscriptPath:'/stage/transcript.jsonl'};
  const instance = new Native();
  instance.sessions = new Map([['local_1', session]]);
  instance.diskTranscript = {invalidate:()=>calls.push('invalidate')};
  instance.saveSession = async()=>{calls.push('save'); if (saveError) throw new Error('save failed');};
  instance.emitSessionUpdated = ()=>calls.push('emit');
  return {instance, session, files, calls};
}

test('native Code import installs then saves and emits', async()=>{
  const f=fixture(); assert.equal(await f.instance.confirmImportedSessionResume('1'),true);
  assert.equal(f.files.get('/home/projects/encoded/cli-id.jsonl'),'staged');
  assert.deepEqual(f.calls,['mkdir','rename','invalidate','save','emit']);
  assert.equal(f.session.stagedTranscriptPath,undefined); assert.equal(f.session.resumeConfirmed,true);
});

test('native cross-device fallback replaces existing destination before copy', async()=>{
  const f=fixture({renameError:'EXDEV',targetExists:true});
  assert.equal(await f.instance.confirmImportedSessionResume('1'),true);
  assert.equal(f.files.get('/home/projects/encoded/cli-id.jsonl'),'staged');
  assert.deepEqual(f.calls,['mkdir','rename','rm','copy','open','sync','close','unlink','invalidate','save','emit']);
});

test('native other rename failure accepts an existing file without comparing contents', async()=>{
  const f=fixture({renameError:'EACCES',targetExists:true});
  assert.equal(await f.instance.confirmImportedSessionResume('1'),true);
  assert.equal(f.files.get('/home/projects/encoded/cli-id.jsonl'),'existing');
  assert.equal(f.files.get('/stage/transcript.jsonl'),'staged');
  assert.deepEqual(f.calls,['mkdir','rename','lstat','invalidate','save','emit']);
});

test('native confirms even without a usable destination and save failure leaves mutation', async()=>{
  const noId=fixture(); delete noId.session.cliSessionId; assert.equal(await noId.instance.confirmImportedSessionResume('1'),true);
  assert.equal(noId.session.stagedTranscriptPath,'/stage/transcript.jsonl'); assert.deepEqual(noId.calls,['save','emit']);
  const f=fixture({cwdKey:null}); assert.equal(await f.instance.confirmImportedSessionResume('1'),true);
  assert.equal(f.session.stagedTranscriptPath,'/stage/transcript.jsonl');
  const g=fixture({saveError:true}); await assert.rejects(g.instance.confirmImportedSessionResume('1'),/save failed/);
  assert.equal(g.session.resumeConfirmed,true); assert.equal(g.calls.includes('emit'),false);
});
