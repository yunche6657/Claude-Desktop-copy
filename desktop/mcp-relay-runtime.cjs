'use strict';
// Experimental owner. The embedding host must privately pass bootstrapEnv to CCB
// and supply authoritative actor/source/permission providers.
const net=require('node:net'),crypto=require('node:crypto'),path=require('node:path');
const {spawn}=require('node:child_process');
const {createMcpRelayHost}=require('./mcp-relay-host.cjs');
function createMcpRelayRuntime({isCurrent,authorize,onStatus=()=>{},bootstrapTimeoutMs=10000}){
 if(typeof isCurrent!=='function'||typeof authorize!=='function'||!Number.isSafeInteger(bootstrapTimeoutMs)||bootstrapTimeoutMs<=0)throw TypeError('authority callbacks required');
 const entries=new Map();let disposed=false;
 const current=s=>{try{return isCurrent(s)===true}catch{return false}};
 async function register({actor,server,source,authorityRevision,signal,command,args=[],env,cwd,nodePath=process.execPath}){
  if(disposed||!actor||typeof server!=='string'||!server||source?.name!==server||typeof source.kind!=='string'||typeof source.conflicts!=='function'||!['string','number'].includes(typeof source.revision)||!['string','number'].includes(typeof authorityRevision)||!signal||signal.aborted||typeof command!=='string'||!Array.isArray(args))throw TypeError('complete current authority and transport required');
  for(const e of entries.values())if(e.snapshot.actor===actor&&e.snapshot.server===server)throw Error('server already registered');
  const snapshot=Object.freeze({actor,server,source:Object.freeze({name:source.name,kind:source.kind,revision:source.revision,conflicts:source.conflicts}),authorityRevision});
  if(!current(snapshot))throw Error('stale authority');
  const handle=Object.freeze({}),connection={},session={},secret=crypto.randomBytes(32).toString('hex'),envKey=`CCD_MCP_RELAY_${crypto.randomBytes(20).toString('hex').toUpperCase()}`;
  let e={handle,snapshot,connection,session,signal,closed:false,child:null,childExited:false,socket:null,pending:new Set(),host:null,binding:null};entries.set(handle,e);
  const release=()=>{if(e.closed&&(!e.child||e.childExited))entries.delete(handle)};
  const close=(reason=Error('runtime closed'))=>{if(e.closed)return;e.closed=true;clearTimeout(e.bootstrapTimer);signal.removeEventListener('abort',e.abort);try{e.server?.close()}catch{}for(const socket of e.pending)socket.destroy();e.pending.clear();e.host?.dispose();e.socket?.destroy();if(e.child&&!e.childExited)try{e.child.kill()}catch{}release();try{onStatus({handle,state:'closed',reason:reason.message})}catch{}};
  e.close=close;e.abort=()=>close(Error('authority invalidated'));signal.addEventListener('abort',e.abort,{once:true});
  e.bootstrapTimer=setTimeout(()=>close(Error('bootstrap timeout')),bootstrapTimeoutMs);e.bootstrapTimer.unref();
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\ccd-mcp-${crypto.randomBytes(20).toString('hex')}`:path.join(require('node:os').tmpdir(),`ccd-mcp-${crypto.randomBytes(20).toString('hex')}.sock`);
  e.server=net.createServer(socket=>{
   if(e.closed||e.socket||e.pending.size>=16){socket.destroy();return}e.pending.add(socket);let buf=Buffer.alloc(0);
   const pendingTimeout=setTimeout(()=>socket.destroy(),Math.min(1000,bootstrapTimeoutMs));pendingTimeout.unref();
   socket.once('close',()=>{clearTimeout(pendingTimeout);e.pending.delete(socket)});
   const handshake=chunk=>{buf=Buffer.concat([buf,chunk]);const n=buf.indexOf(10);if(n<0){if(buf.length>128)socket.destroy();return}const supplied=buf.subarray(0,n),expected=Buffer.from(secret);if(n!==expected.length||!crypto.timingSafeEqual(supplied,expected)){socket.destroy();return}if(!current(snapshot)){close(Error('invalid bootstrap or authority'));return}socket.removeListener('data',handshake);clearTimeout(pendingTimeout);e.pending.delete(socket);e.socket=socket;clearTimeout(e.bootstrapTimer);e.server.close();for(const other of e.pending)other.destroy();e.pending.clear();
    try{e.child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});e.child.stderr.resume();e.child.once('error',err=>{if(!e.child.pid)e.childExited=true;close(err);release()});e.child.once('exit',()=>{e.childExited=true;close(Error('server exited'));release()});
     e.host=createMcpRelayHost({isCurrent:()=>!e.closed&&current(snapshot),authorize:(_binding,uri)=>authorize(snapshot,uri),onStatus:s=>{try{onStatus({handle,state:s.state})}catch{}}});
     e.binding=e.host.attach({session,actor,connection,source:snapshot.source,signal,clientInput:socket,clientOutput:socket,serverInput:e.child.stdin,serverOutput:e.child.stdout,closeTransport:close});
     const rest=buf.subarray(n+1);if(rest.length)socket.unshift(rest);socket.resume();
    }catch(err){close(err)}
   };socket.on('error',err=>{if(e.socket===socket)close(err);else socket.destroy()});socket.on('data',handshake);
  });
  try{await new Promise((resolve,reject)=>{e.server.once('error',reject);e.server.listen(pipe,resolve)});if(e.closed||!current(snapshot))throw Error('stale authority');}catch(err){close(err);try{e.server.close()}catch{}throw err}
  return {handle,launch:{command:nodePath,args:[path.join(__dirname,'mcp-relay-runtime-client.cjs'),pipe,envKey]},bootstrapEnv:{[envKey]:secret}};
 }
 function get(handle){const e=entries.get(handle);if(!e||e.closed||!e.binding)throw Error('relay not connected');if(!current(e.snapshot)){e.close(Error('stale authority'));throw Error('stale authority')}return e}
 return {register,read:(handle,uri,options)=>{const e=get(handle);return e.host.read(e.binding,uri,options)},apps:handle=>{const e=get(handle);return e.host.getApps(e.binding)},status:handle=>{const e=get(handle);return e.host.getStatus(e.binding)},invalidate:handle=>{const e=entries.get(handle);if(e)e.close(Error('authority invalidated'))},dispose:()=>{disposed=true;for(const e of [...entries.values()])e.close()}};
}
module.exports={createMcpRelayRuntime};
