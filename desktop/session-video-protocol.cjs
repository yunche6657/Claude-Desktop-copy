'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createSessionFileAccess } = require('./session-file-access.cjs');
const { parseRange } = require('./session-media-protocol.cjs');
// Native index.chunk-Bn6onBlX.js @1000469 / @1027982. Streaming has no native size cap.
const MEDIA_MIME = { '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/mp4','.m4v':'video/mp4','.ogv':'video/ogg',
  '.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.wav':'audio/wav','.flac':'audio/flac','.opus':'audio/ogg','.ogg':'audio/ogg','.oga':'audio/ogg' };
const MEDIA_DATA_URL_MAX_BYTES = 50 * 1024 * 1024;
const PANEL_DATA_URL_MAX_BYTES = 25 * 1024 * 1024;
const TOKEN_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_CACHE_LIMIT = 64;
function createSessionVideoProtocol({getSession,isPathAllowed=()=>true,now=Date.now}) {
  if(typeof getSession!=='function'||typeof isPathAllowed!=='function'||typeof now!=='function')throw new TypeError('Invalid media authorization callbacks');
  // Native grantedRoots uses cwd/origin/worktree/harness/additionalDirectories;
  // userSelectedFolders and a second workingDir do not silently grant media reads.
  const absolute=value=>typeof value==='string'&&path.isAbsolute(value)?value:undefined;
  function mediaSession(id){const session=getSession(id);if(!session)return null;return {...session,
    cwd:absolute(session.cwd)??absolute(session.workingDir),worktreePath:absolute(session.worktreePath),
    originCwd:absolute(session.originCwd),harnessCwd:absolute(session.harnessCwd),workingDir:undefined,userSelectedFolders:[],
    additionalDirectories:Array.isArray(session.additionalDirectories)?session.additionalDirectories.filter(value=>absolute(value)):[]};}
  const access=createSessionFileAccess({getSession:mediaSession});
  const tokens=new Map(),epochs=new Map(),active=new Set();let disposed=false,generation=0;
  const epoch=id=>epochs.get(id)||0;
  const missing=()=>new Response(null,{status:404});
  function prune(){const time=now();for(const [token,entry]of tokens)if(time-entry.lastUsedAtMs>TOKEN_IDLE_TTL_MS)tokens.delete(token);}
  function touch(token,entry){if(tokens.get(token)!==entry)return;entry.lastUsedAtMs=now();tokens.delete(token);tokens.set(token,entry);}
  async function openCandidate(sessionId,requested) {
    if(disposed||typeof sessionId!=='string'||typeof requested!=='string'||!requested||requested.includes('\0'))return null;
    const capturedEpoch=epoch(sessionId),capturedGeneration=generation;
    const target=await access.resolveForReveal(sessionId,requested);if(!target)return null;
    const mime=MEDIA_MIME[path.extname(target.path).toLowerCase()];if(!mime)return null;
    let file;
    try{
      if(!await isPathAllowed(target.path,{sessionId,root:target.root}))return null;
      file=await fs.promises.open(target.path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      const stat=await file.stat();if(!stat.isFile()){await file.close();return null;}
      const confirmed=await access.resolveForReveal(sessionId,requested);
      const namedStat=confirmed?await fs.promises.stat(confirmed.path):null;
      if(disposed||capturedEpoch!==epoch(sessionId)||capturedGeneration!==generation||!confirmed||confirmed.path!==target.path||confirmed.root!==target.root||namedStat.dev!==stat.dev||namedStat.ino!==stat.ino||!await isPathAllowed(confirmed.path,{sessionId,root:confirmed.root})){
        await file.close();return null;
      }
      return {file,stat,absPath:target.path,root:target.root,mime,epoch:capturedEpoch,generation:capturedGeneration};
    }catch{await file?.close().catch(()=>{});return null;}
  }
  async function openForSession(sessionId,requested,lane='panel') {
    // Native general resolver tries harness-relative files first. The panel
    // resolver resolves the literal requested path from primaryFolder, then
    // admits it against all grantedRoots; panel is not primary-only.
    const session=mediaSession(sessionId);
    if(lane==='general'&&session?.harnessCwd&&typeof requested==='string'&&!path.isAbsolute(requested)){
      const primary=session.worktreePath??session.cwd;
      if(session.harnessCwd!==primary){const fromHarness=await openCandidate(sessionId,path.resolve(session.harnessCwd,requested));if(fromHarness)return fromHarness;}
    }
    return openCandidate(sessionId,requested);
  }
  async function mint(sessionId,requested,lane='panel') {
    const opened=await openForSession(sessionId,requested,lane);if(!opened)return null;
    try{
      if(disposed||opened.epoch!==epoch(sessionId)||opened.generation!==generation)return null;
      prune();let token,entry;
      for(const [existing,candidate]of tokens)if(candidate.absPath===opened.absPath&&candidate.mime===opened.mime){token=existing;entry=candidate;break;}
      if(!entry){while(tokens.size>=TOKEN_CACHE_LIMIT)tokens.delete(tokens.keys().next().value);token=crypto.randomBytes(16).toString('base64url');entry={absPath:opened.absPath,mime:opened.mime,owners:new Map(),lastUsedAtMs:now()};tokens.set(token,entry);}
      entry.owners.set(sessionId,{root:opened.root,epoch:opened.epoch});touch(token,entry);
      return 'claude-media://v/'+token+'?v='+Math.floor(opened.stat.mtimeMs);
    }finally{await opened.file.close().catch(()=>{});}
  }
  async function readDataUrl(sessionId,requested,maxBytes,lane) {
    const opened=await openForSession(sessionId,requested,lane);if(!opened)return null;
    try{
      if(opened.stat.size>maxBytes)return null;
      const bytes=Buffer.alloc(opened.stat.size+1);let used=0;
      while(used<bytes.length){const read=await opened.file.read(bytes,used,bytes.length-used,null);if(!read.bytesRead)break;used+=read.bytesRead;}
      if(used>opened.stat.size||used>maxBytes||disposed||opened.epoch!==epoch(sessionId)||opened.generation!==generation)return null;
      const confirmed=await access.resolveForReveal(sessionId,opened.absPath);
      if(!confirmed||confirmed.path!==opened.absPath||confirmed.root!==opened.root||!await isPathAllowed(confirmed.path,{sessionId,root:confirmed.root})||disposed||opened.epoch!==epoch(sessionId)||opened.generation!==generation)return null;
      return 'data:'+opened.mime+';base64,'+bytes.subarray(0,used).toString('base64');
    }catch{return null;}finally{await opened.file.close().catch(()=>{});}
  }
  async function handle(request) {
    let url;try{url=new URL(request.url);}catch{return new Response(null,{status:400});}
    if(disposed||url.protocol!=='claude-media:'||url.hostname!=='v'||url.username||url.password||url.port)return missing();
    const token=url.pathname.split('/').filter(Boolean)[0];if(!token)return missing();prune();const entry=tokens.get(token);if(!entry)return missing();
    let opened,ownerId;
    for(const [sessionId,owner]of entry.owners){
      if(owner.epoch!==epoch(sessionId)){entry.owners.delete(sessionId);continue;}
      const candidate=await openForSession(sessionId,entry.absPath);
      if(candidate&&candidate.root===owner.root&&candidate.mime===entry.mime){opened=candidate;ownerId=sessionId;break;}
      await candidate?.file.close().catch(()=>{});
    }
    if(!opened)return missing();let handedOff=false;
    try{
      if(disposed||tokens.get(token)!==entry||!entry.owners.has(ownerId)||opened.epoch!==epoch(ownerId))return missing();
      const size=opened.stat.size,range=parseRange(request.headers?.get?.('range'),size);
      const headers=new Headers({'Content-Type':entry.mime,'Accept-Ranges':'bytes','Cache-Control':'no-store'});
      touch(token,entry);
      if(range==='unsatisfiable'){headers.set('Content-Range','bytes */'+size);return new Response(null,{status:416,headers});}
      if(size===0){headers.set('Content-Length','0');return new Response(null,{status:200,headers});}
      const start=range?.start??0,end=range?.end??size-1;headers.set('Content-Length',String(end-start+1));if(range)headers.set('Content-Range','bytes '+start+'-'+end+'/'+size);
      if(request.method==='HEAD')return new Response(null,{status:range?206:200,headers});
      const stream=opened.file.createReadStream({start,end,autoClose:true});const item={stream,entry,sessionId:ownerId};active.add(item);stream.once('close',()=>active.delete(item));
      const response=new Response(Readable.toWeb(stream),{status:range?206:200,headers});handedOff=true;return response;
    }catch{return new Response(null,{status:500});}finally{if(!handedOff)await opened.file.close().catch(()=>{});}
  }
  function revokeSession(sessionId){epochs.set(sessionId,epoch(sessionId)+1);for(const [token,entry]of tokens){entry.owners.delete(sessionId);if(!entry.owners.size)tokens.delete(token);}for(const item of active)if(item.sessionId===sessionId)item.stream.destroy();}
  function clear(){generation++;tokens.clear();for(const item of active)item.stream.destroy();active.clear();}
  function dispose(){if(disposed)return;disposed=true;clear();epochs.clear();}
  return { getSessionMediaStreamUrl:(id,requested)=>mint(id,requested,'general'),getSessionPanelMediaStreamUrl:(id,requested)=>mint(id,requested,'panel'),
    readSessionMediaAsDataUrl:(id,requested)=>readDataUrl(id,requested,MEDIA_DATA_URL_MAX_BYTES,'general'),
    readSessionPanelMediaAsDataUrl:(id,requested)=>readDataUrl(id,requested,PANEL_DATA_URL_MAX_BYTES,'panel'),
    handle,revokeSession,clear,dispose };
}
module.exports={createSessionVideoProtocol,MEDIA_MIME,MEDIA_DATA_URL_MAX_BYTES,PANEL_DATA_URL_MAX_BYTES,TOKEN_IDLE_TTL_MS,TOKEN_CACHE_LIMIT};
