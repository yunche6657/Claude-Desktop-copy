'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Recovered from index.chunk-Bn6onBlX.js: the file editor uses optimistic SHA256
// text hashes, writes only to worktreePath ?? cwd, and protects these package keys.
const MAX_BYTES = 10 * 1024 * 1024;
const HOOK_KEYS = ['lint-staged', 'husky', 'commitlint', 'pre-commit', 'precommit', 'gitHooks', 'nano-staged'];
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const inside = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const object = text => { try { const v=JSON.parse(text.replace(/^\uFEFF/,''));return v && typeof v==='object'&&!Array.isArray(v)?v:null; } catch { return null; } };
function hookKeyChanged(before, after) {
  const next=object(after);
  if(!next)return false;
  const previous=object(before)||{};
  return HOOK_KEYS.some(key=>JSON.stringify(previous[key])!==JSON.stringify(next[key]));
}

function createSessionFileAccess({ getSession, changed = () => {} }) {
  const queues = new Map();
  function rootsFor(session, write) {
    const primary = session?.worktreePath ?? session?.cwd ?? session?.workingDir;
    return (write ? [primary] : [primary, session?.workingDir, session?.originCwd, session?.harnessCwd,
      ...(session?.userSelectedFolders || []), ...(session?.additionalDirectories || [])]).filter(r=>typeof r==='string'&&r);
  }
  async function targetFor(sessionId, requested, write, create = false) {
    const session=getSession(sessionId);
    if(!session||typeof requested!=='string'||!requested||requested.includes('\0'))return null;
    if(create&&/[\\/]$/.test(requested))return null;
    const roots=rootsFor(session,write);
    if(!roots.length)return null;
    const base=create ? session.harnessCwd||roots[0] : roots[0];
    const target=path.resolve(base,requested);
    for(const root of roots){
      if(!inside(root,target))continue;
      if(create&&path.relative(root,target).split(path.sep)[0].toLowerCase()==='scratchpad')return null;
      try {
        const realRoot=await fs.promises.realpath(root);
        let existing=target;
        const suffix=[];
        while(true){
          try { const real=await fs.promises.realpath(existing);const realTarget=path.join(real,...suffix.reverse());
            if(inside(realRoot,realTarget))return {path:realTarget,displayPath:target,root:realRoot};
            return null;
          } catch(e) { if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')return null;const parent=path.dirname(existing);if(parent===existing)return null;suffix.push(path.basename(existing));existing=parent; }
        }
      } catch { return null; }
    }
    return null;
  }
  async function serialized(target, action) {
    const previous=queues.get(target)||Promise.resolve();
    const job=previous.catch(()=>{}).then(action);
    queues.set(target,job);
    try { return await job; } finally { if(queues.get(target)===job)queues.delete(target); }
  }
  async function readWithStatus(sessionId, requested, options = {}) {
    if(!getSession(sessionId)||typeof requested!=='string'||!requested)return {status:'readError'};
    const target=await targetFor(sessionId,requested,false);
    if(!target)return {status:'outsideSessionFolders'};
    let stat;
    try {stat=await fs.promises.stat(target.path);}catch(e){return e.code==='ENOENT'||e.code==='ENOTDIR'?{status:'notFound',creatable:!!(await targetFor(sessionId,requested,true,true))}:{status:'readError'};}
    if(!stat.isFile())return {status:'readError'};
    if(stat.size>MAX_BYTES)return {status:'tooLarge',maxBytes:MAX_BYTES};
    try {
      const contents=await fs.promises.readFile(target.path,'utf8');
      const writable=options.includeHash!==false&&!!(await targetFor(sessionId,requested,true));
      return {status:'ok',file:{contents,absPath:target.displayPath,fileSize:stat.size,...(writable?{hash:hash(contents)}:{}),path:target.displayPath,name:path.basename(target.displayPath),size:stat.size}};
    } catch {return {status:'readError'};}
  }
  async function write(sessionId, requested, contents, expectedHash) {
    if(typeof contents!=='string')return {status:'denied'};
    const target=await targetFor(sessionId,requested,true);
    if(!target)return {status:'denied'};
    return serialized(target.path,async()=>{
      let previous,currentHash;
      try {previous=await fs.promises.readFile(target.path,'utf8');currentHash=hash(previous);}catch{}
      if(path.basename(target.path).toLowerCase()==='package.json'&&hookKeyChanged(previous,contents))return {status:'denied',deniedReason:'hook_manager_package_key'};
      if(expectedHash!==undefined&&currentHash!==expectedHash){changed(sessionId);return {status:'conflict',currentHash};}
      const temp=path.join(path.dirname(target.path),'.'+path.basename(target.path)+'.'+crypto.randomUUID()+'.tmp');
      try {
        await fs.promises.writeFile(temp,contents,{encoding:'utf8',flag:'wx'});
        await fs.promises.rename(temp,target.path);
        return {status:'ok',hash:hash(contents)};
      } catch { return null; }
      finally { try{await fs.promises.unlink(temp);}catch{} changed(sessionId); }
    });
  }
  async function create(sessionId, requested) {
    const target=await targetFor(sessionId,requested,true,true);
    if(!target)return {status:'denied'};
    try {
      await fs.promises.mkdir(path.dirname(target.path),{recursive:true});
      const file=await fs.promises.open(target.path,'wx');await file.close();
      return {status:'ok'};
    } catch(e){ return e.code==='EEXIST'?{status:'conflict'}:null; }
    finally {changed(sessionId);}
  }
  // Resolve a path purely for the "reveal in folder" action.
  //
  // Reveal does not read or write, so it must not fail just because the file is absent or
  // huge — it only needs to know the path is inside a folder this session owns. Returning
  // the resolved path (or null when it is outside every root) keeps that distinction at the
  // bridge, where the truthiness contract lives.
  async function resolveForReveal(sessionId, requested) {
    if (!getSession(sessionId) || typeof requested !== 'string' || !requested) return null;
    return targetFor(sessionId, requested, false);
  }
  return {readWithStatus,write,create,resolveForReveal};
}
module.exports = {createSessionFileAccess,MAX_BYTES,HOOK_KEYS,hash,hookKeyChanged};
