import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createGitDiff} = require('../desktop/git-diff.cjs');
function fixture(t,commit=true) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-git-diff-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  git('init','--initial-branch=main'); git('config','user.name','Diff Tester');git('config','user.email','diff@example.invalid');git('config','core.autocrlf','false');
  const write=(file,data)=>{fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),data)};
  if(commit){write('text.txt','first\nsecond\n');write('blob.bin',Buffer.from([0,1,2]));git('add','.');git('commit','-m','initial');}
  return {dir,git,write,service:createGitDiff({isTrusted:()=>true})};
}
function assertDiff(value) {
  assert.ok(value);
  for(const key of ['base_ref','head_ref','merge_base'])assert.equal(typeof value[key],'string');
  for(const key of ['ahead_by','behind_by','total_commits'])assert.equal(typeof value[key],'number');
  for(const file of value.files){assert.equal(typeof file.filename,'string');assert.equal(typeof file.status,'string');for(const k of ['additions','deletions','changes'])assert.equal(typeof file[k],'number');}
}

test('native diff uses merge-base, divergence counts, commits metadata and explicit head snapshot',async t=>{
  const {dir,git,write,service}=fixture(t), initial=git('rev-parse','HEAD');
  git('checkout','-b','feature');write('feature.txt','feature\n');git('add','.');git('commit','-m','feature commit');const sha=git('rev-parse','HEAD');
  git('checkout','main');write('base.txt','base\n');git('add','.');git('commit','-m','base advanced');git('checkout','feature');
  write('untracked.txt','working only\n');
  const result=await service.getGitDiff(dir,'main','feature');assertDiff(result);
  assert.equal(result.merge_base,initial);assert.equal(result.ahead_by,1);assert.equal(result.behind_by,1);assert.equal(result.total_commits,1);
  assert.deepEqual(result.files.map(x=>x.filename),['feature.txt']);assert.ok(result.files[0].patch.includes('+feature'));
  const stats=await service.getGitDiffStats(dir,'main','feature');assert.deepEqual(stats,{additions:1,deletions:0,fileCount:1,ahead_by:1,behind_by:1});
  const commits=await service.getGitCommits(dir,'main','feature');assert.equal(commits.length,1);assert.equal(commits[0].sha,sha);assert.equal(commits[0].subject,'feature commit');assert.equal(commits[0].authorName,'Diff Tester');assert.equal(commits[0].authorEmail,'diff@example.invalid');assert.equal(typeof commits[0].date,'number');
  const commit=await service.getCommitDiff(dir,sha);assertDiff(commit);assert.equal(commit.merge_base,initial);assert.deepEqual(commit.files.map(x=>x.filename),['feature.txt']);
});

test('working diff preserves rename/binary/untracked rows and returns actual old/new text',async t=>{
  const {dir,git,write,service}=fixture(t),initial=git('rev-parse','HEAD');
  git('mv','text.txt','重命名 file.txt');write('重命名 file.txt','first\nsecond\nthird\n');write('blob.bin',Buffer.from([0,9,8]));write('新文件.txt','new\nfile\n');
  const diff=await service.getGitDiff(dir,'main');assertDiff(diff);
  const renamed=diff.files.find(x=>x.filename==='重命名 file.txt');assert.equal(renamed.status,'renamed');assert.equal(renamed.previous_filename,'text.txt');assert.equal(renamed.additions,1);
  const binary=diff.files.find(x=>x.filename==='blob.bin');assert.equal(binary.additions,0);assert.equal(binary.deletions,0);
  const untracked=diff.files.find(x=>x.filename==='新文件.txt');assert.equal(untracked.status,'added');assert.equal(untracked.additions,2);assert.ok(untracked.patch.includes('+new'));
  assert.deepEqual(await service.getDiffFileContent(dir,initial,'重命名 file.txt','text.txt'),{oldText:'first\nsecond\n',newText:'first\nsecond\nthird\n'});
  assert.deepEqual(await service.getDiffFileContent(dir,initial,'新文件.txt'),{oldText:null,newText:'new\nfile\n'});
  const stats=await service.getGitDiffStats(dir,'main');assert.equal(stats.fileCount,3);assert.equal(stats.additions,3);assert.equal(stats.deletions,0);assert.equal(stats.head_sha,initial);
});

test('lazy patch options honor changed-line budget and per-file patch reload',async t=>{
  const {dir,git,write,service}=fixture(t),initial=git('rev-parse','HEAD');write('text.txt','changed\nsecond\n');
  const lazy=await service.getGitDiff(dir,'main',undefined,{includePatches:false});assert.equal(lazy.patches_withheld,true);assert.equal(lazy.files[0].patch,undefined);
  const none=await service.getGitDiff(dir,'main',undefined,{includePatches:false,inlinePatchesMaxChangedLines:0});assert.equal(none.patches_withheld,true);
  const inline=await service.getGitDiff(dir,'main',undefined,{includePatches:false,inlinePatchesMaxChangedLines:5});assert.equal(inline.patches_withheld,false);assert.ok(inline.files[0].patch.includes('+changed'));
  const patch=await service.getGitDiffFilePatch(dir,initial,'text.txt');assert.ok(patch.includes('-first'));assert.ok(patch.includes('+changed'));
});

test('unborn HEAD, missing base and invalid explicit refs preserve native negative/fallback behavior',async t=>{
  const {dir,git,write,service}=fixture(t,false);write('first.txt','first\n');
  const unborn=await service.getGitDiff(dir,'main');assertDiff(unborn);assert.equal(unborn.files[0].filename,'first.txt');assert.equal(unborn.files[0].additions,1);
  git('add','.');git('commit','-m','initial');write('first.txt','changed\n');
  const missing=await service.getGitDiff(dir,'not-a-branch');assertDiff(missing);assert.equal(missing.base_ref,'HEAD');assert.equal(missing.files[0].filename,'first.txt');
  assert.equal(await service.getGitDiff(dir,'not-a-branch','main'),null);
  assert.equal(await service.getGitDiff(dir,'main','--all'),null);
  assert.equal(await service.getCommitDiff(dir,'HEAD'),null);
});

test('root commit diff uses empty tree and includes all initial files',async t=>{
  const {dir,git,service}=fixture(t),sha=git('rev-parse','HEAD');const diff=await service.getCommitDiff(dir,sha);assertDiff(diff);assert.equal(diff.total_commits,1);assert.equal(diff.files.length,2);assert.ok(diff.files.every(x=>x.status==='added'));
});

test('policy/trust denial and path traversal never expose working files',async t=>{
  const {dir,git,service}=fixture(t),sha=git('rev-parse','HEAD');let calls=0;
  const denied=createGitDiff({isTrusted:()=>false,run(){calls++;throw Error('unexpected git')}});
  assert.equal(await denied.getGitDiff(dir,'main'),null);assert.equal(await denied.getDiffFileContent(dir,sha,'text.txt'),null);
  assert.equal(await denied.getGitDiffStats(dir,'main'),null);assert.equal(await denied.getGitCommits(dir,'main'),null);
  assert.equal(await denied.getCommitDiff(dir,sha),null);assert.equal(await denied.getGitDiffFilePatch(dir,sha,'text.txt'),null);assert.equal(calls,0);
  assert.equal(await service.getDiffFileContent(dir,sha,'../outside.txt'),null);assert.equal(await service.getDiffFileContent(dir,sha,path.join(dir,'text.txt')),null);
});

test('per-file reads retain original four-request concurrency cap under parallel UI expansion',async t=>{
  const {dir,git}=fixture(t),sha=git('rev-parse','HEAD');let active=0,peak=0;
  const run=(args,cwd)=>new Promise((resolve,reject)=>{
    const show=args[0]==='show';if(show){active++;peak=Math.max(peak,active);}
    execFile('git',args,{cwd,windowsHide:true,encoding:'utf8'},(error,out)=>setTimeout(()=>{if(show)active--;error?reject(error):resolve(out);},show?30:0));
  });
  const service=createGitDiff({isTrusted:()=>true,run});
  const results=await Promise.all(Array.from({length:13},()=>service.getDiffFileContent(dir,sha,'text.txt')));
  assert.equal(peak,4);assert.ok(results.every(x=>x.oldText==='first\nsecond\n'));
});

test('repository root is also checked against workspace policy when cwd is a nested directory',async t=>{
  const {dir,write}=fixture(t);write('nested/keep.txt','nested\n');const nested=path.join(dir,'nested');
  const service=createGitDiff({isTrusted:()=>true,isCwdAllowed:cwd=>path.resolve(cwd)===path.resolve(nested)});
  assert.equal(await service.getGitDiff(nested,'main'),null);
  assert.equal(await service.getGitDiffStats(nested,'main'),null);
});

test('working content refuses a directory junction escaping git root and enforces per-file byte cap',async t=>{
  const {dir,git,write,service}=fixture(t),sha=git('rev-parse','HEAD');
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-diff-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'private.txt'),'outside marker');
  const link=path.join(dir,'escape');
  try {fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');} catch(error) {if(['EPERM','EACCES'].includes(error.code))return t.skip('Host cannot create directory links');throw error;}
  assert.equal(await service.getDiffFileContent(dir,sha,'escape/private.txt'),null);
  write('large.txt','x'.repeat(2*1024*1024+1));
  assert.equal(await service.getDiffFileContent(dir,sha,'large.txt'),null);
});

test('untracked list preserves original two-tier 200 body plus 200 placeholder render cap',async t=>{
  const {dir,write,service}=fixture(t);for(let i=0;i<405;i++)write(`new/${String(i).padStart(4,'0')}.txt`,'new\n');
  const diff=await service.getGitDiff(dir,'main');assertDiff(diff);assert.equal(diff.files.length,400);
  assert.equal(diff.files.filter(x=>x.additions===1).length,200);assert.equal(diff.files.filter(x=>x.additions===0).length,200);
  const stats=await service.getGitDiffStats(dir,'main');assert.equal(stats.fileCount,400);assert.equal(stats.additions,200);
});

test('lazy diff folds tracked rows past original 1000-row render cap; stats retain full totals',async t=>{
  const {dir,git,write,service}=fixture(t);for(let i=0;i<1002;i++)write(`many/${String(i).padStart(4,'0')}.txt`,'one\n');git('add','.');
  const diff=await service.getGitDiff(dir,'main',undefined,{includePatches:false});assertDiff(diff);assert.equal(diff.files.length,1001);assert.ok(diff.files.at(-1).filename.includes('2 more files'));assert.equal(diff.files.at(-1).additions,2);
  const stats=await service.getGitDiffStats(dir,'main');assert.equal(stats.fileCount,1002);assert.equal(stats.additions,1002);
});
