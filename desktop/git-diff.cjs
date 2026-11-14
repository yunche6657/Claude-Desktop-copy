'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createNativeGitDiff } = require('./native-git-diff-core.cjs');

function runGit(args, cwd, timeout = 30000, maxBuffer = 5 * 1024 * 1024) {
  const flags = ['-c','core.quotepath=false','-c','core.useReplaceRefs=false','-c','core.fsmonitor='];
  return new Promise((resolve,reject) => execFile('git', [...flags,...args], {
    cwd, windowsHide:true, encoding:'utf8', timeout, maxBuffer:Math.max(1,maxBuffer),
    env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_PAGER:'cat',GIT_TERMINAL_PROMPT:'0'},
  },(error,stdout) => {
    if (error) {
      if (error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') error.code = 'EGITTIMEDOUT';
      reject(error);
    } else resolve(stdout);
  }));
}

function contained(root,file) {
  const rel = path.relative(root,file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

// Matches original Ka/qa: parent must resolve within git root; a final symlink
// is shown as its link target text and never followed. Binary/large files are opaque.
async function readWorkingFile(root,relative,maxBytes) {
  let handle;
  try {
    if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split(/[/\\]/).includes('..')) return {kind:'absent'};
    const realRoot = await fs.realpath(root);
    const absolute = path.resolve(root,relative);
    if (!contained(path.resolve(root),absolute)) return {kind:'absent'};
    const parent = await fs.realpath(path.dirname(absolute));
    if (!contained(realRoot,parent)) return {kind:'absent'};
    const target = path.join(parent,path.basename(absolute));
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return {kind:'text',content:await fs.readlink(target)};
    if (!stat.isFile()) return {kind:'absent'};
    const constants = require('node:fs').constants;
    handle = await fs.open(target,constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return {kind:'absent'};
    if (opened.size > maxBytes) return {kind:'opaque'};
    const {buffer,bytesRead} = await handle.read(Buffer.alloc(opened.size),0,opened.size,0);
    const data = buffer.subarray(0,bytesRead);
    return data.includes(0) ? {kind:'opaque'} : {kind:'text',content:data.toString('utf8')};
  } catch { return {kind:'absent'}; }
  finally { await handle?.close().catch(()=>{}); }
}

function createGitDiff({ isCwdAllowed = () => true, isTrusted = () => false, run = runGit } = {}) {
  const backend = {
    run,
    readWorkingFile,
    workingFileReadConcurrency:4,
    sparseCheckout:cwd => run(['config','--bool','core.sparseCheckout'],cwd).then(x=>x.trim()==='true',()=>false),
    async resolveRepo(cwd,includeHead) {
      try {
        const root = (await run(['rev-parse','--show-toplevel'],cwd)).trim();
        if (!root || !path.isAbsolute(root)) return null;
        if (!await isCwdAllowed(root)) return null;
        const head = includeHead ? (await run(['symbolic-ref','--quiet','--short','HEAD'],cwd).catch(()=> 'HEAD')).trim() || 'HEAD' : undefined;
        return {gitRoot:root,...head?{head}:{}};
      } catch { return null; }
    },
  };
  const native = createNativeGitDiff(backend);
  const fileQueues = new Map();
  async function allowed(cwd) {
    return typeof cwd === 'string' && !cwd.includes('\0') && path.isAbsolute(cwd) && await isCwdAllowed(cwd) && await isTrusted(cwd);
  }
  async function outcome(cwd,action) {
    try {
      if (!await allowed(cwd)) return null;
      const result = await action();
      return result?.kind === 'success' ? result.data : null;
    } catch { return null; }
  }
  async function fileResult(cwd,action) {
    try {
      if (!await allowed(cwd)) return null;
      let queue = fileQueues.get(cwd);
      if (!queue) { queue = {active:0,waiting:[]}; fileQueues.set(cwd,queue); }
      if (queue.active < 4) queue.active++;
      else await new Promise(resolve=>queue.waiting.push(resolve));
      try { return await action(); }
      finally {
        const next = queue.waiting.shift();
        if (next) next();
        else if (--queue.active === 0) fileQueues.delete(cwd);
      }
    } catch { return null; }
  }
  return {
    getGitDiff(cwd,base,head,options) {
      const threshold = options?.inlinePatchesMaxChangedLines;
      const patches = options?.includePatches !== false ? true : Number.isFinite(threshold) && threshold >= 0 ? {inlineMaxChangedLines:threshold} : false;
      return outcome(cwd,()=>native.fetchGitDiff(cwd,base,head,patches));
    },
    getGitDiffStats:(cwd,base,head)=>outcome(cwd,()=>native.fetchGitDiffStats(cwd,base,head)),
    getGitCommits:(cwd,base,head)=>outcome(cwd,()=>native.fetchGitCommits(cwd,base,head)),
    getCommitDiff:(cwd,sha)=>outcome(cwd,()=>native.fetchCommitDiff(cwd,sha)),
    getDiffFileContent:(cwd,mergeBase,file,previous)=>fileResult(cwd,()=>native.fetchDiffFileContent(cwd,mergeBase,file,previous)),
    getGitDiffFilePatch:(cwd,mergeBase,file,previous)=>fileResult(cwd,()=>native.fetchGitDiffFilePatch(cwd,mergeBase,file,previous)),
  };
}

module.exports = { createGitDiff };
