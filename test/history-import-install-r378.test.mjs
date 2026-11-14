import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {installStagedTranscript}=createRequire(import.meta.url)('../desktop/history-import-install.cjs');
const id='c63d48ea-53e7-48a7-95bb-b8f3ef2e7ec5';
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-install-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const stagingRoot=path.join(root,'stage'),projectDir=path.join(root,'project');await fs.mkdir(stagingRoot);await fs.mkdir(projectDir);
 const stagingPath=path.join(stagingRoot,'staged.jsonl');await fs.writeFile(stagingPath,'staged transcript');
 return {stagingRoot,projectDir,stagingPath,cliSessionId:id,isCurrent:()=>true,target:path.join(projectDir,`${id}.jsonl`)};
}
test('installs from a staged file without consuming or aliasing the source',async t=>{
 const f=await fixture(t);const result=await installStagedTranscript(f);assert.equal(result.status,'installed');
 assert.equal(await fs.readFile(f.target,'utf8'),'staged transcript');await fs.writeFile(f.stagingPath,'changed');
 assert.equal(await fs.readFile(f.target,'utf8'),'staged transcript');assert.deepEqual(await fs.readdir(f.projectDir),[`${id}.jsonl`]);
});
test('existing target is never overwritten or removed',async t=>{
 const f=await fixture(t);await fs.writeFile(f.target,'existing transcript');assert.equal((await installStagedTranscript(f)).status,'conflict');
 assert.equal(await fs.readFile(f.target,'utf8'),'existing transcript');assert.equal(await fs.readFile(f.stagingPath,'utf8'),'staged transcript');
});
test('stale identity before publication and concurrent calls cannot overwrite',async t=>{
 const f=await fixture(t);let checks=0;assert.equal((await installStagedTranscript({...f,isCurrent:()=>++checks<2})).status,'stale');
 assert.deepEqual(await fs.readdir(f.projectDir),[]);
 const results=await Promise.all([installStagedTranscript(f),installStagedTranscript(f)]);
 assert.deepEqual(results.map(r=>r.status).sort(),['conflict','installed']);assert.equal(await fs.readFile(f.target,'utf8'),'staged transcript');
});
test('outside root is refused and post-publication identity change preserves destination',async t=>{
 const f=await fixture(t);await assert.rejects(installStagedTranscript({...f,stagingRoot:f.projectDir}),/outside staging root/);
 let checks=0;assert.equal((await installStagedTranscript({...f,isCurrent:()=>++checks<3})).status,'installed-stale');
 assert.equal(await fs.readFile(f.target,'utf8'),'staged transcript');
});

test('isolated flow stages a transcript and installer preserves a conflicting session',async t=>{
 const {createTerminalImportFlow}=createRequire(import.meta.url)('../desktop/history-import-flow.cjs');
 const f=await fixture(t);const projectsRoot=path.join(path.dirname(f.stagingRoot),'source-projects');const folder=path.join(projectsRoot,'source');const journalDirectory=path.join(path.dirname(f.stagingRoot),'journal');await fs.mkdir(folder,{recursive:true});await fs.mkdir(journalDirectory);
 const source=path.join(folder,`${id}.jsonl`);await fs.writeFile(source,JSON.stringify({type:'user',cwd:'/work',sessionId:'old-id',message:{content:'hello'}}));
 let staged, cliSessionId;const flow=createTerminalImportFlow({projectsRoot,stagingDir:f.stagingRoot,journalDirectory,getIdentity:()=>({accountId:'a',orgId:'o',generation:'1'}),getOwnedCliSessionIds:()=>new Set(),resolveTrustedCwd:()=>'/work',registerStaged:async r=>{staged=r.staged;cliSessionId=r.cliSessionId;return 'registered';}});
 const [entry]=await flow.scan();assert.equal((await flow.importSource(entry.sourceToken)).status,'registered');
 const target=path.join(f.projectDir,`${cliSessionId}.jsonl`);await fs.writeFile(target,'other session');
 assert.equal((await installStagedTranscript({stagingRoot:f.stagingRoot,stagingPath:staged.stagingPath,projectDir:f.projectDir,cliSessionId,isCurrent:()=>true})).status,'conflict');
 assert.equal(await fs.readFile(target,'utf8'),'other session');assert.equal((await fs.readFile(source,'utf8')).includes('old-id'),true);
});
