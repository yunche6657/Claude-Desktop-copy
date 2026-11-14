import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
const {createMcpStdioRelay}=createRequire(import.meta.url)('../desktop/mcp-stdio-relay.cjs');
test('list lifecycle notifications preserve request order and precede forwarding',()=>{
 const ci=new PassThrough(),co=new PassThrough(),si=new PassThrough(),so=new PassThrough(),trace=[],requests=[];
 si.on('data',d=>{const q=JSON.parse(String(d));requests.push(q);trace.push(q.method||'up-response')});
 co.on('data',d=>trace.push(JSON.parse(String(d)).method||'down-response'));
 const relay=createMcpStdioRelay({clientInput:ci,clientOutput:co,serverInput:si,serverOutput:so,actor:{},connection:{},isCurrent:()=>true,
  onToolsListStart:m=>trace.push(`start:${m.requestSequence}`),onToolsList:(_r,m)=>trace.push(`end:${m.requestSequence}`),
  onToolsListChanged:()=>trace.push('changed'),onToolsListEnd:m=>trace.push(`cancel:${m.requestSequence}`)});
 const send=(s,q)=>s.write(JSON.stringify(q)+'\n');
 send(ci,{jsonrpc:'2.0',id:1,method:'tools/list'});send(ci,{jsonrpc:'2.0',id:2,method:'tools/list'});
 send(so,{jsonrpc:'2.0',id:requests[1].id,result:{tools:[]}});send(so,{jsonrpc:'2.0',method:'notifications/tools/list_changed'});
 send(ci,{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}});
 assert.deepEqual(trace,['start:1','tools/list','start:2','tools/list','end:2','down-response','changed','notifications/tools/list_changed','cancel:1','notifications/cancelled']);
 relay.close();
});
