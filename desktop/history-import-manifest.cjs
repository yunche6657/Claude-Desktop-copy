'use strict';
// Source ID snapshots are provided by the host's account-scoped manifest reader.
// This module does not choose or open an account directory.
const { snapshotProblem } = require('./snapshot-shape.cjs');
async function readSourceManifestSnapshot(provider) {
  if (!provider) return null;
  const snapshot=await provider();
  // The four version conditions used to be spelled out here AND in history-import-transaction.cjs, character for
  // character. They are the gate on whether a resumed import may proceed, so a change to one copy and not the other
  // would let an import through on one path and not the other. R555 moved them to desktop/snapshot-shape.cjs and
  // verified the extraction agrees with the original on fifteen inputs including '0', 1.5, NaN and Infinity.
  //
  // The `isCurrent()` call stays INSIDE this guard on purpose: a stale snapshot is reported as "unavailable", the same
  // fact as a malformed one. The transaction path reports it separately as "changed", which is a different claim.
  if (snapshotProblem(snapshot, 'sourceSessionIds') || await snapshot.isCurrent()!==true)
    throw Error('Complete source manifest snapshot unavailable');
  return {version:snapshot.version,isCurrent:()=>snapshot.isCurrent(),ids:new Set([...snapshot.sourceSessionIds].filter(x=>typeof x==='string').map(x=>x.toLowerCase()))};
}
// readSnapshot must bind its version and isCurrent to a trusted, account-scoped
// file reader; absent must mean authoritatively absent, not unreadable.
function createNativeSourceManifestProvider({readSnapshot}) {
  if (typeof readSnapshot!=='function') throw new TypeError('Manifest snapshot reader required');
  return async()=>{
    const source=await readSnapshot();
    if (!source || source.complete!==true || !['ok','absent'].includes(source.state) || typeof source.isCurrent!=='function') throw Error('Source manifest unreadable');
    let sourceSessionIds=new Set();
    if (source.state==='ok') {
      if (typeof source.content!=='string' || Buffer.byteLength(source.content,'utf8')>64*1024*1024) throw Error('Source manifest invalid');
      let data; try {data=JSON.parse(source.content);} catch {throw Error('Source manifest invalid');}
      if (!data || typeof data!=='object' || Array.isArray(data) || (data.localSessions!==undefined && !Array.isArray(data.localSessions))) throw Error('Source manifest invalid');
      sourceSessionIds=new Set((data.localSessions ?? []).filter(value=>typeof value==='string'));
    }
    return {complete:true,version:source.version,isCurrent:source.isCurrent,sourceSessionIds};
  };
}
module.exports={readSourceManifestSnapshot,createNativeSourceManifestProvider};
