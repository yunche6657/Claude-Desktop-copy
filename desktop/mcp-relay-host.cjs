'use strict';

// Experimental composition only. The embedding host must supply an authoritative,
// revocable actor/session/connection/source binding and permission decision.
const {createMcpStdioRelay}=require('./mcp-stdio-relay.cjs');
const {filterCliMcpApps}=require('./cli-mcp-app-filter.cjs');

function createMcpRelayHost({isCurrent, authorize, onStatus=()=>{}}) {
 if(typeof isCurrent!=='function'||typeof authorize!=='function'||typeof onStatus!=='function') throw TypeError('host authority callbacks required');
 const sessions=new Map(), actors=new Map(), connections=new Map(), usedActors=new Set(), usedConnections=new Set();
 let disposed=false;
 const status=(entry,state,reason)=>{try{onStatus({session:entry.session,actor:entry.actor,connection:entry.connection,state,reason})}catch{}};
 const valid=e=>{try{return !disposed&&!e.closed&&sessions.get(e.session)===e&&actors.get(e.actor)===e&&connections.get(e.connection)===e&&isCurrent(e.binding)===true}catch{return false}};
 function close(e,reason=Error('relay host closed')) {
  if(e.closed)return;
  e.closed=true;e.uris.clear();e.apps=[];e.version++;
  sessions.delete(e.session);actors.delete(e.actor);connections.delete(e.connection);
  e.signal?.removeEventListener('abort',e.abort);
  e.relay?.close(reason);
  try{e.closeTransport(reason)}catch{}
  status(e,'closed',reason.message);
 }
 function ensure(e){if(!valid(e)){close(e,Error('stale relay host binding'));throw Error('stale relay host binding')}}
 function attach({session,actor,connection,source,signal,clientInput,clientOutput,serverInput,serverOutput,closeTransport,limits={}}) {
  if(disposed)throw Error('relay host disposed');
  if(!session||!actor||!connection||!source||typeof source.name!=='string'||typeof source.kind!=='string'||typeof source.conflicts!=='function'||(source.revision!==undefined&&!['string','number','bigint','boolean','symbol'].includes(typeof source.revision))||typeof closeTransport!=='function'||!signal||typeof signal.addEventListener!=='function')throw TypeError('complete binding, signal and transport cleanup required');
  if(signal.aborted)throw Error('binding already aborted');
  if(sessions.has(session)||usedActors.has(actor)||usedConnections.has(connection))throw Error('binding already attached or retired');
  const sourceSnapshot=Object.freeze({name:source.name,kind:source.kind,revision:source.revision,conflicts:source.conflicts});
  const binding=Object.freeze({session,actor,connection,source:sourceSnapshot});
  const e={session,actor,connection,binding,signal,closeTransport,closed:false,uris:new Set(),apps:[],version:0,latestList:undefined,listVersion:undefined,lists:new Set(),overlap:false};
  sessions.set(session,e);actors.set(actor,e);connections.set(connection,e);usedActors.add(actor);usedConnections.add(connection);
  e.abort=()=>close(e,Error('binding invalidated'));
  signal.addEventListener('abort',e.abort,{once:true});
  try {
   ensure(e);
   e.relay=createMcpStdioRelay({...limits,clientInput,clientOutput,serverInput,serverOutput,actor,connection,isCurrent:()=>valid(e),bindingSignal:signal,
    onToolsListStart({requestSequence}){
     ensure(e);e.uris.clear();e.apps=[];e.version++;e.latestList=requestSequence;e.listVersion=e.version;if(e.lists.size)e.overlap=true;e.lists.add(requestSequence);
    },
    onToolsListChanged(){ensure(e);e.uris.clear();e.apps=[];e.version++},
    onToolsListEnd({requestSequence}){ensure(e);e.lists.delete(requestSequence);if(!e.lists.size)e.overlap=false},
    onToolsList(result,{requestSequence}={}){
     ensure(e);
     // A response is usable only for the latest request, without an intervening
     // list_changed. Older relay implementations provide no sequence: fail closed.
     const overlapped=e.overlap;e.lists.delete(requestSequence);if(!e.lists.size)e.overlap=false;
     if(overlapped||!Number.isSafeInteger(requestSequence)||requestSequence!==e.latestList||e.listVersion!==e.version)return;
     // Source name and conflict state are supplied by the authority, not the client.
     const filtered=filterCliMcpApps([{name:sourceSnapshot.name,source:sourceSnapshot.kind,tools:result?.tools}],name=>sourceSnapshot.conflicts(name)!==false);
     const uris=new Set();
     for(const tool of filtered[0]?.tools||[]) {const uri=tool._meta.ui?.resourceUri??tool._meta['ui/resourceUri'];if(uri)uris.add(uri)}
     e.uris=uris;e.apps=filtered;e.version++;status(e,'ready');
    },
    onClose(reason){close(e,reason)} });
   if(e.closed||e.relay.closed)throw Error('relay closed during attach');
   status(e,'connected');
  } catch(error) {close(e,error);throw error}
  return Object.freeze({session,actor,connection});
 }
 function lookup(binding){const e=sessions.get(binding?.session);if(!e||binding.actor!==e.actor||binding.connection!==e.connection)throw Error('relay binding mismatch');ensure(e);return e}
 async function read(binding,uri,options={}) {
  const e=lookup(binding);
  if(typeof uri!=='string'||!e.uris.has(uri))throw Error('resource URI not declared');
  const version=e.version;
  if(await authorize(e.binding,uri)!==true)throw Error('resource access denied');
  ensure(e);if(version!==e.version||!e.uris.has(uri))throw Error('resource declaration changed');
  const result=await e.relay.request({actor:e.actor,connection:e.connection},'resources/read',{uri},options);
  ensure(e);if(version!==e.version||!e.uris.has(uri))throw Error('resource declaration changed');
  if(await authorize(e.binding,uri)!==true)throw Error('resource access denied');
  ensure(e);if(version!==e.version||!e.uris.has(uri))throw Error('resource declaration changed');
  if(options.signal?.aborted)throw Error('request aborted');
  if(!Array.isArray(result?.contents)||result.contents.some(x=>!x||x.uri!==uri))throw Error('invalid resource response');
  return result;
 }
 function invalidate(binding){const e=lookup(binding);close(e,Error('binding invalidated'))}
 function getStatus(binding){const e=lookup(binding);return {state:'connected',declaredUris:[...e.uris]}}
 function dispose(){if(disposed)return;for(const e of [...sessions.values()])close(e,Error('relay host disposed'));disposed=true}
 function getApps(binding){const e=lookup(binding);return structuredClone(e.apps)}
 return {attach,read,invalidate,getStatus,getApps,dispose};
}
module.exports={createMcpRelayHost};
