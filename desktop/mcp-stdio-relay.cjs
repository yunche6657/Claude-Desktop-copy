'use strict';


// Experimental transport primitive. The owner must supply authenticated bindings,
// authorization, discovery policy, process lifecycle and binding invalidation.
function createMcpStdioRelay({clientInput, clientOutput, serverInput, serverOutput, actor, connection, isCurrent, onToolsListStart, onToolsList, onToolsListChanged, onToolsListEnd, onClose, bindingSignal, maxMessageBytes=10*1024*1024, maxPending=256, maxQueuedBytes=20*1024*1024}) {
 if (!actor || !connection || typeof isCurrent !== 'function') throw new TypeError('actor, connection and isCurrent required');
 for(const n of [maxMessageBytes,maxPending,maxQueuedBytes]) if(!Number.isSafeInteger(n)||n<=0) throw new TypeError('invalid relay limits');
 let closed=false, seq=0, toolsSequence=0;
 const listeners=[];
 const listen=(s,event,fn)=>{s.on(event,fn);listeners.push(()=>s.removeListener(event,fn))};
 const queues=new Map([[clientOutput,{items:[],bytes:0,blocked:false,source:serverOutput}],[serverInput,{items:[],bytes:0,blocked:false,source:clientInput}]]);
 const clientPending=new Map(), clientOriginal=new Map(), serverPending=new Map(), serverOriginal=new Map(), hostPending=new Map();
 const key=id=>`${typeof id}:${String(id)}`;
 const validId=id=>typeof id==='string'||(typeof id==='number'&&Number.isFinite(id));
 const current=()=>{try{return isCurrent(actor,connection)===true}catch{return false}};
 const cleanupEntry=e=>{if(e.timer)clearTimeout(e.timer);if(e.signal&&e.abort)e.signal.removeEventListener('abort',e.abort)};
 function close(reason=new Error('relay closed')) {
  if(closed)return;closed=true;
  for(const e of hostPending.values()){cleanupEntry(e);e.reject(reason)}
  hostPending.clear();clientPending.clear();clientOriginal.clear();serverPending.clear();serverOriginal.clear();
  for(const remove of listeners)remove();
  if(bindingSignal)bindingSignal.removeEventListener('abort',invalidate);
  for(const q of queues.values()){q.items.length=0;q.bytes=0}
  if(onClose)try{onClose(reason)}catch{}
 }
 function ensure(){if(closed)throw Error('relay closed');if(!current()){const e=Error('stale relay binding');close(e);throw e}}
 function invalidate(){close(Error('stale relay binding'))}
 function flush(stream){const q=queues.get(stream);if(closed)return;try{ensure();q.blocked=false;while(q.items.length){const data=q.items.shift();q.bytes-=data.length;if(!stream.write(data)){q.blocked=true;q.source.pause();break}}if(!q.blocked)q.source.resume()}catch(e){close(e)}}
 function write(stream,message){ensure();try{const data=Buffer.from(JSON.stringify(message)+'\n');if(data.length-1>maxMessageBytes)throw Error('relay message too large');const q=queues.get(stream);if(q.bytes+data.length>maxQueuedBytes)throw Error('relay output queue limit exceeded');q.items.push(data);q.bytes+=data.length;if(!q.blocked)flush(stream);if(closed)throw Error('relay closed')}catch(e){close(e);throw e}}
 const emit=(s,q)=>{try{write(s,q)}catch(e){close(e)}};
 function receive(side,line){
  try{ensure();const q=JSON.parse(line);if(!q||typeof q!=='object'||Array.isArray(q)||q.jsonrpc!=='2.0')throw Error('invalid JSON-RPC message');
   const client=side==='client', target=client?serverInput:clientOutput;
   const outgoing=client?clientPending:serverPending, originals=client?clientOriginal:serverOriginal;
   const incoming=client?serverPending:clientPending, incomingOriginal=client?serverOriginal:clientOriginal;
   if(typeof q.method==='string'){
    if(!client && q.method==='notifications/tools/list_changed' && onToolsListChanged) onToolsListChanged({actor,connection});
    if(q.method==='notifications/cancelled'){
     const old=q.params?.requestId, mapped=originals.get(key(old));
     if(mapped){const entry=outgoing.get(key(mapped));originals.delete(key(old));outgoing.delete(key(mapped));if(client && entry?.method==='tools/list' && onToolsListEnd)onToolsListEnd({actor,connection,requestSequence:entry.requestSequence,cancelled:true});emit(target,{...q,params:{...q.params,requestId:mapped}})}
     return;
    }
    if(Object.hasOwn(q,'id')){
     if(!validId(q.id)||originals.has(key(q.id)))throw Error('invalid or duplicate request id');
     if(clientPending.size+serverPending.size+hostPending.size>=maxPending)throw Error('relay pending limit exceeded');
     const id=`relay:${++seq}`;const requestSequence=client&&q.method==='tools/list'?++toolsSequence:undefined;
     if(requestSequence!==undefined && onToolsListStart)onToolsListStart({actor,connection,requestSequence});
     outgoing.set(key(id),{id:q.id,method:q.method,requestSequence});originals.set(key(q.id),id);emit(target,{...q,id});
    }else emit(target,q);
    return;
   }
   if(!validId(q.id))throw Error('invalid response id');
   if(!client){const h=hostPending.get(key(q.id));if(h){hostPending.delete(key(q.id));cleanupEntry(h);if(q.error)h.reject(Object.assign(Error(q.error.message||'MCP error'),{rpcError:q.error}));else h.resolve(q.result);return}}
   const entry=incoming.get(key(q.id));if(!entry)return;
   incoming.delete(key(q.id));incomingOriginal.delete(key(entry.id));
   if(!client&&entry.method==='tools/list'&&onToolsList)try{onToolsList(structuredClone(q.result),{actor,connection,requestSequence:entry.requestSequence})}catch(e){close(e);return}
   emit(target,{...q,id:entry.id});
  }catch(e){close(e)}
 }
 function readLines(stream,side){
  let fragments=[],size=0;
  listen(stream,'data',chunk=>{try{const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);let start=0;for(let i=0;i<data.length;i++){if(data[i]!==10)continue;const part=data.subarray(start,i);size+=part.length;if(size>maxMessageBytes)throw Error('relay message too large');fragments.push(part);let line=Buffer.concat(fragments,size);fragments=[];size=0;if(line.length&&line[line.length-1]===13)line=line.subarray(0,-1);receive(side,line.toString('utf8'));if(closed)return;start=i+1}const rest=data.subarray(start);size+=rest.length;if(size>maxMessageBytes)throw Error('relay message too large');if(rest.length)fragments.push(rest)}catch(e){close(e)}});
 }
 readLines(clientInput,'client');readLines(serverOutput,'server');
 for(const s of [clientInput,clientOutput,serverInput,serverOutput])listen(s,'error',close);
 listen(clientInput,'end',()=>close(Error('client ended')));listen(serverOutput,'end',()=>close(Error('server ended')));
 for(const s of [clientInput,clientOutput,serverInput,serverOutput])listen(s,'close',()=>close(Error('transport closed')));
 for(const s of [clientOutput,serverInput]){listen(s,'drain',()=>flush(s));listen(s,'finish',()=>close(Error('transport finished')))}
 if(bindingSignal){if(bindingSignal.aborted)invalidate();else bindingSignal.addEventListener('abort',invalidate,{once:true})}
 function request(binding,method,params,{signal,timeoutMs=30000}={}){
  try{ensure();if(binding?.actor!==actor||binding?.connection!==connection)throw Error('relay binding mismatch');if(typeof method!=='string'||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw TypeError('invalid request');if(signal?.aborted)throw Error('request aborted');if(clientPending.size+serverPending.size+hostPending.size>=maxPending)throw Error('relay pending limit exceeded')}catch(e){return Promise.reject(e)}
  const id=`relay:${++seq}`;
  return new Promise((resolve,reject)=>{
   const entry={resolve,reject,signal};
   const cancel=reason=>{if(!hostPending.delete(key(id)))return;cleanupEntry(entry);emit(serverInput,{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason}});reject(Error(reason))};
   entry.abort=()=>cancel('request aborted');if(signal)signal.addEventListener('abort',entry.abort,{once:true});
   entry.timer=setTimeout(()=>cancel('request timed out'),timeoutMs);entry.timer.unref?.();hostPending.set(key(id),entry);
   try{write(serverInput,{jsonrpc:'2.0',id,method,params})}catch(e){if(hostPending.delete(key(id))){cleanupEntry(entry);reject(e)}}
  });
 }
 return {request,close,invalidate,get closed(){return closed}};
}
module.exports={createMcpStdioRelay};
