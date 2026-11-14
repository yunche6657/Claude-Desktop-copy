'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const SCHEME = 'claude-media';
// Captured native main process @6772193. Must be registered before app ready.
const SESSION_MEDIA_SCHEME = { scheme:SCHEME, privileges:{standard:true,secure:true,stream:true,bypassCSP:true} };
const STREAM_IMAGE_MIN_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const STREAM_IMAGE_MIME = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.avif':'image/avif'};
function inside(root,target){const rel=path.relative(root,target);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
// Native BKa returns null for malformed/unsupported ranges (serve the full file).
function parseRange(header,size){
  if(!header)return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if(!match)return null;
  const [,left,right]=match;if(left===''&&right==='')return null;
  if(left===''){const length=Number(right);return !Number.isSafeInteger(length)||length===0||size===0?'unsatisfiable':{start:Math.max(0,size-length),end:size-1};}
  const start=Number(left);if(!Number.isSafeInteger(start)||start>=size)return 'unsatisfiable';
  const end=right===''?size-1:Math.min(Number(right),size-1);
  return !Number.isSafeInteger(end)||end<start?null:{start,end};
}
function createSessionMediaProtocol({getSession}){
  if(typeof getSession!=='function')throw new TypeError('getSession must be a function');
  const key=crypto.randomBytes(32),sessionKeys=new Map(),active=new Set();let disposed=false,installed=null;
  const sign=(id,root,relative)=>crypto.createHmac('sha256',sessionKeys.get(id)||key).update(id+'\0'+root+'\0'+relative).digest('base64url');
  async function sessionRoot(id){
    if(disposed)return null;
    const session=await getSession(id);const primary=session?.worktreePath??session?.cwd??session?.workingDir;
    if(typeof primary!=='string'||!path.isAbsolute(primary))return null;
    try{const real=await fs.promises.realpath(primary);return (await fs.promises.stat(real)).isDirectory()?real:null;}catch{return null;}
  }
  async function openContained(root,relative){
    if(typeof relative!=='string'||!relative||relative.includes('\0')||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))return null;
    const lexical=path.resolve(root,relative);if(!inside(root,lexical))return null;
    let file;
    try{
      const real=await fs.promises.realpath(lexical);if(!inside(root,real))return null;
      file=await fs.promises.open(real,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      const stat=await file.stat();if(!stat.isFile()){await file.close();return null;}
      const confirmed=await fs.promises.realpath(lexical),namedStat=await fs.promises.stat(confirmed);
      if(confirmed!==real||!inside(root,confirmed)||namedStat.dev!==stat.dev||namedStat.ino!==stat.ino){await file.close();return null;}
      return {file,stat,real};
    }catch{await file?.close().catch(()=>{});return null;}
  }
  async function mintImageUrl(sessionId,requested){
    if(typeof sessionId!=='string'||!sessionId||typeof requested!=='string'||!requested||requested.includes('\0'))return null;
    const root=await sessionRoot(sessionId);if(!root)return null;
    const absolute=path.resolve(root,requested);if(!inside(root,absolute))return null;
    const relative=path.relative(root,absolute).split(path.sep).join('/');
    const opened=await openContained(root,relative);if(!opened)return null;
    try{
      const mime=STREAM_IMAGE_MIME[path.extname(opened.real).toLowerCase()];
      if(!mime||opened.stat.size<STREAM_IMAGE_MIN_BYTES||opened.stat.size>MAX_IMAGE_BYTES||await sessionRoot(sessionId)!==root)return null;
      const canonicalRelative=path.relative(root,opened.real).split(path.sep).join('/');
      return SCHEME+'://s/'+encodeURIComponent(sessionId)+'/'+canonicalRelative.split('/').map(encodeURIComponent).join('/')+'?sig='+sign(sessionId,root,canonicalRelative)+'&v='+Math.floor(opened.stat.mtimeMs);
    }finally{await opened.file.close().catch(()=>{});}
  }
  async function handle(request){
    let url;try{url=new URL(request.url);}catch{return new Response(null,{status:400});}
    const missing=()=>new Response(null,{status:404});
    if(disposed||url.protocol!==SCHEME+':'||url.hostname!=='s'||url.username||url.password||url.port)return missing();
    let parts;try{parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);}catch{return missing();}
    const sessionId=parts.shift(),relative=parts.join('/');
    if(!sessionId||!relative||parts.some(p=>p.includes('/')||p.includes('\\')||p==='.'||p==='..'||p.includes('\0')))return missing();
    const mime=STREAM_IMAGE_MIME[path.extname(relative).toLowerCase()];if(!mime)return missing();
    const root=await sessionRoot(sessionId);if(!root)return missing();
    const signature=url.searchParams.get('sig')||'',expected=sign(sessionId,root,relative);
    if(Buffer.byteLength(signature)!==Buffer.byteLength(expected)||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return missing();
    const opened=await openContained(root,relative);if(!opened)return missing();
    let handedOff=false;
    try{
      if(opened.stat.size>MAX_IMAGE_BYTES||await sessionRoot(sessionId)!==root||signature!==sign(sessionId,root,relative))return missing();
      const size=opened.stat.size,range=parseRange(request.headers?.get?.('range'),size);
      const headers=new Headers({'Content-Type':mime,'Accept-Ranges':'bytes','Cache-Control':'no-store'});
      if(range==='unsatisfiable'){headers.set('Content-Range','bytes */'+size);return new Response(null,{status:416,headers});}
      if(size===0){headers.set('Content-Length','0');return new Response(null,{status:200,headers});}
      const start=range?.start??0,end=range?.end??size-1;
      headers.set('Content-Length',String(end-start+1));if(range)headers.set('Content-Range','bytes '+start+'-'+end+'/'+size);
      if(request.method==='HEAD')return new Response(null,{status:range?206:200,headers});
      const stream=opened.file.createReadStream({start,end,autoClose:true});
      const item={sessionId,stream};active.add(item);stream.once('close',()=>active.delete(item));
      const response=new Response(Readable.toWeb(stream),{status:range?206:200,headers});handedOff=true;return response;
    }catch{return new Response(null,{status:500});}
    finally{if(!handedOff)await opened.file.close().catch(()=>{});}
  }
  function revokeSession(sessionId){sessionKeys.get(sessionId)?.fill(0);sessionKeys.set(sessionId,crypto.randomBytes(32));for(const item of active)if(item.sessionId===sessionId)item.stream.destroy();}
  function install(protocol){if(disposed)throw new Error('Session media protocol disposed');if(installed)throw new Error('Session media protocol already installed');protocol.handle(SCHEME,handle);installed=protocol;return {dispose};}
  function dispose(){if(disposed)return;disposed=true;key.fill(0);for(const sessionKey of sessionKeys.values())sessionKey.fill(0);sessionKeys.clear();for(const item of active)item.stream.destroy();active.clear();if(installed){installed.unhandle(SCHEME);installed=null;}}
  return {mintImageUrl,handle,install,revokeSession,dispose};
}
module.exports={createSessionMediaProtocol,parseRange,SESSION_MEDIA_SCHEME,STREAM_IMAGE_MIME,STREAM_IMAGE_MIN_BYTES,MAX_IMAGE_BYTES};
