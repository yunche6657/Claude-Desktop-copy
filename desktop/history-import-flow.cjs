'use strict';
// Restricted coordinator. The host must establish a private journal/staging
// directory, complete all-org ownership, and atomically revalidate at its own
// registerStaged commit. This module is not a production HistoryImport bridge.
const {createTerminalHistoryImport}=require('./history-import-terminal.cjs');
const {createImportTransaction}=require('./history-import-transaction.cjs');
const {readSourceManifestSnapshot}=require('./history-import-manifest.cjs');
// The identity field list and its key order live in one place (R558). Three files carried this same guard and this same
// JSON key, and the key is what two imports are compared BY — an order that differed in one file would make equal
// identities unequal while the guard still passed.
const {isIdentity,identityKey:keyOfIdentity}=require('./import-identity.cjs');
// The import is aliased because this file already declares a local `identityKey()` that AWAITS `getIdentity()`. Two
// different jobs under one name — one fetches the identity, the other computes a key from it — is how a reader ends up
// assuming the import is unused.
function createTerminalImportFlow(options) {
  const {projectsRoot,stagingDir,journalDirectory,getIdentity,getOwnedCliSessionIds,getOwnershipSnapshot,getSourceManifestSnapshot,resolveTrustedCwd,registerStaged}=options;
  if (typeof registerStaged!=='function') throw new TypeError('Atomic staged registration callback required');
  const scanner=createTerminalHistoryImport({projectsRoot,stagingDir,getIdentity,getOwnedCliSessionIds,resolveTrustedCwd});
  const transaction=createImportTransaction({directory:journalDirectory,getIdentity,getOwnedCliSessionIds,getOwnershipSnapshot,getSourceManifestSnapshot,register:async request=>{
    if (!await request.isCurrent()) return 'refused';
    const staged=await scanner.stage(request.sourceToken);
    if (!staged || staged.sourceSessionId.toLowerCase()!==request.sourceSessionId) return 'refused';
    // The stage result embeds the full identity key. A new account or org may
    // have appeared between the transaction reservation and staging.
    if (!await request.isCurrent()) return 'refused';
    return registerStaged({...request,staged});
  }});
  async function identityKey() {
    const identity=await getIdentity();
    if (!isIdentity(identity)) throw Error('Import identity unavailable');
    return keyOfIdentity(identity);
  }
  let offered=new Map();
  let epoch=0;
  async function scan() {
    const current=++epoch;
    offered=new Map();
    const identity=await identityKey();
    const entries=await scanner.scan();
    const blocked=await transaction.getSourceIds();
    const manifest=await readSourceManifestSnapshot(getSourceManifestSnapshot);
    if (manifest) {
      for (const id of manifest.ids) blocked.add(id);
      if (await manifest.isCurrent()!==true) throw Error('Source manifest changed during scan');
    }
    if (await identityKey()!==identity) throw Error('Import identity changed');
    if (epoch!==current) throw Error('Import scan superseded');
    const list=entries.filter(entry=>!blocked.has(entry.sessionId.toLowerCase()));
    offered=new Map(list.map(entry=>[entry.sourceToken,entry.sessionId]));
    return list;
  }
  async function importSource(token) {
    const id=offered.get(token);
    if (!id) return {status:'not-offered'};
    return transaction.run({sourceSessionId:id,sourceToken:token});
  }
  async function recover(sourceSessionId,inspectRegistration) {
    return transaction.recover(sourceSessionId,inspectRegistration);
  }
  async function recoverAbandonedLock(proof) {
    return transaction.recoverAbandonedLock(proof);
  }
  return {scan,importSource,recover,recoverAbandonedLock};
}
module.exports={createTerminalImportFlow};
