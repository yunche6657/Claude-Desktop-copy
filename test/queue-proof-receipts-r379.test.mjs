import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {verifyFinalModelReceipts}=createRequire(import.meta.url)('../tools/proof-hidden-history-import-confirm.cjs');
const fixture=()=>['PRIOR_USER','FOLLOWUP','QUEUED_C','QUEUED_A','AFTER_ADMISSION'].map(lastUserMarker=>({lastUserMarker,cancelled:false,preDispatchCancelled:false,disposedInput:false}));

test('parent verdict rejects a late cancelled request after an earlier successful child snapshot',()=>{
 const original=fixture(),report={ok:true,requests:structuredClone(original)};
 assert.deepEqual(verifyFinalModelReceipts(original,report),original.map(row=>row.lastUserMarker));
 original.push({lastUserMarker:'CANCELLED',cancelled:true,preDispatchCancelled:false});
 assert.throws(()=>verifyFinalModelReceipts(original,report),/model receipts changed/);
});

test('matching snapshots cannot conceal cancelled input or the wrong send order',()=>{
 const leaked=fixture();leaked[4].preDispatchCancelled=true;
 assert.throws(()=>verifyFinalModelReceipts(leaked,{ok:true,requests:structuredClone(leaked)}),/cancelled input/);
 const reordered=fixture();[reordered[2],reordered[3]]=[reordered[3],reordered[2]];
 assert.throws(()=>verifyFinalModelReceipts(reordered,{ok:true,requests:structuredClone(reordered)}));
 const unknown=fixture();delete unknown[4].cancelled;
 assert.throws(()=>verifyFinalModelReceipts(unknown,{ok:true,requests:structuredClone(unknown)}),/classification is missing/);
});
