import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWarmIdleLifecycle } = require('../desktop/warm-idle-lifecycle.cjs');
function clock() {
  let time = 1000, next = 1; const timers = new Map();
  return { now: () => time, set: (fn, ms) => { const id = next++; timers.set(id, { fn, at: time + ms }); return id; },
    clear: id => timers.delete(id), async advance(ms) {
      const end = time + ms;
      for (;;) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > end) break;
        timers.delete(entry[0]); time = entry[1].at; await entry[1].fn();
      }
      time = end;
    }, count: () => timers.size };
}
const reference = path.resolve('../ccd-ref/asar/.vite/build/index.chunk-M6SkuaH9.js');
function original(c, config) {
  const src = fs.readFileSync(reference, 'utf8');
  const start = src.indexOf('function qC(e){');
  const end = src.indexOf(',ew=new f.t("transcript-read")', start);
  assert.ok(start >= 0 && end > start, 'original lifecycle boundaries');
  const sandbox = { t: { L5: { info() {}, debug() {}, error() {} } },
    Date: { now: c.now }, performance: { now: c.now }, setTimeout: c.set, clearTimeout: c.clear };
  const Lifecycle = vm.runInNewContext(src.slice(start, end) + '; $C', sandbox);
  return new Lifecycle(config);
}
function build(c, ctx, isOriginal = false) {
  const opts = { isQueryActive: () => ctx.active, onDisconnect: async () => {
    ctx.disconnects++; if (!ctx.decline) ctx.active = false;
  }, getTimeoutMs: () => ctx.timeout, now: c.now, setTimer: c.set, clearTimer: c.clear };
  if (!isOriginal) return createWarmIdleLifecycle(opts);
  // Invoke the captured class constructor with the real config shape.
  return original(c, { idleTimeoutMs: opts.getTimeoutMs, timeoutOnHidden: true,
    hasActiveQuery: opts.isQueryActive, onDisconnect: opts.onDisconnect });
}
const keys = ['isTabVisible', 'visibilityKnown', 'hasPendingResult', 'lastMessageSentTime',
  'lastResultTime', 'lastHiddenTime', 'idleArmedAt', 'idleArmedTimeoutMs',
  'idleUnarmedSince', 'consecutiveDeclinedPauses'];
function comparable(api) {
  const s = api.getState('a');
  return Object.fromEntries(keys.map(k => [k, s[k]]).concat([
    ['armed', s.idleArmed ?? (s.idleTimeoutId != null)],
    ['recheck', s.idleRecheckPending ?? (s.idleRecheckId != null)],
  ]));
}
test('idle state transitions match extracted original lifecycle', { skip: !fs.existsSync(reference) }, async () => {
  const c1 = clock(), c2 = clock();
  const x1 = { active: true, timeout: 0, decline: true, disconnects: 0 };
  const x2 = { ...x1 };
  const a = build(c1, x1), b = build(c2, x2, true);
  const compare = () => { assert.deepEqual(comparable(a), comparable(b)); assert.equal(c1.count(), c2.count()); };
  a.register('a'); b.registerSession('a'); compare();
  a.onQueryInstalled('a'); b.onQueryInstalled('a'); compare();
  await c1.advance(900000); await c2.advance(900000); compare();
  x1.timeout = x2.timeout = 25;
  await c1.advance(900000); await c2.advance(900000); compare();
  await c1.advance(25); await c2.advance(25); compare(); assert.equal(x1.disconnects, 1);
  a.onVisibilityChange('a', false); b.onVisibilityChange('a', false); compare();
  a.onVisibilityChange('a', true); b.onVisibilityChange('a', true); compare();
  a.onTurnComplete('a'); b.onTurnComplete('a'); compare();
  a.onVisibilityChange('a', false); b.onVisibilityChange('a', false); compare();
  a.onMessageSent('a'); b.onMessageSent('a'); compare();
  a.markDisconnected('a'); b.markDisconnected('a'); compare();
  a.unregister('a'); b.unregisterSession('a'); assert.equal(c1.count(), 0); assert.equal(c2.count(), 0);
});

test('recheck reads live config and cancellation prevents stale work', async () => {
  const c = clock(), x = { active: true, timeout: 0, decline: false, disconnects: 0 };
  const changes = []; const api = createWarmIdleLifecycle({ isQueryActive: () => x.active,
    onDisconnect: async () => { x.disconnects++; x.active = false; }, getTimeoutMs: () => x.timeout,
    now: c.now, setTimer: c.set, clearTimer: c.clear, onState: (id, s) => changes.push([id, s]) });
  api.register('a'); api.onQueryInstalled('a');
  assert.equal(api.getState('a').idleUnarmedSince, 1000);
  x.timeout = 17; await c.advance(900000);
  assert.equal(api.getState('a').idleArmedTimeoutMs, 17); // no generic 60 s clamp
  api.onMessageSent('a'); await c.advance(100); assert.equal(x.disconnects, 0);
  api.onVisibilityChange('a', false); await c.advance(17);
  assert.equal(x.disconnects, 1); assert.equal(api.getState('a').hasPendingResult, false);
  api.destroy(); assert.equal(c.count(), 0); assert.equal(changes.at(-1)[1], null);
});



test('late disconnect completion cannot schedule idle work for a replacement registration',async()=>{
 const c=clock();let resolve,started=false;
 const lifecycle=createWarmIdleLifecycle({isQueryActive:()=>true,onDisconnect:()=>{started=true;return new Promise(r=>resolve=r);},getTimeoutMs:()=>10,now:c.now,setTimer:c.set,clearTimer:c.clear});
 lifecycle.register('a');lifecycle.onQueryInstalled('a');const completion=c.advance(10);assert.equal(started,true);
 lifecycle.unregister('a');lifecycle.register('a');resolve();await completion;
 assert.equal(lifecycle.getState('a').idleArmed,false);assert.equal(lifecycle.getState('a').consecutiveDeclinedPauses,0);assert.equal(c.count(),0);lifecycle.destroy();
});
