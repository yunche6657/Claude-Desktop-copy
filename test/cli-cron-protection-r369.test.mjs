import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { createCronLedger, isExpired, MAX_AGE_MS, MANAGER_GRACE_MS } = createRequire(import.meta.url)('../desktop/cli-cron-protection.cjs');

test('expiry boundaries match extracted native functions with manager suspend and wake context', () => {
 const path = 'C:/Users/Administrator/Desktop/注册号 逆向/ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js';
 const source = readFileSync(path, 'utf8');
 const start = source.indexOf('var OEi={graceMs:12e4},kEi=2592e5;function AEi(');
 const end = source.indexOf('var MEi="subagent:"', start);
 assert.ok(start >= 0 && end > start);
 const native = vm.runInNewContext(`${source.slice(start,end)};({AEi,jEi,kEi})`);
 const createdAt = 1_000_000_000, nextRunAt = createdAt + 5000;
 const jobs = [{createdAt}, {createdAt, recurring:true, nextRunAt}, {createdAt, recurring:false, nextRunAt}, {createdAt, recurring:false, nextRunAt:createdAt + MAX_AGE_MS + 1}, {createdAt, durable:true}];
 const times = [nextRunAt, nextRunAt + MANAGER_GRACE_MS - 1, nextRunAt + MANAGER_GRACE_MS, createdAt + MAX_AGE_MS, createdAt + MAX_AGE_MS + 1];
 for (const job of jobs) for (const now of times) for (const context of [{}, {lastSystemWakeAt:nextRunAt+10000}, {lastSuspendedAt:now-1000}]) {
   const suspended = context.lastSuspendedAt != null && now-context.lastSuspendedAt<MAX_AGE_MS && native.AEi(job);
   const expected = suspended ? false : native.jEi(job, now, native.kEi, {graceMs:MANAGER_GRACE_MS, from:context.lastSystemWakeAt});
   assert.equal(isExpired(job,now,context), expected, JSON.stringify({job,now,context}));
 }
});

test('ledger prunes as native does, retains no prompt and accepts explicit next run', () => {
 const ledger = createCronLedger();
 ledger.set('one', {createdAt:100, recurring:false, cron:'* * * * *', prompt:'secret'});
 assert.equal(ledger.hasLive(100 + MAX_AGE_MS), true);
 assert.equal('prompt' in ledger.snapshot()[0], false);
 assert.equal(ledger.setNextRunAt('one', 200), true);
 assert.equal(ledger.hasLive(200 + MANAGER_GRACE_MS - 1), true);
 assert.deepEqual(ledger.prune(200 + MANAGER_GRACE_MS), ['one']);
 assert.equal(ledger.hasLive(), false);
 ledger.set('recurring', {createdAt:100, recurring:true, durable:true});
 assert.equal(ledger.hasLive(100 + MAX_AGE_MS), true);
 assert.equal(ledger.hasLive(101 + MAX_AGE_MS), false);
});
