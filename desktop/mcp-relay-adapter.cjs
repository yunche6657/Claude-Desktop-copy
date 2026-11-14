'use strict';

// Experimental integration seam. inject receives a secret and must provide a
// genuinely private per-server channel; ordinary CCB config is not one.
const {createMcpRelayRuntime}=require('./mcp-relay-runtime.cjs');

function createMcpRelayAdapter({inject,isCurrent,authorize,onStatus,bootstrapTimeoutMs}) {
 if(typeof inject!=='function')throw TypeError('private injector required');
 const runtime=createMcpRelayRuntime({isCurrent,authorize,onStatus,bootstrapTimeoutMs});
 const bindings=new Map();let disposed=false;
 async function register(options) {
  if(disposed)throw Error('adapter disposed');
  const registration=await runtime.register(options);
  const handle=registration.handle;
  bindings.set(handle,{actor:options.actor,server:options.server});
  try {
   await inject({actor:options.actor,server:options.server,launch:registration.launch,bootstrapEnv:registration.bootstrapEnv});
   if(disposed||!bindings.has(handle)||options.signal.aborted)throw Error('binding invalidated');
   return handle;
  } catch {
   bindings.delete(handle);runtime.invalidate(handle);throw Error('relay injection failed');
  }
 }
 function check(handle,actor,server) {
  const binding=bindings.get(handle);
  if(!binding||binding.actor!==actor||binding.server!==server)throw Error('relay binding mismatch');
 }
 return {
  register,
  apps(handle,actor,server){check(handle,actor,server);return runtime.apps(handle)},
  read(handle,actor,server,uri,options){check(handle,actor,server);return runtime.read(handle,uri,options)},
  invalidate(handle){bindings.delete(handle);runtime.invalidate(handle)},
  dispose(){disposed=true;bindings.clear();runtime.dispose()}
 };
}
module.exports={createMcpRelayAdapter};
