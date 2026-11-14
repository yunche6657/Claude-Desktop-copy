import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(import.meta.url),{prepareFork}=require('../desktop/session-fork.cjs'),{createSessionKernel}=require('../desktop/session-kernel.cjs');
test('fork publishes parent chain and resumes it before backend start',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-fork-'));let k;
 try{const original=path.join(dir,'source.jsonl');fs.writeFileSync(original,'');const rows=[{type:'user',uuid:'a',message:{role:'user',content:'school secret: NJAU'}},{type:'assistant',uuid:'b',message:{role:'assistant',content:[{type:'text',text:'remembered'}]}}];
 const fork=prepareFork({ccbResume:{homeDir:dir,cwd:dir,transcriptPath:original}},rows,dir);let received;
 k=createSessionKernel({emit(){},backend:{id:'ccb',sendMessage(){},cancel(){},onEvent(){return ()=>{}},dispose(){},start:opts=>{received=opts;const native=fs.readFileSync(opts.ccbResume.transcriptPath,'utf8').trim().split('\n').map(JSON.parse);assert.equal(native[0].message.content,'school secret: NJAU');assert.equal(native[1].parentUuid,'a');assert.ok(native.every(x=>x.sessionId===opts.cliSessionId));}}});
 const s=k.start({...fork,cwd:dir});assert.equal(received.resume,true);assert.equal(received.cliSessionId,fork.cliSessionId);assert.equal(k.getTranscript(s.sessionId).length,2);
 }finally{k?.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
test('compacted fork keeps summary and excludes pre-compaction display-only rows',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'compacted-fork-'));
 try{const source=path.join(dir,'source.jsonl');const old={type:'user',uuid:'old',message:{role:'user',content:'large obsolete tool result'}};
 const boundary={type:'system',subtype:'compact_boundary',uuid:'boundary'};
 const summary={type:'user',uuid:'summary',isCompactSummary:true,parentUuid:'boundary',message:{role:'user',content:'NJAU school summary'}};
 const last={type:'assistant',uuid:'last',parentUuid:'summary',message:{role:'assistant',content:[{type:'text',text:'prior answer'}]}};
 fs.writeFileSync(source,[old,boundary,summary,last].map(JSON.stringify).join('\n')+'\n');
 const added={type:'user',uuid:'added',message:{role:'user',content:'follow-up'}};
 const fork=prepareFork({ccbResume:{homeDir:dir,cwd:dir,transcriptPath:source}},[{...old,uuid:'display-only'},summary,last,added],dir);
 const rows=fs.readFileSync(fork.ccbResume.transcriptPath,'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.map(r=>r.uuid),['boundary','summary','last','added']);assert.equal(rows.at(-1).parentUuid,'last');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
