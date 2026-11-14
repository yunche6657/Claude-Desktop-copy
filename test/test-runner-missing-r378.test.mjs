import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

test('missing explicit test path fails the whole requested run before executing other tests',()=>{
 const run=spawnSync(process.execPath,[path.resolve('tools/run-tests.cjs'),'test/__nonexistent_r378__.test.mjs','test/notification-fidelity-r378.test.mjs'],{cwd:process.cwd(),encoding:'utf8',windowsHide:true});
 assert.equal(run.status,1);
 assert.match(run.stderr,/Requested test path not found/);
 assert.doesNotMatch(run.stdout,/fixed upstream and service match/);
});
