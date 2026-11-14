'use strict';
// The host owns account binding, shared exclusion and atomic publication. This
// adapter deliberately has no default account path or production lock.
const path = require('node:path');
const MAX_BYTES = 67108864;
const empty = () => ({runs:[],projects:{},localSessions:[],autoCopiedSourceIds:[],exports:[],errors:[]});
function normalizeManifest(e) {
  const projects = {};
  if (e.projects && typeof e.projects === 'object' && !Array.isArray(e.projects)) {
    for (const [key, value] of Object.entries(e.projects)) {
      const spaceId = value && typeof value.spaceId === 'string' && value.spaceId ? value.spaceId : undefined;
      const invalid = !value || typeof value !== 'object' || typeof value.name !== 'string' || (value.spaceId !== undefined && typeof value.spaceId !== 'string');
      if (!invalid && typeof value.folderPath === 'string') projects[key] = spaceId ? {spaceId,folderPath:value.folderPath,name:value.name} : {folderPath:value.folderPath,name:value.name};
      else if (!invalid && value.folderPath === undefined && spaceId) projects[key] = {spaceId,name:value.name};
    }
  }
  const strings = x => Array.isArray(x) && x.every(v => typeof v === 'string');
  const runs = [];
  if (Array.isArray(e.runs)) for (const run of e.runs) {
    if (!run || typeof run !== 'object' || typeof run.startedAt !== 'number' || typeof run.completedAt !== 'number' || !strings(run.registeredSessionIds) || !strings(run.createdSpaceIds) || !run.counts || typeof run.counts !== 'object' || (run.sourceSessionIds !== undefined && !strings(run.sourceSessionIds)) || (run.referencedSpaceIds !== undefined && !strings(run.referencedSpaceIds)) || (run.relinkedSessionIds !== undefined && !strings(run.relinkedSessionIds)) || (run.localSources !== undefined && !Array.isArray(run.localSources))) continue;
    runs.push({...run, skippedSessionIds:strings(run.skippedSessionIds) ? run.skippedSessionIds : [], folderPaths:strings(run.folderPaths) ? run.folderPaths : [], counts:{conversations:Number(run.counts.conversations)||0, projects:Number(run.counts.projects)||0, files:Number(run.counts.files)||0, skipped:Number(run.counts.skipped)||0}});
  }
  return {runs,projects,localSessions:Array.isArray(e.localSessions)?e.localSessions:[],autoCopiedSourceIds:Array.isArray(e.autoCopiedSourceIds)?e.autoCopiedSourceIds.filter(x=>typeof x==='string'):[],exports:Array.isArray(e.exports)?e.exports:[],errors:Array.isArray(e.errors)?e.errors:[]};
}
async function readAccountManifest(readFile, file) {
  let content;
  try { content = await readFile(file, MAX_BYTES); }
  catch (e) { return e && e.code === 'ENOENT' ? {state:'absent',manifest:empty()} : {state:'unreadable',errorCode:e?.code}; }
  try {
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw Error('invalid input');
    if (Buffer.byteLength(content)>MAX_BYTES) return {state:'unreadable',errorCode:'EFBIG'};
    return {state:'ok',manifest:normalizeManifest(JSON.parse(content.toString()))};
  } catch { return {state:'corrupt'}; }
}
function accountManifestPath(accountStorageDir) { return accountStorageDir ? path.join(accountStorageDir, 'import-manifest.json') : null; }
function createAccountManifestStore({file, readFile, writeAtomic, runExclusive, isCurrent}) {
  if (!file || ![readFile,writeAtomic,runExclusive,isCurrent].every(x=>typeof x==='function')) throw new TypeError('Bound manifest file and host callbacks required');
  return {
    read: () => readAccountManifest(readFile,file),
    async update(mutator) {
      if (typeof mutator !== 'function') throw new TypeError('Synchronous mutator required');
      return runExclusive(async()=>{
        if (await isCurrent() !== true) return false;
        const result = await readAccountManifest(readFile,file);
        if (!result.manifest) return false;
        const changed = mutator(result.manifest);
        if (changed && typeof changed.then === 'function') throw new TypeError('Synchronous mutator required');
        if (changed === false || await isCurrent() !== true) return false;
        // The host must bind the final identity check and publication under its
        // shared account/ownership transaction; this check alone is not atomic.
        try { return await writeAtomic(file,JSON.stringify(result.manifest)) !== false; } catch { return false; }
      });
    }
  };
}
module.exports={MAX_BYTES,empty,normalizeManifest,readAccountManifest,accountManifestPath,createAccountManifestStore};
