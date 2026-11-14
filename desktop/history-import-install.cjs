'use strict';
// Conservative staged-transcript publication. The caller must own both roots,
// prevent concurrent directory/path replacement, and authorize the target slug
// and CLI UUID. No source transcript or existing destination is ever removed.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES=64*1024*1024;
function within(root,file) {const rel=path.relative(root,file); return rel!=='' && rel!=='..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);}
function same(a,b) {return a && b && a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeMs===b.mtimeMs && a.nlink===b.nlink;}
function sameFile(a,b) {return a&&b&&a.dev===b.dev&&a.ino===b.ino;}
async function statOrNull(file) {try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function publishWithReceipt({receiptPath,projectDir,target,data,isCurrent}) {
 const temp=path.join(projectDir,`.import-install-${path.basename(receiptPath).slice('.import-proof-'.length)}.tmp`);
 let proof=await statOrNull(receiptPath), temporary=await statOrNull(temp), destination=await statOrNull(target);
 if(destination&&!proof) return {status:'conflict'};
 if(!proof&&!temporary) {
  const out=await fs.open(temp,'wx',0o600);
  try {await out.writeFile(data);await out.sync();} finally {await out.close();}
  temporary=await fs.lstat(temp);
 }
 const candidate=proof||temporary;
 if(!candidate||!candidate.isFile()||candidate.isSymbolicLink()||candidate.size!==data.length||candidate.size>MAX_BYTES) return {status:'conflict'};
 if(temporary&&(!temporary.isFile()||temporary.isSymbolicLink()||!sameFile(candidate,temporary))) return {status:'conflict'};
 if(destination&&(!destination.isFile()||destination.isSymbolicLink()||!sameFile(candidate,destination))) return {status:'conflict'};
 const count=1+(proof&&temporary?1:0)+(destination?1:0);
 if(candidate.nlink!==count) return {status:'conflict'};
 const candidatePath=proof?receiptPath:temp;
 const handle=await fs.open(candidatePath,'r');
 try {
  const opened=await handle.stat();
  if(!same(candidate,opened)||!crypto.timingSafeEqual(crypto.createHash('sha256').update(await handle.readFile()).digest(),crypto.createHash('sha256').update(data).digest())||!same(opened,await handle.stat())||!same(opened,await fs.lstat(candidatePath))) return {status:'conflict'};
 } finally {await handle.close();}
 if(await isCurrent()!==true) return {status:'stale'};
 if(!proof) {
  try {await fs.link(temp,receiptPath);} catch(e) {if(['EPERM','ENOTSUP','EOPNOTSUPP','EXDEV'].includes(e.code)) return {status:'unsupported'};throw e;}
  proof=await fs.lstat(receiptPath);
 }
 // A deterministic temp name is recorded indirectly by the host's nonce.
 // All paths remain protected by the host's exclusive lease through unlink.
 if(temporary) {
  const now=await fs.lstat(temp);
  if(!sameFile(now,proof)||!sameFile(now,temporary)||await isCurrent()!==true) return {status:'stale'};
  await fs.unlink(temp);
 }
 proof=await fs.lstat(receiptPath); destination=await statOrNull(target);
 if(!proof.isFile()||proof.isSymbolicLink()||proof.nlink!==(destination?2:1)||destination&&(!destination.isFile()||destination.isSymbolicLink()||!sameFile(proof,destination))) return {status:'conflict'};
 if(await isCurrent()!==true) return {status:'stale'};
 if(!destination) {
  try {await fs.link(receiptPath,target);} catch(e) {if(e.code==='EEXIST')return {status:'conflict'};if(['EPERM','ENOTSUP','EOPNOTSUPP','EXDEV'].includes(e.code))return {status:'unsupported'};throw e;}
 }
 return {status:await isCurrent()===true?'installed':'installed-stale',targetPath:target,sha256:crypto.createHash('sha256').update(data).digest('hex')};
}
async function installStagedTranscript({stagingRoot,stagingPath,projectDir,cliSessionId,isCurrent,receiptPath}) {
 if (![stagingRoot,stagingPath,projectDir].every(v=>typeof v==='string'&&path.isAbsolute(v)) || !UUID.test(cliSessionId || '') || typeof isCurrent!=='function') throw new TypeError('Trusted directories, staged file, CLI UUID and guard required');
 if(await isCurrent()!==true) return {status:'stale'};
 const realRoot=await fs.realpath(stagingRoot), realStage=await fs.realpath(stagingPath);
 if(!within(realRoot,realStage)) throw Error('Staged transcript outside staging root');
 const rootStat=await fs.lstat(stagingRoot), dirStat=await fs.lstat(projectDir), before=await fs.lstat(stagingPath);
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||!dirStat.isDirectory()||dirStat.isSymbolicLink()||!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX_BYTES||await fs.realpath(projectDir)!==path.resolve(projectDir)) throw Error('Unstable staging or project path');
 const input=await fs.open(stagingPath,'r'); let data;
 try {
  const stat=await input.stat(); if(!same(before,stat)) throw Error('Staged transcript changed');
  const buffer=Buffer.alloc(stat.size+1); let length=0;
  while(length<buffer.length) {const {bytesRead}=await input.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}
  data=buffer.subarray(0,length);
  if(length!==stat.size||!same(stat,await input.stat())||!same(stat,await fs.lstat(stagingPath))) throw Error('Staged transcript changed');
 } finally {await input.close();}
 const temp=path.join(projectDir,`.import-install-${crypto.randomUUID()}.tmp`);
 const target=path.join(projectDir,`${cliSessionId}.jsonl`);
 if(receiptPath!==undefined && (typeof receiptPath!=='string'||path.dirname(receiptPath)!==path.resolve(projectDir)||!/^\.import-proof-[0-9a-f-]+$/.test(path.basename(receiptPath)))) throw new TypeError('Invalid publication proof path');
 if(receiptPath) return publishWithReceipt({receiptPath,projectDir,target,data,isCurrent});
 const out=await fs.open(temp,'wx',0o600); let own=await out.stat();
 try {
  await out.writeFile(data); await out.sync(); own=await out.stat();
  if(await isCurrent()!==true) return {status:'stale'};
  try {await fs.link(temp,target);}
  catch(e) {if(e.code==='EEXIST') return {status:'conflict'}; if(['EPERM','ENOTSUP','EOPNOTSUPP','EXDEV'].includes(e.code)) return {status:'unsupported'}; throw e;}
  return {status:await isCurrent()===true?'installed':'installed-stale',targetPath:target,sha256:crypto.createHash('sha256').update(data).digest('hex')};
 } finally {
  await out.close().catch(()=>{});
  // Directory is required to be exclusively controlled by the host. lstat is
  // defense in depth, not an atomic identity-bound unlink on Windows.
  const current=await fs.lstat(temp).catch(()=>null);
  if(current && own && current.dev===own.dev && current.ino===own.ino) await fs.unlink(temp).catch(()=>{});
 }
}
module.exports={installStagedTranscript};
