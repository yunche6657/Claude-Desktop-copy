'use strict';
// Isolated composition only. Host exclusion must cover every writer of account,
// manifest, registration, ownership inventory and the controlled directories,
// across processes. commitRegistration must atomically persist both the record
// and source-ID manifest entry, or throw on an uncertain outcome.
const {createTerminalImportFlow}=require('./history-import-flow.cjs');
const {createImportOwnershipProvider}=require('./history-import-ownership.cjs');
const {createNativeSourceManifestProvider}=require('./history-import-manifest.cjs');
const {installStagedTranscript}=require('./history-import-install.cjs');
function createIsolatedHistoryImportHost(options) {
 const {runExclusive,readInventory,readManifestSnapshot,commitRegistration,projectDir,stagingDir}=options;
 if (![runExclusive,readInventory,readManifestSnapshot,commitRegistration].every(f=>typeof f==='function')) throw new TypeError('Shared exclusion and authoritative host sources required');
 const ownership=createImportOwnershipProvider({readInventory});
 const manifest=createNativeSourceManifestProvider({readSnapshot:readManifestSnapshot});
 const flow=createTerminalImportFlow({...options,getOwnershipSnapshot:ownership,getOwnedCliSessionIds:async()=> (await ownership()).cliSessionIds,getSourceManifestSnapshot:manifest,
  registerStaged:async request=>{
   if(await request.isCurrent()!==true) return 'refused';
   const installed=await installStagedTranscript({stagingRoot:stagingDir,stagingPath:request.staged.stagingPath,projectDir,cliSessionId:request.cliSessionId,isCurrent:request.isCurrent});
   if(installed.status!=='installed' || await request.isCurrent()!==true) return 'refused';
   // The host must revalidate under the same exclusion and atomically persist
   // registration and manifest. Never delete published/staged data on failure.
   const result=await commitRegistration({sourceSessionId:request.sourceSessionId,sessionId:request.sessionId,cliSessionId:request.cliSessionId,identityKey:request.staged.identityKey,cwd:request.staged.safeCwd,createdAt:request.staged.createdAt,lastActivityAt:request.staged.lastActivityAt,stagedTranscriptPath:installed.targetPath,stagedTranscriptSha256:installed.sha256,importedFrom:'terminal-cli',isCurrent:request.isCurrent});
   return result==='registered'?'registered':'refused';
  }});
 return {scan:()=>runExclusive(()=>flow.scan()),importSource:token=>runExclusive(()=>flow.importSource(token)),recover:(id,inspect)=>runExclusive(()=>flow.recover(id,inspect)),recoverAbandonedLock:proof=>flow.recoverAbandonedLock(proof)};
}
module.exports={createIsolatedHistoryImportHost};
