'use strict';
// A conservative import reservation journal, not the native manifest format.
// The host must provide a private, stable directory and a register callback that
// atomically rechecks identity/ownership at its own durable commit boundary.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {readSourceManifestSnapshot}=require('./history-import-manifest.cjs');
const {snapshotProblem}=require('./snapshot-shape.cjs');
// The identity field list and key order live in one place (R558). This file's `key()` and
// history-import-flow.cjs's guard were byte-identical, and the key is what two imports are compared BY.
const {isIdentity,identityKey}=require('./import-identity.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function key(identity) {
  if (!isIdentity(identity)) throw Error('Import identity unavailable');
  return identityKey(identity);
}
function createImportTransaction({directory,getIdentity,getOwnedCliSessionIds,getOwnershipSnapshot,getSourceManifestSnapshot,register}) {
  if (typeof directory!=='string' || !path.isAbsolute(directory) || ![getIdentity,getOwnedCliSessionIds,register].every(f=>typeof f==='function')) throw new TypeError('Private directory and host callbacks are required');
  if (getOwnershipSnapshot !== undefined && typeof getOwnershipSnapshot !== 'function') throw new TypeError('Invalid ownership snapshot provider');
  if (getSourceManifestSnapshot !== undefined && typeof getSourceManifestSnapshot !== 'function') throw new TypeError('Invalid source manifest provider');
  const journal=path.join(directory,'history-import-reservations.json');
  const lock=path.join(directory,'history-import-reservations.lock');
  async function read() {
    let text; try { text=await fs.readFile(journal,'utf8'); } catch(e) { if(e.code==='ENOENT') return {version:1,entries:{}}; throw e; }
    const state=JSON.parse(text);
    if (!state || state.version!==1 || !state.entries || typeof state.entries!=='object' || Array.isArray(state.entries)) throw Error('Invalid import journal');
    for(const [id,e] of Object.entries(state.entries)) if(!UUID.test(id) || !e || !['pending','committed'].includes(e.state) || !UUID.test(e.sessionId) || !UUID.test(e.cliSessionId) || typeof e.identityKey!=='string') throw Error('Invalid import journal');
    return state;
  }
  async function write(state, beforeRename) {
    const tmp=path.join(directory,`.history-import-${crypto.randomUUID()}.tmp`);
    const file=await fs.open(tmp,'wx',0o600);
    let finished=false;
    try {
      await file.writeFile(JSON.stringify(state)); await file.sync(); await file.close();
      if (beforeRename && await beforeRename()!==true) return false;
      await fs.rename(tmp,journal); finished=true; return true;
    }
    finally { if(!finished) { await file.close().catch(()=>{}); await fs.unlink(tmp).catch(()=>{}); } }
  }
  async function context() {
    const identityKey=key(await getIdentity());
    let owned, version, isCurrent;
    if (getOwnershipSnapshot) {
      const snapshot=await getOwnershipSnapshot();
      // Same four version conditions as history-import-manifest.cjs, now shared from desktop/snapshot-shape.cjs.
      //
      // THE ASSIGNMENT BEFORE THE `isCurrent()` CHECK LOOKS WRONG AND IS NOT
      //   `owned`, `version` and `isCurrent` are locals of `context()`. That function throws before returning when the
      //   snapshot is stale, so the values assigned on the next line are unreachable from outside — there is no state to
      //   be left dirty. R555 checked this instead of "fixing" it. What differs from the manifest path is the ERROR, and
      //   that difference is real: a malformed snapshot is "unavailable", a stale one is "changed".
      if (snapshotProblem(snapshot, 'cliSessionIds')) throw Error('Complete versioned ownership snapshot unavailable');
      owned=snapshot.cliSessionIds; version=snapshot.version; isCurrent=()=>snapshot.isCurrent();
      if (await isCurrent()!==true) throw Error('Ownership snapshot changed');
    } else {
      owned=await getOwnedCliSessionIds();
      if(!(owned instanceof Set)) throw Error('Complete ownership snapshot unavailable');
    }
    if(identityKey!==key(await getIdentity())) throw Error('Import identity changed');
    return {identityKey,version,isCurrent,owned:new Set([...owned].map(x=>String(x).toLowerCase()))};
  }
  async function run({sourceSessionId,sourceToken}) {
    if(!UUID.test(sourceSessionId || '') || typeof sourceToken!=='string' || !sourceToken) throw new TypeError('Source UUID and scan token required');
    const normalized=sourceSessionId.toLowerCase();
    const dir=await fs.lstat(directory);
    if(!dir.isDirectory() || dir.isSymbolicLink() || await fs.realpath(directory)!==path.resolve(directory)) throw Error('Private directory is not stable');
    let handle; try {handle=await fs.open(lock,'wx',0o600);} catch(e) {if(e.code==='EEXIST') return {status:'busy'}; throw e;}
    try {
      const state=await read();
      if(state.entries[normalized]) return {status:state.entries[normalized].state==='pending'?'pending':'already-imported'};
      const ctx=await context(); if(ctx.owned.has(normalized)) return {status:'already-owned'};
      const manifest=await readSourceManifestSnapshot(getSourceManifestSnapshot);
      if (manifest?.ids.has(normalized)) return {status:'already-imported'};
      const entry={state:'pending',sessionId:crypto.randomUUID(),cliSessionId:crypto.randomUUID(),identityKey:ctx.identityKey};
      state.entries[normalized]=entry; await write(state);
      // A persisted pending entry survives all errors because the host's write
      // may have committed even if its response was lost.
      const isCurrent=async()=>{
        if (ctx.isCurrent && await ctx.isCurrent()!==true) return false;
        if (manifest && await manifest.isCurrent()!==true) return false;
        const current=await context();
        const latestManifest=await readSourceManifestSnapshot(getSourceManifestSnapshot);
        return current.identityKey===entry.identityKey && (!getOwnershipSnapshot || current.version===ctx.version) && !current.owned.has(normalized) &&
          (!manifest || latestManifest.version===manifest.version && !latestManifest.ids.has(normalized));
      };
      if(!await isCurrent()) return {status:'pending'};
      const result=await register({sourceSessionId:normalized,sourceToken,sessionId:entry.sessionId,cliSessionId:entry.cliSessionId,isCurrent});
      if(result!=='registered') return {status:'pending'};
      // A callback must check isCurrent atomically at registration. Rechecking
      // here cannot undo an external commit and is not a substitute for that.
      entry.state='committed'; await write(state);
      return {status:'registered',sessionId:entry.sessionId,cliSessionId:entry.cliSessionId};
    } finally { await handle.close(); await fs.unlink(lock); }
  }
  async function getSourceIds() {
    const identityKey=key(await getIdentity());
    const state=await read();
    if (identityKey!==key(await getIdentity())) throw Error('Import identity changed');
    return new Set(Object.keys(state.entries));
  }
  // The host must exclude *all* transaction users for the entire callback and
  // prove the owner has terminated. A timestamp, PID, or this module's own
  // lock cannot establish that. Never delete a lock merely because it is old.
  async function recoverAbandonedLock({withExclusiveAccess,isAbandoned}) {
    if (typeof withExclusiveAccess!=='function' || typeof isAbandoned!=='function') throw new TypeError('Exclusive access and abandonment proof required');
    return withExclusiveAccess(async()=>{
      const dir=await fs.lstat(directory);
      if(!dir.isDirectory() || dir.isSymbolicLink() || await fs.realpath(directory)!==path.resolve(directory)) throw Error('Private directory is not stable');
      let file;
      try { file=await fs.open(lock,'r'); }
      catch(e) { if(e.code==='ENOENT') return {status:'not-found'}; throw e; }
      try {
        const before=await file.stat(), named=await fs.lstat(lock);
        const same=(a,b)=>a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeMs===b.mtimeMs && a.nlink===b.nlink;
        if(!before.isFile() || !named.isFile() || named.isSymbolicLink() || before.nlink!==1 || !same(before,named)) throw Error('Unstable import lock');
        // No user content is exposed to the proof provider; its evidence must
        // come from the host's lifecycle and shared exclusion, not file age.
        if(await isAbandoned()!==true) return {status:'busy'};
        const after=await file.stat(), current=await fs.lstat(lock).catch(e=>{if(e.code==='ENOENT') return null; throw e;});
        if(!current || !same(before,after) || !same(before,current) || current.isSymbolicLink()) return {status:'changed'};
        await file.close(); file=null;
        // Windows has no identity-bound unlink here; the host's exclusion and
        // private directory are required to prevent replacement at this point.
        await fs.unlink(lock);
        return {status:'unlocked'};
      } finally { if(file) await file.close(); }
    });
  }
  // Recovery may only promote a pending record when a complete, current host
  // inventory positively identifies exactly the preallocated registration.
  // Absence or uncertainty never releases the reservation for another import.
  async function recover(sourceSessionId, inspectRegistration) {
    if (!UUID.test(sourceSessionId || '') || typeof inspectRegistration!=='function') throw new TypeError('Source UUID and authoritative inspector required');
    const normalized=sourceSessionId.toLowerCase();
    const dir=await fs.lstat(directory);
    if(!dir.isDirectory() || dir.isSymbolicLink() || await fs.realpath(directory)!==path.resolve(directory)) throw Error('Private directory is not stable');
    let handle;
    try { handle=await fs.open(lock,'wx',0o600); }
    catch(e) { if(e.code==='EEXIST') return {status:'busy'}; throw e; }
    try {
      const state=await read(), entry=state.entries[normalized];
      if (!entry) return {status:'not-found'};
      if (entry.state==='committed') return {status:'already-imported'};
      if (key(await getIdentity())!==entry.identityKey) return {status:'pending'};
      const proof=await inspectRegistration({sourceSessionId:normalized,sessionId:entry.sessionId,cliSessionId:entry.cliSessionId,identityKey:entry.identityKey});
      if (!proof || proof.complete!==true || proof.sourceSessionId!==normalized || proof.sessionId!==entry.sessionId ||
          proof.cliSessionId!==entry.cliSessionId || proof.identityKey!==entry.identityKey || typeof proof.isCurrent!=='function' ||
          await proof.isCurrent()!==true || key(await getIdentity())!==entry.identityKey) return {status:'pending'};
      // A registration receipt alone does not prove the account manifest was
      // committed. When a manifest provider is configured, both durable
      // effects must have positive, current evidence before promotion.
      const manifest=await readSourceManifestSnapshot(getSourceManifestSnapshot);
      if (manifest && !manifest.ids.has(normalized)) return {status:'pending'};
      entry.state='committed';
      // This narrows the asynchronous temp-write window. The host must still
      // bind its proof and identity to an atomic commit or shared exclusion:
      // another change can occur between this check and the filesystem rename.
      const saved=await write(state,async()=>await proof.isCurrent()===true && key(await getIdentity())===entry.identityKey &&
        (!manifest || await manifest.isCurrent()===true) && await proof.isCurrent()===true);
      if (!saved) return {status:'pending'};
      return {status:'recovered',sessionId:entry.sessionId,cliSessionId:entry.cliSessionId};
    } finally { await handle.close(); await fs.unlink(lock); }
  }
  return {run,getSourceIds,recover,recoverAbandonedLock};
}
module.exports={createImportTransaction};
