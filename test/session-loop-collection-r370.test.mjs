import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProtectionState } = require('../desktop/cli-protection-state.cjs');
const { isExpired, MAX_AGE_MS, MANAGER_GRACE_MS } = require('../desktop/cli-cron-protection.cjs');
const source = fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
const manager = fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js', import.meta.url), 'utf8');
const parser = source.slice(source.indexOf('function Y2('), source.indexOf('function Sra('));
const next = source.slice(source.indexOf('function kra('), source.indexOf('function Ara('));
const method = manager.slice(manager.indexOf('collectSessionLoops(e){'), manager.indexOf('recordUnconfirmedByProcess(e){'));
const eviction = manager.slice(manager.indexOf('evictExpiredCronJobs(e,t){'), manager.indexOf('heldInputView(e){'));
assert.ok(parser.startsWith('function Y2(') && parser.includes('function xra('));
assert.ok(next.startsWith('function kra(') && method.startsWith('collectSessionLoops(e){') && eviction.startsWith('evictExpiredCronJobs(e,t){'));

function native(now, jobs) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = { Date: FixedDate, isGone: (job, time) => isExpired(job, time) };
  const create = vm.runInNewContext(`${parser}\n${next}\nconst t={Yc:xra,qc:kra}; class Reference { constructor(){this.deps={isCronJobGone:isGone}} ${eviction} ${method} }; new Reference()`, context);
  const session = { activeCronJobs: jobs };
  return () => create.collectSessionLoops(session);
}
const use = (id, input) => ({ type: 'assistant', message: { content: [{type: 'tool_use', name: 'CronCreate', id, input}] } });
const result = (id, value, error = false) => ({ type: 'user', message: { content: [{type: 'tool_result', tool_use_id: id, is_error: error}] }, tool_use_result: value });
function setup(start) {
  let time = start;
  const state = createProtectionState({now: () => time});
  state.beginEpoch('actor');
  return {state, get time() {return time;}, set time(value) {time = value;},
    add(id, input, output) { state.observeFrame('actor', use(id, input)); state.observeFrame('actor', result(id, output)); }};
}
function plain(rows) { return rows === undefined ? undefined : Array.from(rows, row => ({...row})); }

test('confirmation yields the original UI fields and shares expiry with protection', () => {
  const start = Date.parse('2026-10-28T08:12:23.456Z');
  const f = setup(start), s = f.state;
  assert.equal(s.collectSessionLoops('actor'), undefined);
  s.observeFrame('actor', use('c', {cron: '* * * * *', prompt: 'do task', durable: true}));
  assert.deepEqual(s.collectSessionLoops('actor'), []);
  s.observeFrame('actor', result('c', {id: 'job', humanSchedule: 'Every minute', recurring: false}));
  const refJobs = new Map([['job', {createdAt: start, cron: '* * * * *', prompt: 'do task', humanSchedule: 'Every minute', durable: true, recurring: false}]]);
  const ref = native(start, refJobs);
  const initial = s.collectSessionLoops('actor');
  assert.deepEqual(initial, plain(ref()));
  assert.equal(initial[0].nextRunAt, start - start % 60000);
  initial[0].prompt = 'changed outside';
  initial[0].nextRunAt = 0;
  assert.deepEqual(s.collectSessionLoops('actor'), plain(ref()));
  assert.equal(s.snapshot('actor').flags.cron, true);
  f.time = start - start % 60000 + MANAGER_GRACE_MS - 1;
  assert.equal(s.collectSessionLoops('actor')[0].nextRunAt, start - start % 60000);
  assert.equal(s.snapshot('actor').flags.cron, true);
  f.time++;
  assert.deepEqual(s.collectSessionLoops('actor'), []);
  assert.equal(s.snapshot('actor').flags.cron, false);
  assert.equal(s.collectSessionLoops('stale'), undefined);
});

test('native method and state agree on recurring rollovers, missing and invalid expressions', () => {
  const start = Date.parse('2026-10-28T08:12:23.456Z');
  const f = setup(start);
  const entries = [
    ['rec', {cron: '* * * * *', prompt: 'repeat'}, {id: 'rec', recurring: true, humanSchedule: 'Every minute'}],
    ['one', {cron: '* * * * *'}, {id: 'one', recurring: false}],
    ['missing', {prompt: 'missing'}, {id: 'missing'}],
    ['bad', {cron: 'bad cron'}, {id: 'bad', recurring: true}],
    ['range', {cron: '*/15 * * * *'}, {id: 'range'}],
  ];
  const jobs = new Map();
  for (const [id, input, output] of entries) {
    f.add(id, input, output);
    jobs.set(id, {createdAt: start, ...input, humanSchedule: output.humanSchedule, recurring: output.recurring});
  }
  for (const time of [start, start + 37000, start + 97000, start + 8 * 60000]) {
    f.time = time;
    const ref = native(time, jobs);
    assert.deepEqual(f.state.collectSessionLoops('actor'), plain(ref()), new Date(time).toISOString());
  }
  assert.equal(jobs.get('one').nextRunAt, start - start % 60000);
  assert.equal(jobs.get('bad').nextRunAt, undefined);
  assert.equal(jobs.get('missing').nextRunAt, undefined);
});

test('eviction precedes next-run calculation and failed creation never enters collection', () => {
  const start = Date.parse('2026-10-28T08:12:23.456Z');
  const f = setup(start);
  f.add('expired', {cron:'* * * * *'}, {id:'expired', recurring:false});
  f.state.observeFrame('actor', use('failed', {cron:'* * * * *'}));
  f.state.observeFrame('actor', result('failed', {id:'failed'}, true));
  for (const [id, error] of [['failed-string', 'error'], ['failed-number', 1]]) {
    f.state.observeFrame('actor', use(id, {cron:'* * * * *'}));
    f.state.observeFrame('actor', result(id, {id}, error));
  }
  assert.deepEqual(f.state.collectSessionLoops('actor').map(job => job.id), ['expired']);
  f.time = start + MAX_AGE_MS + 1;
  const jobs = new Map([['expired', {createdAt:start, cron:'* * * * *', recurring:false}]]);
  assert.deepEqual(f.state.collectSessionLoops('actor'), plain(native(f.time, jobs)()));
  assert.deepEqual(f.state.collectSessionLoops('actor'), []);
  assert.equal(f.state.snapshot('actor').flags.cron, false);
});
