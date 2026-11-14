import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createSessionKernel } = createRequire(import.meta.url)('../desktop/session-kernel.cjs');

test('import confirmation persists before allowing warm and excludes staged records', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-confirm-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const storePath = path.join(dir, 'sessions.json');
  const id = 'local_123';
  fs.writeFileSync(storePath, JSON.stringify({sessions:[
    {sessionId:id, cwd:dir, workingDir:dir, originCwd:dir, importedFrom:'terminalCli', error:'x', errorCategory:'x'},
    {sessionId:'local_staged', cwd:dir, workingDir:dir, originCwd:dir, importedFrom:'terminalCli', stagedTranscriptPath:'staged.jsonl', cliSessionId:'fixture-cli'},
    {sessionId:'local_no_cli', cwd:dir, importedFrom:'terminalCli', stagedTranscriptPath:'untouched.jsonl'},
    {sessionId:'local_fail', cwd:dir, workingDir:dir, originCwd:dir, importedFrom:'terminalCli'},
    {sessionId:'local_normal', cwd:dir, workingDir:dir, originCwd:dir}
  ],transcripts:{}}));
  const events=[]; let warmed=0;
  const backend={id:'fixture', start(){}, sendMessage(){}, cancel(){}, onEvent(){return ()=>{}}, dispose(){}, warm:async()=>{warmed++}};
  const kernel=createSessionKernel({backend,storePath,emit:e=>events.push(e)});
  t.after(()=>kernel.dispose());
  assert.equal(await kernel.warmSession(id), undefined);
  assert.equal(kernel.confirmImportedSessionResume('staged'), false);
  assert.equal(kernel.confirmImportedSessionResume('no_cli'), true);
  assert.equal(kernel.getSession('local_no_cli').stagedTranscriptPath, 'untouched.jsonl');
  assert.equal(kernel.getSession('local_no_cli').resumeConfirmed, true);
  assert.equal(kernel.confirmImportedSessionResume('normal'), false);
  assert.equal(kernel.confirmImportedSessionResume('missing'), false);
  assert.equal(kernel.confirmImportedSessionResume('123'), true);
  assert.equal(kernel.confirmImportedSessionResume(id), false);
  const stored=JSON.parse(fs.readFileSync(storePath,'utf8')).sessions.find(s=>s.sessionId===id);
  assert.equal(stored.resumeConfirmed,true);
  const noCliStored=JSON.parse(fs.readFileSync(storePath,'utf8')).sessions.find(s=>s.sessionId==='local_no_cli');
  assert.equal(noCliStored.resumeConfirmed,true);
  assert.equal(noCliStored.stagedTranscriptPath,'untouched.jsonl');
  assert.equal(fs.existsSync(path.join(dir,'untouched.jsonl')),false);
  assert.equal(stored.error,undefined);
  assert.equal(stored.errorCategory,undefined);
  assert.equal(events.filter(e=>e.type==='session_updated').length,2);
  assert.equal((await kernel.warmSession(id)).warmed,true);
  assert.equal(warmed,1);
  const reopened=createSessionKernel({backend,storePath,emit:()=>{}});
  t.after(()=>reopened.dispose());
  assert.equal(reopened.getSession(id).resumeConfirmed,true);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('fixture write failure'); };
    assert.equal(kernel.confirmImportedSessionResume('fail'), false);
  } finally { fs.renameSync = rename; }
  assert.equal(kernel.getSession('local_fail').resumeConfirmed, undefined);
  assert.equal(events.some(e=>e.type==='persist_failed'),true);
  assert.equal(kernel.confirmImportedSessionResume('fail'),true);
});

