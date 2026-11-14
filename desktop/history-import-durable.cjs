'use strict';
// Cooperative, private-directory fixture store. All writers must use the same
// exclusion; neither this file nor its contents establish account ownership.
// Registration and source IDs share ONE atomic publication, not two files.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
function createHistoryImportDurableStore({directory}) {
 if(typeof directory!=='string'||!path.isAbsolute(directory)) throw new TypeError('Absolute private directory required');
 const lock=path.join(directory,'history-host.lock'), data=path.join(directory,'history-host-state.json');
 async function checkDir(){const s=await fs.lstat(directory);if(!s.isDirectory()||s.isSymbolicLink()||await fs.realpath(directory)!==path.resolve(directory)) throw Error('Private directory is not stable');}
 async function read(){let raw;try{raw=await fs.readFile(data,'utf8');}catch(e){if(e.code==='ENOENT')return {version:0,registrations:{},sourceIds:[]};throw e;}
  const x=JSON.parse(raw);if(!x||!Number.isSafeInteger(x.version)||x.version<0||!x.registrations||typeof x.registrations!=='object'||Array.isArray(x.registrations)||!Array.isArray(x.sourceIds)||!x.sourceIds.every(v=>typeof v==='string'&&v&&v!=='__proto__')||new Set(x.sourceIds).size!==x.sourceIds.length||Object.keys(x.registrations).length!==x.sourceIds.length||!x.sourceIds.every(id=>Object.hasOwn(x.registrations,id)&&x.registrations[id]?.sourceSessionId===id&&typeof x.registrations[id]?.sessionId==='string'))throw Error('Invalid durable import state');return x;}
 async function publish(x){const tmp=path.join(directory,`.history-host-${crypto.randomUUID()}.tmp`);let f,done=false;try{f=await fs.open(tmp,'wx',0o600);await f.writeFile(JSON.stringify(x));await f.sync();await f.close();f=null;await fs.rename(tmp,data);done=true;}finally{if(f)await f.close().catch(()=>{});if(!done)await fs.unlink(tmp).catch(()=>{});}}
 async function runExclusive(fn){if(typeof fn!=='function')throw new TypeError('Callback required');await checkDir();let f;try{f=await fs.open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')return {status:'busy'};throw e;}
  let active=true, tail=Promise.resolve();const schedule=fn=>{if(!active)throw Error('Lease expired');const result=tail.then(fn);tail=result.catch(()=>{});return result;};
  const lease={read:()=>schedule(read),commit:(record,isCurrent)=>schedule(async()=>{if(!record||typeof record.sourceSessionId!=='string'||!record.sourceSessionId||record.sourceSessionId==='__proto__'||typeof record.sessionId!=='string'||!record.sessionId||typeof isCurrent!=='function')throw new TypeError('Record and guard required');const x=await read();if(await isCurrent()!==true)return 'refused';if(Object.hasOwn(x.registrations,record.sourceSessionId)||x.sourceIds.includes(record.sourceSessionId))return 'refused';x.registrations[record.sourceSessionId]=record;x.sourceIds.push(record.sourceSessionId);x.version++;await publish(x);return 'registered';})};
  try{return await fn(lease);}finally{active=false;await tail;await f.close();await fs.unlink(lock);}}
 // The arbiter must exclude all lock users throughout this callback and prove
 // the specific lock owner is dead. Age/PID alone is insufficient evidence.
 async function recoverLock({withExclusiveAccess,isAbandoned}){if(typeof withExclusiveAccess!=='function'||typeof isAbandoned!=='function')throw new TypeError('External exclusion and abandonment proof required');return withExclusiveAccess(async()=>{await checkDir();let f;try{f=await fs.open(lock,'r');}catch(e){if(e.code==='ENOENT')return {status:'not-found'};throw e;}try{const a=await f.stat(),b=await fs.lstat(lock);const same=(x,y)=>x.dev===y.dev&&x.ino===y.ino&&x.size===y.size&&x.mtimeMs===y.mtimeMs&&x.nlink===y.nlink;if(!a.isFile()||!b.isFile()||b.isSymbolicLink()||a.nlink!==1||!same(a,b))throw Error('Unstable lock');if(await isAbandoned()!==true)return {status:'busy'};const c=await f.stat(),d=await fs.lstat(lock).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!d||d.isSymbolicLink()||!same(a,c)||!same(a,d))return {status:'changed'};await f.close();f=null;await fs.unlink(lock);return {status:'unlocked'};}finally{if(f)await f.close();}});}
 return {runExclusive,recoverLock};
}
module.exports={createHistoryImportDurableStore};
