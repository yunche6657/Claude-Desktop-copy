'use strict';

// Restricted terminal HistoryImport reader. The caller owns account identity,
// complete cross-organization ownership and workspace trust. This module does
// not infer any of those from a transcript or from the currently selected org.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINE = 16 * 1024 * 1024;

function within(root, child) {
  const rel = path.relative(root, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function sameFile(a,b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.nlink === b.nlink; }
function identityKey(identity) {
  if (!identity || typeof identity.accountId !== 'string' || !identity.accountId || typeof identity.orgId !== 'string' || !identity.orgId || typeof identity.generation !== 'string' || !identity.generation) throw Error('Import identity unavailable');
  return JSON.stringify([identity.accountId,identity.orgId,identity.generation]);
}

function createTerminalHistoryImport({projectsRoot, stagingDir, getIdentity, getOwnedCliSessionIds, resolveTrustedCwd}) {
  if (![projectsRoot,stagingDir].every(v=>typeof v==='string' && path.isAbsolute(v)) || ![getIdentity,getOwnedCliSessionIds,resolveTrustedCwd].every(v=>typeof v==='function')) throw new TypeError('Trusted paths, identity, ownership and cwd trust are required');
  const candidates = new Map();
  const pending = new Set();
  let scanEpoch = 0;
  async function context() {
    const key = identityKey(await getIdentity());
    const owned = await getOwnedCliSessionIds();
    if (!(owned instanceof Set)) throw Error('Complete ownership snapshot unavailable');
    if (key !== identityKey(await getIdentity())) throw Error('Import identity changed');
    return {key,owned:new Set([...owned].map(v=>String(v).toLowerCase()))};
  }
  async function unchanged(key) { return key === identityKey(await getIdentity()); }
  async function inspect(file, root) {
    const realRoot=await fs.realpath(root), real=await fs.realpath(file);
    if (!within(realRoot,real)) throw Error('Source outside project root');
    const before=await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw Error('Source is not an eligible regular file');
    const handle=await fs.open(file,'r');
    try {
      const opened=await handle.stat();
      if (!opened.isFile() || !sameFile(before,opened)) throw Error('Source changed before open');
      const buffer=Buffer.alloc(opened.size+1);
      let offset=0;
      while (offset<buffer.length) {
        const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);
        if (!bytesRead) break;
        offset+=bytesRead;
      }
      const data=buffer.subarray(0,offset);
      const after=await handle.stat();
      const current=await fs.lstat(file);
      if (data.length > MAX_BYTES || !sameFile(opened,after) || !sameFile(opened,current) || await fs.realpath(file)!==real) throw Error('Source changed during read');
      return {data,stat:opened,real,root:realRoot};
    } finally { await handle.close(); }
  }
  async function parse(data) {
    const rows=[]; const cwds=new Set(); let mainMessage=false; let entrypoint; let createdAt; let lastActivityAt;
    for (const line of data.toString('utf8').split('\n')) {
      if (Buffer.byteLength(line,'utf8')>MAX_LINE) throw Error('Transcript line too large');
      let row; try { row=JSON.parse(line); } catch { continue; }
      if (!row || typeof row!=='object' || Array.isArray(row)) continue;
      if (entrypoint === undefined && typeof row.entrypoint === 'string') entrypoint=row.entrypoint;
      if ((row.type==='user' || row.type==='assistant') && row.isSidechain !== true) mainMessage=true;
      if (typeof row.cwd !== 'string' || !row.cwd) continue;
      cwds.add(row.cwd);
      if (typeof row.timestamp==='string') {
        const time=Date.parse(row.timestamp);
        if (Number.isFinite(time)) { createdAt=createdAt===undefined?time:Math.min(createdAt,time); lastActivityAt=lastActivityAt===undefined?time:Math.max(lastActivityAt,time); }
      }
      const {sessionId,...copy}=row;
      if (copy.toolUseResult && typeof copy.toolUseResult==='object' && !Array.isArray(copy.toolUseResult)) {
        const {agentId,...result}=copy.toolUseResult; copy.toolUseResult=result;
      }
      rows.push(copy);
    }
    // Unknown entrypoint provenance is intentionally excluded until the native
    // entrypoint admission policy is available to the host.
    if (!mainMessage || !rows.length || entrypoint !== undefined) return null;
    let safeCwd=null;
    for (const cwd of cwds) {
      const trusted=await resolveTrustedCwd(cwd);
      if (typeof trusted !== 'string' || !path.isAbsolute(trusted)) return null;
      safeCwd ??= trusted;
    }
    return safeCwd ? {safeCwd,createdAt,lastActivityAt,bytes:Buffer.from(rows.map(row=>JSON.stringify(row)+'\n').join(''))} : null;
  }
  async function scan() {
    const epoch=++scanEpoch;
    candidates.clear();
    const {key,owned}=await context();
    const realRoot=await fs.realpath(projectsRoot);
    const directories=await fs.readdir(realRoot,{withFileTypes:true});
    const found=[]; const next=new Map();
    for (const dir of directories) {
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.name.startsWith('ssh-')) continue;
      const folder=path.join(realRoot,dir.name);
      if (!(await fs.lstat(folder)).isDirectory() || !within(realRoot,await fs.realpath(folder))) continue;
      for (const entry of await fs.readdir(folder,{withFileTypes:true})) {
        const id=entry.name.endsWith('.jsonl') ? entry.name.slice(0,-6) : '';
        if (!entry.isFile() || !UUID.test(id) || owned.has(id.toLowerCase())) continue;
        const file=path.join(folder,entry.name);
        try {
          const snapshot=await inspect(file,realRoot); const parsed=await parse(snapshot.data);
          if (!parsed || !(await unchanged(key))) continue;
          const token=crypto.randomUUID();
          next.set(token,{file,id,identity:key,digest:crypto.createHash('sha256').update(snapshot.data).digest('hex')});
          found.push({sourceToken:token,sessionId:id,title:'Terminal session',kind:'code',lastActivityAt:snapshot.stat.mtimeMs,sizeBytes:snapshot.stat.size,accountId:'',alreadyImported:false});
        } catch { /* A single unreadable or untrusted candidate is omitted. */ }
      }
    }
    if (!(await unchanged(key))) throw Error('Import identity changed');
    if (epoch!==scanEpoch) throw Error('Import scan superseded');
    const counts=new Map();
    for (const item of next.values()) counts.set(item.id.toLowerCase(),(counts.get(item.id.toLowerCase()) ?? 0)+1);
    candidates.clear();
    for (const [token,item] of next) if (counts.get(item.id.toLowerCase())===1) candidates.set(token,item);
    return found.filter(item=>counts.get(item.sessionId.toLowerCase())===1).sort((a,b)=>b.lastActivityAt-a.lastActivityAt);
  }
  async function stage(sourceToken) {
    if (pending.has(sourceToken)) return null;
    const candidate=candidates.get(sourceToken); if (!candidate) return null;
    pending.add(sourceToken);
    const epoch=scanEpoch;
    try {
    const {key,owned}=await context();
    if (key!==candidate.identity || owned.has(candidate.id.toLowerCase())) return null;
    const snapshot=await inspect(candidate.file,projectsRoot);
    if (crypto.createHash('sha256').update(snapshot.data).digest('hex')!==candidate.digest) return null;
    const parsed=await parse(snapshot.data); if (!parsed || !(await unchanged(key))) return null;
    const checked=await context(); if (checked.key!==key || checked.owned.has(candidate.id.toLowerCase())) return null;
    const dir=await fs.lstat(stagingDir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || await fs.realpath(stagingDir)!==path.resolve(stagingDir)) throw Error('Private staging directory is not stable');
    const stagingPath=path.join(stagingDir,`.import-${crypto.randomUUID()}.tmp`);
    const handle=await fs.open(stagingPath,'wx',0o600); let completed=false;
    try {
      await handle.writeFile(parsed.bytes); await handle.sync();
      const finalContext=await context();
      if (finalContext.key!==key || finalContext.owned.has(candidate.id.toLowerCase()) || epoch!==scanEpoch || candidates.get(sourceToken)!==candidate) throw Error('Import identity, ownership or scan changed');
      completed=true;
    } finally {
      const own=await handle.stat().catch(()=>null); await handle.close();
      if (!completed && own) {
        const current=await fs.lstat(stagingPath).catch(()=>null);
        if (current && sameFile(own,current)) await fs.unlink(stagingPath).catch(()=>{});
      }
    }
    candidates.delete(sourceToken);
    return {stagingPath,safeCwd:parsed.safeCwd,sourceSessionId:candidate.id,identityKey:key,createdAt:parsed.createdAt,lastActivityAt:parsed.lastActivityAt};
    } finally { pending.delete(sourceToken); }
  }
  return {scan,stage};
}
module.exports={createTerminalHistoryImport};
