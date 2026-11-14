'use strict';
// Synthetic, cooperative host. Its single-file state projects the replica's
// version-2 sessions and the native account manifest; it is not either file.
// Every participant must use this host and its lock. No production paths.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {createHistoryImportDurableStore}=require('./history-import-durable.cjs');
// The identity rule lives in one place (R558). The other two callers in this family carried the identical guard and the
// identical JSON key; this one also has a `root` precondition, which stays here because it is not part of the rule.
const {isIdentity,identityKey:keyOfIdentity}=require('./import-identity.cjs');
// Aliased because this file declares a local `identityKey` arrow below. The local one takes no argument and closes over
// this function's `identity`; the imported one takes an identity and returns its comparison key.
const {createIsolatedHistoryImportHost}=require('./history-import-host.cjs');
const {createHistoryImportKernelResumeHost}=require('./history-import-kernel-host.cjs');

function createFixtureHistoryImportHost({root,identity,afterCommit}) {
 if(!path.isAbsolute(root)||!isIdentity(identity)) throw TypeError('Fixture root and identity required');
 const store=createHistoryImportDurableStore({directory:path.join(root,'state')});
 let lease,state,version;
 const identityKey=()=>keyOfIdentity(identity);
 async function locked(fn){
  if((await fs.readFile(path.join(root,'.history-import-fixture'),'utf8'))!=='synthetic-history-import-v1') throw Error('Fixture marker required');
  return store.runExclusive(async l=>{lease=l;state=await l.read();version=state.version;try{return await fn();}finally{lease=null;state=null;}});
 }
 const records=()=>Object.values(state.registrations);
 const current=()=>!!lease&&state.version===version;
 const api=createIsolatedHistoryImportHost({
  projectsRoot:path.join(root,'projects'),stagingDir:path.join(root,'stage'),journalDirectory:path.join(root,'journal'),projectDir:path.join(root,'target'),
  getIdentity:()=>({...identity}),resolveTrustedCwd:()=>'/fixture',runExclusive:locked,
  readInventory:()=>({complete:true,coverage:{allAccountsAndOrgs:true,loadedSessions:true,deletingSessions:true,tombstones:true},records:records().map(r=>({stem:r.sessionId,currentTenant:r.identityKey===identityKey(),record:r})),tombstones:[],liveClaims:[],version,isCurrent:current}),
  readManifestSnapshot:()=>({complete:true,state:'ok',content:JSON.stringify({localSessions:records().filter(r=>JSON.parse(r.identityKey)[0]===identity.accountId).map(r=>r.sourceSessionId)}),version,isCurrent:current}),
  commitRegistration:async r=>{const result=await lease.commit({...r,isCurrent:undefined},r.isCurrent);if(result==='registered'&&afterCommit) await afterCommit(r);return result;}
 });
 function createResumeHost({homeDir}) {
  const rel=path.relative(root,homeDir);
  if(!path.isAbsolute(homeDir)||!rel||rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel)) throw TypeError('Fixture home required');
  return createHistoryImportKernelResumeHost({runExclusive:fn=>locked(async()=>{
   const owner=identityKey();
   return fn({isCurrent:()=>current()&&identityKey()===owner,preparePublication:async record=>{
    if(!current()||identityKey()!==owner) return null;
    const binding=JSON.stringify([owner,record.sessionId,record.cliSessionId,record.cwd,record.homeDir,record.stagingRoot,record.stagingPath,record.projectDir,record.sha256]);
    const name=crypto.createHash('sha256').update(record.sessionId).digest('hex');
    const file=path.join(root,'state',`publication-${name}.json`);
    let saved;
    try {
     const handle=await fs.open(file,'wx',0o600);
     try {saved={binding,nonce:crypto.randomUUID()};await handle.writeFile(JSON.stringify(saved));await handle.sync();} finally {await handle.close();}
    } catch(e) {if(e.code!=='EEXIST') throw e;}
    const st=await fs.lstat(file);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>8192) return null;
    try {saved=JSON.parse(await fs.readFile(file,'utf8'));} catch {return null;}
    if(saved.binding!==binding||typeof saved.nonce!=='string'||!/^[0-9a-f-]{36}$/.test(saved.nonce)||!current()||identityKey()!==owner) return null;
    return {receiptPath:path.join(record.projectDir,`.import-proof-${saved.nonce}`)};
   },readRegistration:async id=>{
    const matches=records().filter(r=>`local_${r.sessionId}`===id);
    if(matches.length!==1) return null;
    const r=matches[0];
    if(r.identityKey!==owner||r.importedFrom!=='terminal-cli'||!state.sourceIds.includes(r.sourceSessionId)||
      typeof r.cliSessionId!=='string'||r.stagedTranscriptPath!==path.join(root,'target',`${r.cliSessionId}.jsonl`)||
      records().some(other=>other!==r&&(other.cliSessionId===r.cliSessionId||other.priorCliSessionIds?.includes(r.cliSessionId)))) return null;
    return {sessionId:id,cliSessionId:r.cliSessionId,cwd:r.cwd,importedFrom:'terminalCli',resumeConfirmed:false,
     stagingRoot:path.join(root,'target'),stagingPath:r.stagedTranscriptPath,sha256:r.stagedTranscriptSha256,
     homeDir,projectDir:path.join(homeDir,'projects',r.cwd.replace(/[^a-zA-Z0-9]/g,'-'))};
   }});
  })});
 }
 return {...api,store,createResumeHost,inspect:()=>locked(async()=>({fixtureRoot:path.resolve(root),identityKey:identityKey(),version:state.version,registrations:records(),sessions:{version:2,sessions:records().filter(r=>r.identityKey===identityKey()).map(r=>({...r,id:r.sessionId})),transcripts:{}},manifest:{localSessions:records().filter(r=>JSON.parse(r.identityKey)[0]===identity.accountId).map(r=>r.sourceSessionId)}}))};
}
module.exports={createFixtureHistoryImportHost};
