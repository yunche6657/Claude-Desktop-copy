'use strict';

// The lease must exclude all identity, ownership, registration, session-store
// and transcript writers. isCurrent must remain authoritative until release.
const {createHistoryImportResume}=require('./history-import-resume.cjs');

function synchronousTrue(value) {
 if(value===true) return true;
 if(value!==null&&(typeof value==='object'||typeof value==='function')) Promise.resolve(value).catch(()=>{});
 return false;
}

function createHistoryImportKernelResumeHost({runExclusive}) {
 if(typeof runExclusive!=='function') throw new TypeError('Exclusive host required');
 return {confirm:({sessionId,session,isCurrent,commit})=>{
  if(typeof isCurrent!=='function'||typeof commit!=='function') throw new TypeError('Kernel confirmation required');
  return createHistoryImportResume({host:{runExclusive:fn=>runExclusive(async lease=>{
   if(!lease||typeof lease.readRegistration!=='function'||typeof lease.isCurrent!=='function') throw new TypeError('Synchronous authoritative lease required');
   let active=true;
   const current=()=>{
    try{return active&&synchronousTrue(lease.isCurrent())&&synchronousTrue(isCurrent());}catch{return false;}
   };
   try{return await fn({
    read:async id=>{
     if(!current()) return null;
     const r=await lease.readRegistration(id);
     if(!current()||!r||id!==sessionId||r.sessionId!==id||r.cliSessionId!==session.cliSessionId||
        r.cwd!==session.cwd||r.stagingPath!==session.stagedTranscriptPath||r.importedFrom!=='terminalCli'||
        session.importedFrom!=='terminalCli'||session.resumeConfirmed) return null;
     return {...r};
    },
    isCurrent:current,
    ...(typeof lease.preparePublication==='function'?{preparePublication:async r=>current()?lease.preparePublication(r):null}:{}),
    commit:async(r,proof)=>{
     if(!current()||await proof.isCurrent()!==true||!current()) return false;
     return commit({cliSessionId:r.cliSessionId,cwd:r.cwd,homeDir:r.homeDir,stagingPath:r.stagingPath,targetPath:proof.targetPath},
      {isCurrent:current})===true;
    }
   });}finally{active=false;}
  })}}).confirm(sessionId);
 }};
}
module.exports={createHistoryImportKernelResumeHost};
