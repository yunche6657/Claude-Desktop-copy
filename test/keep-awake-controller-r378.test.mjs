import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const { createCodeKeepAwakeController } = createRequire(import.meta.url)('../desktop/keep-awake-controller.cjs');
const source = readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
const start = source.indexOf('var CCr="confirm_"');
const end = source.indexOf('function XCr()', start);
assert.ok(start >= 0 && end > start);

function harness(original) {
  let time = 1, next = 0, battery = false, enabled = true, idle = 0, counts = { background_task: 0, loop: 0 }, losable = false;
  const queue = new Map(), actions = [], claims = new Set();
  const timers = {
    setTimeout(fn, delay) { const id = ++next; queue.set(id, { fn, due: time + delay }); return id; },
    clearTimeout(id) { queue.delete(id); },
    setInterval(fn, delay) { const id = ++next; queue.set(id, { fn, due: time + delay, interval: delay }); return id; },
    clearInterval(id) { queue.delete(id); },
  };
  const advance = ms => {
    const until = time + ms;
    for (;;) {
      const pending = [...queue].sort((a, b) => a[1].due - b[1].due)[0];
      if (!pending || pending[1].due > until) break;
      const [id, item] = pending; time = item.due;
      if (item.interval) item.due += item.interval; else queue.delete(id);
      item.fn();
    }
    time = until;
  };
  const session = new EventEmitter();
  Object.assign(session, { countRunningSessionsByActivity: () => counts, hasLosableBackgroundWork: () => losable,
    isViolinBow: id => id === 'violin', noteKeptAwake: (id, ms) => actions.push(['notice', id, ms]) });
  const preferences = new EventEmitter(); const prefs = { ccKeepAwakeWhileWorking: true, ccKeepAwakeOnBattery: true };
  preferences.get = key => prefs[key];
  const power = new EventEmitter(); power.isOnBatteryPower = () => battery;
  const claim = id => { if (!claims.has(id)) { claims.add(id); actions.push(['claim', id]); } };
  const release = id => { if (claims.delete(id)) actions.push(['release', id]); };
  const claimApi = { claim, release, isBlocking: () => claims.size > 0 };
  let controller;
  if (original) {
    const context = { a: { powerMonitor: power }, performance: { now: () => time }, id: () => idle,
      yv: preferences.get, bv: preferences, $B: () => enabled, ty: () => true,
      cV: claim, lV: release, yCr: claimApi.isBlocking, Q() {}, N: { info() {}, warn() {} }, ...timers };
    const create = vm.runInNewContext(source.slice(start, end) + ';YCr', context);
    controller = { refresh: null, dispose: create(session) };
  } else controller = createCodeKeepAwakeController({ sessions: session, preferences, powerMonitor: power, claims: claimApi,
    isEnabled: () => enabled, now: () => time, idleSeconds: () => idle, timers });
  return { actions, advance, event: (type, id, data) => session.emit('event', { type, sessionId: id, session: data }),
    completed: id => session.emit('queryCompleted', id),
    pref: (key, value) => { prefs[key] = value; preferences.emit(key, value); },
    battery: value => { battery = value; power.emit(value ? 'on-battery' : 'on-ac'); },
    enable: value => { enabled = value; preferences.emit('ccKeepAwakeWhileWorking'); },
    counts: value => { counts = value; }, losable: value => { losable = value; },
    idle: value => { idle = value; }, sleep: () => power.emit('suspend'), dispose: () => controller.dispose(),
    disposeBeforeNextEvent: () => session.prependOnceListener('event', () => controller.dispose()),
    remaining: () => ({claims:[...claims],timers:queue.size}) };
}

test('controller matches fixed original through manual, battery, grace, stall, progress and gate transitions', () => {
  const reference = harness(true), replica = harness(false);
  for (const h of [reference, replica]) {
    h.event('start', 'a', { isRunning: true, manualKeepAwake: true });
    h.event('start', 'violin', { isRunning: true, manualKeepAwake: true });
    h.pref('ccKeepAwakeOnBattery', false); h.battery(true); h.battery(false);
    h.event('message', 'a'); h.completed('a'); h.advance(30000);
    h.event('session_updated', 'a', { isRunning: false, manualKeepAwake: false });
    h.event('start', 'b', { turnRunning: true }); h.losable(true); h.advance(3600000);
    h.losable(false); h.advance(3600000); h.event('message', 'b');
    h.enable(false); h.enable(true); h.event('message', 'b'); h.event('deleted', 'b'); h.advance(30000);
    h.dispose();
  }
  assert.deepEqual(replica.actions, reference.actions);
  assert.ok(replica.actions.some(x => x[0] === 'claim' && x[1] === 'code_session:a'));
  assert.ok(replica.actions.some(x => x[0] === 'release' && x[1] === 'code_turn'));
});

test('controller matches fixed original for idle notices, sleep suppression, background grace and maximum duration', () => {
  const reference = harness(true), replica = harness(false);
  for (const h of [reference, replica]) {
    h.event('start', 'notice', { isRunning: true }); h.idle(900); h.advance(600000);
    h.completed('notice'); h.advance(30000);
    h.event('start', 'sleep', { isRunning: true }); h.advance(600000); h.sleep();
    h.completed('sleep'); h.advance(30000);
    h.counts({ background_task: 1, loop: 0 }); h.event('start', 'work', { isRunning: true });
    h.completed('work'); h.advance(7200000); h.advance(30000);
    h.counts({ background_task: 0, loop: 0 });
    h.event('start', 'max', { isRunning: true });
    for (let i = 0; i < 25; i++) { h.advance(3500000); h.event('message', 'max'); }
    h.advance(30000); h.event('deleted', 'max'); h.dispose();
  }
  assert.deepEqual(replica.actions, reference.actions);
  assert.equal(replica.actions.filter(x => x[0] === 'notice').length, 1);
});

// EventEmitter snapshots its listeners: removing the controller in an earlier
// listener does not prevent its already-dispatched listener from running.
test('repeated disposal matches native cleanup after a callback already in dispatch reacquires claims', () => {
  const reference=harness(true),replica=harness(false);
  for(const h of [reference,replica]){
    h.disposeBeforeNextEvent();
    h.event('start','late',{turnRunning:true,manualKeepAwake:true});
    assert.deepEqual(h.remaining().claims,['code_session:late','code_turn']);
    h.dispose();
  }
  assert.deepEqual(reference.remaining(),{claims:[],timers:0});
  assert.deepEqual(replica.remaining(),reference.remaining());
  assert.deepEqual(replica.actions,reference.actions);
});
