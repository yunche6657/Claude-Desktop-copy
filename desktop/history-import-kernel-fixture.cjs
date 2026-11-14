'use strict';
// Offline synthetic export. The fixture host must be quiescent; this does not
// coordinate with a running session kernel or a production account.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {readCliTranscript}=require('./cli-transcript.cjs');
async function exportFixtureToKernel({root,host,storePath}) {
 if(!path.isAbsolute(root)||!path.isAbsolute(storePath)||!host||typeof host.inspect!=='function') throw new TypeError('Fixture root, host and store path required');
 const inside=(base,file)=>{const rel=path.relative(base,file);return !!rel&&rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);};
 if(!inside(root,storePath)) throw Error('Store must be inside fixture');
 if(await fs.readFile(path.join(root,'.history-import-fixture'),'utf8')!=='synthetic-history-import-v1') throw Error('Fixture marker required');
 const realRoot=await fs.realpath(root),parent=await fs.realpath(path.dirname(storePath));
 if(parent!==realRoot&&!inside(realRoot,parent)) throw Error('Store parent outside fixture');
 const snapshot=await host.inspect();
 if(snapshot?.fixtureRoot!==path.resolve(root)||typeof snapshot.identityKey!=='string'||!Array.isArray(snapshot?.sessions?.sessions)) throw Error('Fixture host unavailable or identity missing');
 const sessions=[],transcripts={};
 for(const r of snapshot.sessions.sessions) {
  if(typeof r.sessionId!=='string'||!r.sessionId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.cliSessionId||'')||typeof r.cwd!=='string'||typeof r.stagedTranscriptPath!=='string'||r.identityKey!==snapshot.identityKey||!/^[0-9a-f]{64}$/.test(r.stagedTranscriptSha256||'')) throw Error('Invalid fixture registration or missing transcript digest');
  if(path.resolve(r.stagedTranscriptPath)!==path.join(path.resolve(root),'target',`${r.cliSessionId}.jsonl`)) throw Error('Unexpected fixture transcript location');
  const target=await fs.realpath(r.stagedTranscriptPath);
  if(!inside(realRoot,target)) throw Error('Transcript outside fixture');
  const id=`local_${r.sessionId}`;
  if(Object.hasOwn(transcripts,id)) throw Error('Duplicate session');
  // readCliTranscript repairs parent links through rows omitted during staging.
  const before=await fs.lstat(target);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>64*1024*1024||target!==path.resolve(r.stagedTranscriptPath)) throw Error('Untrusted fixture transcript');
  const file=await fs.open(target,'r'); let rows;
  try {
   const opened=await file.stat();
   const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.nlink===b.nlink;
   if(!same(before,opened)) throw Error('Fixture transcript changed');
   const data=Buffer.alloc(opened.size+1); let offset=0;
   while(offset<data.length){const {bytesRead}=await file.read(data,offset,data.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
   if(offset!==opened.size||crypto.createHash('sha256').update(data.subarray(0,offset)).digest('hex')!==r.stagedTranscriptSha256) throw Error('Fixture transcript digest mismatch');
   rows=readCliTranscript(file.fd);
   if(!same(opened,await file.stat())||!same(opened,await fs.lstat(target))||await fs.realpath(r.stagedTranscriptPath)!==target) throw Error('Fixture transcript changed');
  } finally {await file.close();}
  if(!rows.length) throw Error('Fixture transcript has no readable messages');
  sessions.push({sessionId:id,cliSessionId:r.cliSessionId,cwd:r.cwd,workingDir:r.cwd,originCwd:r.cwd,
   createdAt:r.createdAt,lastActivityAt:r.lastActivityAt,importedFrom:'terminalCli',
   stagedTranscriptPath:target,isRunning:false,pendingToolPermissions:[]});
  transcripts[id]=rows;
 }
 const file=await fs.open(storePath,'wx',0o600);
 try {await file.writeFile(JSON.stringify({version:2,sessions,transcripts}));await file.sync();} finally {await file.close();}
 return {count:sessions.length,storePath};
}
module.exports={exportFixtureToKernel};
