'use strict';

// The lock covers the actual backend promise, including after a caller times
// out. A replacement actor has its own control lane.
function createMcpControlGate({isCurrent}) {
  if (typeof isCurrent !== 'function') throw new TypeError('isCurrent required');
  const active=new Map();
  async function run(sessionId,actorToken,serverName,work) {
    if (![sessionId,actorToken,serverName].every(x=>typeof x==='string'&&x) || typeof work!=='function') throw new TypeError('MCP control identity required');
    if (isCurrent(sessionId,actorToken)!==true) throw Error('Session not running');
    const key=JSON.stringify([sessionId,actorToken,serverName]);
    if (active.has(key)) {
      const uncertain=active.get(key).uncertain;
      const error=Error(uncertain ? 'MCP control state unknown; restart the session' : 'MCP control in progress');
      error.code=uncertain ? 'MCP_CONTROL_UNCERTAIN' : 'MCP_CONTROL_BUSY';
      throw error;
    }
    const marker={};active.set(key,marker);
    try {
      if (isCurrent(sessionId,actorToken)!==true) throw Error('Session not running');
      const result=await work();
      if (isCurrent(sessionId,actorToken)!==true) throw Error('Session not running');
      return result;
    } catch (error) {
      // The CCB control timer only stops waiting; the child may still execute
      // the request. Do not issue another control on this actor/server lane.
      if (error?.code === 'CCB_CONTROL_TIMEOUT') marker.uncertain=true;
      throw error;
    } finally { if (!marker.uncertain && active.get(key)===marker) active.delete(key); }
  }
  function retireSession(id) { for (const key of active.keys()) if (JSON.parse(key)[0]===id) active.delete(key); }
  return Object.freeze({run,retireSession});
}
module.exports={createMcpControlGate};
