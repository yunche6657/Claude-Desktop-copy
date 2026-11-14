'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
function prepareFork(source,entries,cwd){
 const saved=source.ccbResume;
 if(!saved?.homeDir||!saved?.transcriptPath||!fs.existsSync(saved.transcriptPath))throw new Error('Fork requires a verified native source transcript');
 if(path.resolve(cwd)!==path.resolve(saved.cwd))throw new Error('Fork into a different working directory is not supported yet');
 const cliSessionId=crypto.randomUUID(),target=path.join(path.dirname(saved.transcriptPath),cliSessionId+'.jsonl');
 const native=fs.readFileSync(saved.transcriptPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const anchor=entries.at(-1)?.uuid;
 const end=native.findLastIndex(row=>row.uuid===anchor);
 const prefix=end>=0?native.slice(0,end+1):native;
 const boundary=prefix.findLastIndex(row=>row.type==='system'&&row.subtype==='compact_boundary');
 const retained=boundary>=0?prefix.slice(boundary):prefix;
 const allowed=new Set(entries.map(row=>row.uuid));
 const rows=retained.filter(row=>row.uuid&&(allowed.has(row.uuid)||row.subtype==='compact_boundary'||row.isCompactSummary)).map(row=>({...row,sessionId:cliSessionId,cwd}));
 const seen=new Set(rows.map(row=>row.uuid));
 let parent=rows.at(-1)?.uuid||null;
 const nativeIds=new Set(native.map(row=>row.uuid));
 const lastShared=entries.findLastIndex(row=>seen.has(row.uuid));
 for(const entry of entries.slice(lastShared+1)){
  if(seen.has(entry.uuid)||(boundary>=0&&nativeIds.has(entry.uuid)))continue;
  if(!['user','assistant'].includes(entry?.type)||!entry.message||!entry.uuid)continue;
  const row={...entry,sessionId:cliSessionId,cwd,parentUuid:parent,isSidechain:false};
  delete row.receivedStreamAt;rows.push(row);parent=row.uuid;
 }
 if(!rows.length)throw new Error('Fork source transcript has no conversation messages');
 const temp=target+'.tmp';fs.writeFileSync(temp,rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{flag:'wx'});
 try{fs.linkSync(temp,target);}finally{fs.unlinkSync(temp);}
 return {cliSessionId,ccbResume:{...saved,cliSessionId,cwd,transcriptPath:target},initialTranscript:entries};
}
module.exports={prepareFork};
