'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Native Bn6onBlX @1021049 (trust/list), @1023248 (link walk),
// lzaSYO3Q @2605594 (HU metadata exclusions), @3773529 (trusted ancestor).
const HIDDEN = new Set(['.git','.svn','.hg','CVS','.DS_Store','__MACOSX','Thumbs.db','desktop.ini']);
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
const refused = () => new Error('Directory could not be read');
async function walkListedLink(base, target, realRoot, lexicalRoot) {
  const pending = []; let current = base, stat = null, hops = 1, steps = 0;
  const enqueue = value => {
    const absolute = path.resolve(current, value), prefix = path.parse(absolute).root;
    if (path.isAbsolute(absolute)) { current = prefix; stat = null; }
    pending.unshift(...absolute.slice(prefix.length).split(/[\\/]+/));
  };
  enqueue(target);
  while (pending.length) {
    const part = pending.shift();
    if (stat && !stat.isDirectory()) return { end: 'dangling' };
    if (!part || part === '.') continue;
    if (++steps > 1024) return { end: 'external' };
    if (part === '..') {
      if (!inside(realRoot,current) && !inside(current,realRoot)) return { end:'external' };
      current = path.dirname(current); stat = null; continue;
    }
    const next = path.join(current,part);
    if (!inside(realRoot,next)) {
      if (inside(next,realRoot)) current = next;
      else if (inside(next,lexicalRoot)) current = path.relative(lexicalRoot,next)==='' ? realRoot : next;
      else return { end:'external' };
      stat = null; continue;
    }
    let entry; try { entry = await fs.promises.lstat(next); } catch { return { end:'dangling' }; }
    if (!entry.isSymbolicLink()) { current=next; stat=entry; continue; }
    if (++hops > 40) return { end:'cycle' };
    let link; try { link=await fs.promises.readlink(next); } catch { return { end:'external' }; }
    enqueue(link);
  }
  if (!inside(realRoot,current)) return { end:'external' };
  try { return { end:'ok', path:current, stat:stat || await fs.promises.lstat(current) }; }
  catch { return { end:'dangling' }; }
}
function createLandingDirectory({ isTrusted = () => false, getTrustedRoot = null, isCwdAllowed = () => true } = {}) {
  async function listDirectoryAtCwd(cwd, requested) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')
      || typeof requested !== 'string' || !requested || requested.includes('\0')) return [];
    const root=path.resolve(cwd); let realRoot,rootStat;
    try {
      if (!await isCwdAllowed(root)) throw refused();
      rootStat=await fs.promises.lstat(root); realRoot=await fs.promises.realpath(root);
      if (!(await fs.promises.stat(realRoot)).isDirectory()) throw refused();
      if (!await isTrusted(realRoot)) {
        const trustedRoot=getTrustedRoot ? await getTrustedRoot(root) : await isTrusted(root) ? root : null;
        if (!trustedRoot || !inside(path.resolve(trustedRoot),root)
          || !inside(await fs.promises.realpath(trustedRoot),realRoot)) throw refused();
      }
    } catch { throw refused(); }
    const target=path.resolve(root,requested);
    if (!inside(root,target)) return [];
    let realTarget,before,entries;
    try {
      realTarget=await fs.promises.realpath(target);
      if (!inside(realRoot,realTarget)) return [];
      before=await fs.promises.stat(realTarget);
      entries=await fs.promises.readdir(realTarget,{withFileTypes:true});
    } catch { throw refused(); }
    const visible=entries.filter(entry=>!HIDDEN.has(entry.name));
    const rows=visible.map(entry=>({name:entry.name,path:path.join(target,entry.name),isDirectory:entry.isDirectory()}));
    const links=visible.flatMap((entry,index)=>entry.isSymbolicLink()?[index]:[]);
    let cursor=0;
    const classify=async index=>{
      const row=rows[index], filename=path.join(realTarget,row.name);
      let stat; try { stat=await fs.promises.lstat(filename); } catch {}
      // Native rechecks lstat: Electron can report a junction as a directory here
      // even when readdir's Dirent reports a link. Do not invent a target fallback.
      if (!stat?.isSymbolicLink()) { rows[index]={...row,isDirectory:stat?.isDirectory()??false}; return; }
      let link=''; try { link=await fs.promises.readlink(filename); } catch {}
      const result=await walkListedLink(path.dirname(filename),link,realRoot,root);
      let state=result.end;
      if (state==='ok') {
        let canonical; try { canonical=await fs.promises.realpath(result.path); } catch {}
        state=!canonical||!inside(realRoot,canonical) ? 'external' : inside(canonical,realTarget) ? 'cycle' : 'ok';
      }
      rows[index]={...row,isDirectory:state==='ok'&&result.stat.isDirectory(),link:{target:link,state}};
    };
    await Promise.all(Array.from({length:Math.min(8,links.length)},async()=>{
      while(cursor<links.length) { const index=links[cursor++]; await classify(index); }
    }));
    try {
      const afterRoot=await fs.promises.lstat(root),after=await fs.promises.stat(realTarget);
      if (afterRoot.dev!==rootStat.dev || afterRoot.ino!==rootStat.ino || before.dev!==after.dev || before.ino!==after.ino
        || await fs.promises.realpath(root)!==realRoot || await fs.promises.realpath(target)!==realTarget) throw refused();
    } catch { throw refused(); }
    return rows;
  }
  return {listDirectoryAtCwd};
}
module.exports={createLandingDirectory};
