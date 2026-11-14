import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createHistoryImportResume}=require('../desktop/history-import-resume.cjs');

async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'import-resume-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const stagingRoot=path.join(root,'stage'),projectDir=path.join(root,'project');
 await fs.mkdir(stagingRoot);await fs.mkdir(projectDir);
 const stagingPath=path.join(stagingRoot,'history.jsonl'),data='synthetic transcript\n';
 await fs.writeFile(stagingPath,data);
 const record={sessionId:'local_test',cliSessionId:crypto.randomUUID(),importedFrom:'terminalCli',cwd:root,homeDir:root,stagingRoot,stagingPath,projectDir,sha256:crypto.createHash('sha256').update(data).digest('hex')};
 let valid=true,commits=0,commitResult=true;
 const host={async runExclusive(fn){return fn({read:async()=>record,isCurrent:async()=>valid,commit:async(_record,proof)=>{commits++;assert.equal(await proof.isCurrent(),true);return commitResult;}})}};
 return {root,record,resume:createHistoryImportResume({host}),setValid:v=>valid=v,setCommit:v=>commitResult=v,commits:()=>commits};
}

test('host confirms only after publishing the expected bytes',async t=>{
 const f=await fixture(t),result=await f.resume.confirm('local_test');
 assert.equal(result.status,'confirmed');assert.equal(f.commits(),1);
 assert.equal(await fs.readFile(result.targetPath,'utf8'),'synthetic transcript\n');
 assert.equal(await fs.readFile(f.record.stagingPath,'utf8'),'synthetic transcript\n');
});
test('identity loss, changed staging and destination conflicts stay unconfirmed',async t=>{
 const a=await fixture(t);a.setValid(false);assert.equal((await a.resume.confirm('local_test')).status,'stale');assert.equal(a.commits(),0);
 const b=await fixture(t);await fs.appendFile(b.record.stagingPath,'tamper');assert.equal((await b.resume.confirm('local_test')).status,'digest-mismatch');assert.equal(b.commits(),0);
 const c=await fixture(t);const target=path.join(c.record.projectDir,`${c.record.cliSessionId}.jsonl`);await fs.writeFile(target,'existing');assert.equal((await c.resume.confirm('local_test')).status,'conflict');assert.equal(await fs.readFile(target,'utf8'),'existing');assert.equal(c.commits(),0);
});
test('failed host commit keeps the installed target and refuses success',async t=>{
 const f=await fixture(t);f.setCommit(false);assert.equal((await f.resume.confirm('local_test')).status,'installed-unconfirmed');assert.equal(f.commits(),1);
 assert.equal(await fs.readFile(path.join(f.record.projectDir,`${f.record.cliSessionId}.jsonl`),'utf8'),'synthetic transcript\n');
});
