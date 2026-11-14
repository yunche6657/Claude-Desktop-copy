'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { Readable } = require('node:stream');
const MAX_TEXT_BYTES = 2097024;
const MAX_INTERACTIVE_BYTES = 524288;
const STATIC_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const INTERACTIVE_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; form-action 'none'; base-uri 'self'";
const artifactScheme = { scheme: 'claude-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } };
const inside = (root, file) => { const rel = path.relative(root,file); return rel === '' || (!rel.startsWith('..'+path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const isUnc = value => /^[\\/]{2}/.test(value) || /^\\[?.]\\/.test(value);
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (a,b) => a.dev === String(b.dev) && a.ino === String(b.ino);
const MIME = { '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.svg':'image/svg+xml','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm' };
function resolveRequested(input, cwd) {
  if (typeof input !== 'string' || !input || input.includes('\0')) return null;
  let requested = input;
  if (/^file:/i.test(requested)) { try { const url = new URL(requested); if (url.hostname && url.hostname !== 'localhost') return null; requested = fileURLToPath(url); } catch { return null; } }
  if (requested === '~' || /^~[\\/]/.test(requested)) requested = path.join(os.homedir(),requested.slice(1));
  if (isUnc(requested) || cwd && isUnc(cwd)) return null;
  if (!path.isAbsolute(requested) && !cwd) return null;
  return path.resolve(cwd || path.dirname(requested),requested);
}
function wrapStatic(content,isSvg) {
  const meta='<meta http-equiv="Content-Security-Policy" content="'+STATIC_CSP+'">';
  return isSvg ? '<!doctype html><html><head>'+meta+'<style>html,body{margin:0;height:100%}svg{width:100%;height:100%}</style></head><body>'+content+'</body></html>' : '<!doctype html>'+meta+content;
}
function createPreviewArtifacts({ getSession = () => null, authorizeHtmlFile = () => false } = {}) {
  const grants = new Map(), bindings = new Map(), rawDocuments = new Map(), ownerEpochs = new Map();
  let disposed = false;
  async function sessionAlive(entry) { try { return entry.sessionId === undefined || !!await getSession(entry.sessionId); } catch { return false; } }
  async function approved(info) { try { return await authorizeHtmlFile(info) === true; } catch { return false; } }
  async function sourceInfo(requestedPath,sessionId,cwd,interactive) {
    const requested=resolveRequested(requestedPath,cwd); if (!requested || !['.html','.htm','.svg'].includes(path.extname(requested).toLowerCase())) return null;
    let source,root,sourceStat,rootStat;
    try {
      source=await fs.promises.realpath(requested); if(isUnc(source))return null;
      root=await fs.promises.realpath(interactive ? cwd : path.dirname(source));
      if(isUnc(root)||!inside(root,source))return null;
      [sourceStat,rootStat]=await Promise.all([fs.promises.stat(source,{bigint:true}),fs.promises.stat(root,{bigint:true})]);
      if(!sourceStat.isFile()||!rootStat.isDirectory()||sourceStat.size>BigInt(interactive?MAX_INTERACTIVE_BYTES:MAX_TEXT_BYTES))return null;
    }catch{return null;}
    const info={requestedPath:requested,sourcePath:source,sessionId,cwd,interactive};
    if(!await approved(info))return null;
    return {...info,root,sourceIdentity:identity(sourceStat),rootIdentity:identity(rootStat)};
  }
  async function readRawFile({requestedPath,sessionId,cwd,ownerId,expected}) {
    const epoch=ownerEpochs.get(ownerId)||0;
    if(disposed||!await sessionAlive({sessionId}))return null;
    const info=await sourceInfo(requestedPath,sessionId,cwd,false);if(!info)return null;
    if(expected&&(info.sourcePath!==expected.sourcePath||info.root!==expected.root||!sameIdentity(expected.rootIdentity,{dev:info.rootIdentity.dev,ino:info.rootIdentity.ino})))return null;
    let handle;
    try {
      const before=await fs.promises.lstat(info.sourcePath,{bigint:true});if(!before.isFile())return null;
      handle=await fs.promises.open(info.sourcePath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      const stat=await handle.stat({bigint:true});
      if(!stat.isFile()||!sameIdentity(identity(before),stat)||!sameIdentity(info.sourceIdentity,stat)||stat.size>BigInt(MAX_TEXT_BYTES))return null;
      if(expected&&!sameIdentity(expected.sourceIdentity,stat)&&stat.nlink>1n)return null;
      const content=await handle.readFile('utf8');
      if(content.length>MAX_TEXT_BYTES)return null;
      const mime=path.extname(info.sourcePath).toLowerCase()==='.svg'?'image/svg+xml':'text/html';
      const url='data:'+mime+';charset=utf-8,'+encodeURIComponent(content);
      if(disposed||(ownerEpochs.get(ownerId)||0)!==epoch||url.length>MAX_TEXT_BYTES||!await sessionAlive({sessionId})||await fs.promises.realpath(info.sourcePath)!==info.sourcePath)return null;
      const result={...info,ownerId,url,stamp:{dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtimeNs:String(stat.mtimeNs)}};
      rawDocuments.set(ownerId,result);return result;
    }catch{return null;}finally{if(handle)await handle.close().catch(()=>{});}
  }
  function ownsRaw(url,ownerId) {
    if(disposed||typeof url!=='string'||!url.startsWith('data:'))return false;
    const base=url.split('#',1)[0];
    return ownerId===undefined?[...rawDocuments.values()].some(entry=>entry.url===base):rawDocuments.get(ownerId)?.url===base;
  }
  function mint(entry) {
    if(disposed)return null;
    const token=randomBytes(16).toString('hex');
    const rel=entry.sourcePath ? path.relative(entry.root,entry.sourcePath).split(path.sep).join('/') : 'index.html';
    const url='claude-preview://'+token+'/'+rel.split('/').map(encodeURIComponent).join('/');
    const grant={...entry,token,url,entryPath:'/'+rel,streams:new Set()};grants.set(token,grant);
    return {url,token,sourcePath:entry.sourcePath,root:entry.root,interactive:entry.interactive};
  }
  async function mintFile({requestedPath,sessionId,cwd,interactive=false,ownerId}) {
    if(disposed||!await sessionAlive({sessionId}))return null;
    const info=await sourceInfo(requestedPath,sessionId,cwd,interactive);return info?mint({...info,ownerId,kind:'file'}):null;
  }
  async function mintContent({content,displayPath,isSvg,sessionId,cwd,ownerId}) {
    if(disposed||typeof content!=='string'||content.length>MAX_TEXT_BYTES||typeof isSvg!=='boolean'||typeof sessionId!=='string'||!sessionId||!await sessionAlive({sessionId}))return null;
    if(typeof displayPath!=='string'||displayPath.includes('\0')||isUnc(displayPath)||cwd&&isUnc(cwd))return null;
    return mint({ownerId,kind:'content',sessionId,cwd,interactive:false,body:Buffer.from(wrapStatic(content,isSvg),'utf8')});
  }
  function lookup(url) {
    if(disposed)return null;
    try { const parsed=new URL(url);if(parsed.protocol!=='claude-preview:'||parsed.username||parsed.password||parsed.port)return null;const grant=grants.get(parsed.hostname);return grant?{parsed,grant}:null;}catch{return null;}
  }
  function owns(url,ownerId) { const hit=lookup(url);return !!hit&&(ownerId===undefined||hit.grant.ownerId===ownerId); }
  function isDocument(url,ownerId,token) {const hit=lookup(url);if(!hit||hit.grant.ownerId!==ownerId||hit.grant.token!==token)return false;try{return decodeURIComponent(hit.parsed.pathname)===hit.grant.entryPath;}catch{return false;}}
  function revoke(token) { const entry=grants.get(token);if(!entry)return false;grants.delete(token);for(const stream of entry.streams)stream.destroy();entry.streams.clear();return true; }
  function revokeOwner(ownerId) { ownerEpochs.set(ownerId,(ownerEpochs.get(ownerId)||0)+1);let count=Number(rawDocuments.delete(ownerId));for(const entry of [...grants.values()])if(entry.ownerId===ownerId)count+=Number(revoke(entry.token));return count; }
  async function handleRequest(request,owners) {
    const missing=()=>new Response(null,{status:404});
    if(disposed)return missing();const hit=lookup(request.url);if(!hit)return missing();const {parsed,grant}=hit;
    if(owners&&!owners.has(grant.ownerId)||!await sessionAlive(grant))return missing();
    if(!['GET','HEAD'].includes(request.method||'GET'))return new Response(null,{status:405,headers:{allow:'GET, HEAD'}});
    let decoded;try{decoded=decodeURIComponent(parsed.pathname);}catch{return missing();}
    if(decoded.includes('\0')||decoded.includes('\\')||decoded.includes(':'))return missing();
    const headers={'content-security-policy':grant.interactive?INTERACTIVE_CSP:STATIC_CSP,'cache-control':'no-store','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin'};
    if(grant.kind==='content') {
      if(decoded!==grant.entryPath||!grants.has(grant.token))return missing();
      return new Response(request.method==='HEAD'?null:grant.body,{status:200,headers:{...headers,'content-type':'text/html; charset=utf-8','content-length':String(grant.body.length)}});
    }
    if(!grant.interactive&&decoded!==grant.entryPath)return missing();
    let handle;
    try {
      const rel=decoded.replace(/^\/+/,''),target=path.resolve(grant.root,rel);if(!inside(grant.root,target))return missing();
      const [realRoot,rootStat,realSource,sourceStat,real]=await Promise.all([fs.promises.realpath(grant.root),fs.promises.stat(grant.root,{bigint:true}),fs.promises.realpath(grant.sourcePath),fs.promises.stat(grant.sourcePath,{bigint:true}),fs.promises.realpath(target)]);
      if(realRoot!==grant.root||!sameIdentity(grant.rootIdentity,rootStat)||realSource!==grant.sourcePath||!sameIdentity(grant.sourceIdentity,sourceStat)||!inside(grant.root,real)||isUnc(real))return missing();
      if(!await approved({requestedPath:target,sourcePath:real,sessionId:grant.sessionId,cwd:grant.cwd,interactive:grant.interactive,resource:decoded!==grant.entryPath}))return missing();
      const before=await fs.promises.lstat(real,{bigint:true});if(!before.isFile())return missing();
      handle=await fs.promises.open(real,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const stat=await handle.stat({bigint:true});
      if(!stat.isFile()||!sameIdentity(identity(before),stat)||await fs.promises.realpath(target)!==real||!await sessionAlive(grant)||!grants.has(grant.token))return missing();
      const mime=MIME[path.extname(real).toLowerCase()]||'application/octet-stream';
      if(decoded===grant.entryPath&&stat.size>BigInt(grant.interactive?MAX_INTERACTIVE_BYTES:MAX_TEXT_BYTES))return missing();
      if(!grant.interactive){const content=await handle.readFile('utf8');const body=Buffer.from(wrapStatic(content,path.extname(real).toLowerCase()==='.svg'),'utf8');return new Response(request.method==='HEAD'?null:body,{status:200,headers:{...headers,'content-type':'text/html; charset=utf-8','content-length':String(body.length)}});}
      const responseHeaders={...headers,'content-type':mime,'content-length':String(stat.size)};
      if(request.method==='HEAD')return new Response(null,{status:200,headers:responseHeaders});
      const stream=handle.createReadStream({autoClose:true});handle=null;grant.streams.add(stream);stream.once('close',()=>grant.streams.delete(stream));
      return new Response(Readable.toWeb(stream),{status:200,headers:responseHeaders});
    }catch{return missing();}finally{if(handle)await handle.close().catch(()=>{});}
  }
  async function bindSession(session,ownerId) {
    const existing=bindings.get(session);if(existing){existing.owners.add(ownerId);return true;}
    try {
      if(await session.protocol.isProtocolHandled?.('claude-preview'))return false;
      const owners=new Set([ownerId]);await session.protocol.handle('claude-preview',request=>handleRequest(request,owners));bindings.set(session,{owners});return true;
    }catch{return false;}
  }
  function unbindSession(session,ownerId) { const binding=bindings.get(session);if(!binding)return;binding.owners.delete(ownerId);if(!binding.owners.size){bindings.delete(session);try{session.protocol.unhandle('claude-preview');}catch{}} }
  function dispose() { disposed=true;rawDocuments.clear();for(const token of [...grants.keys()])revoke(token);for(const [session]of bindings){try{session.protocol.unhandle('claude-preview');}catch{}}bindings.clear(); }
  return {mintFile,mintContent,readRawFile,ownsRaw,owns,isDocument,revoke,revokeOwner,handleRequest,bindSession,unbindSession,dispose,sourceInfo};
}
module.exports={createPreviewArtifacts,artifactScheme,STATIC_CSP,INTERACTIVE_CSP,MAX_TEXT_BYTES,MAX_INTERACTIVE_BYTES,resolveRequested};
