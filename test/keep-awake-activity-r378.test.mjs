import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const { activityKind, countKeepAwakeActivity, manualKeepAwakeValue, isWaitingOnUser, isUnattended } = createRequire(import.meta.url)('../desktop/keep-awake-activity.cjs');
const source = readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js', import.meta.url), 'utf8');
const start = source.indexOf('sessionActivityKind(e,n,r){');
const end = source.indexOf('losableWorkKind(e,t){', start);
assert.ok(start >= 0 && end > start);
const NativeActivity = vm.runInNewContext(`(class { ${source.slice(start, end)} })`, {
  q: { f: value => value }, t: { wT: session => session.violinBow },
  fO: () => false, Gv: session => session.losableBackground, lA: () => false,
});

const keys = ['remoteClient', 'violinBow', 'hasQuery', 'lanyardConnected', 'turnRunning',
  'unattended', 'waitingOnUser', 'hasHeldInput', 'heldInputSurvives', 'losableBackground', 'liveCron', 'liveLoop'];
test('activity classification matches fixed original for all boolean source combinations', () => {
  for (let mask = 0; mask < 2 ** keys.length; mask++) {
    const facts = Object.fromEntries(keys.map((key, index) => [key, Boolean(mask & (1 << index))]));
    const native = new NativeActivity();
    native.deps = { sessionViewRecordHasHeldInput: () => facts.hasHeldInput,
      hasLiveCronJobs: () => facts.liveCron, hasLiveLoopWakeup: () => facts.liveLoop };
    native.isUnattendedSession = () => facts.unattended;
    native.isSessionWaitingOnUser = () => facts.waitingOnUser;
    const session = { remoteControlSpawn: facts.remoteClient, query: facts.hasQuery ? {} : null,
      violinBow: facts.violinBow, lanyard: { state: facts.lanyardConnected ? 'connected' : 'disconnected' },
      isRunning: facts.turnRunning, losableBackground: facts.losableBackground };
    assert.equal(activityKind(facts), native.sessionActivityKind(session, 0, { heldInputSurvives: () => facts.heldInputSurvives }), `mask ${mask}`);
  }
});

test('counts one highest-priority activity per held session and rejects incomplete facts', () => {
  const base = Object.fromEntries(keys.map(key => [key, false]));
  const counts = countKeepAwakeActivity([
    { ...base, turnRunning: true, losableBackground: true, liveCron: true },
    { ...base, losableBackground: true, liveLoop: true },
    { ...base, liveCron: true },
    { ...base, remoteClient: true, hasQuery: true, losableBackground: true },
  ]);
  assert.deepEqual(counts, { background_task: 1, loop: 1 });
  assert.throws(() => activityKind({ ...base, liveLoop: undefined }), /complete boolean/);
  assert.throws(() => countKeepAwakeActivity(null), /authoritative held/);
});

test('manual value follows the fixed original and is absent for ineligible sessions', () => {
  const start = source.indexOf('setManualKeepAwake(e,n){');
  const end = source.indexOf('setAutoArchiveHold(e,t){', start);
  assert.ok(start >= 0 && end > start);
  const Native = vm.runInNewContext(`(class { ${source.slice(start, end)} })`, {
    t: { wT: s => s.violinBow, L5: { warn() {}, info() {} } },
  });
  for (let mask = 0; mask < 16; mask++) {
    const facts = { requested: !!(mask & 1), archived: !!(mask & 2), prewarmHidden: !!(mask & 4), violinBow: !!(mask & 8) };
    const session = { isArchived: facts.archived, prewarmHidden: facts.prewarmHidden, violinBow: facts.violinBow };
    const native = new Native(); native.sessions = new Map([['s', session]]); native.emitSessionUpdated = () => {};
    native.setManualKeepAwake('s', facts.requested);
    assert.equal(manualKeepAwakeValue(facts), session.manualKeepAwake);
  }
  assert.throws(() => manualKeepAwakeValue({ requested: true }), /complete boolean/);
});

test('waiting and attendance facts follow the original permission and background precedence', () => {
  const start = source.indexOf('isUnattendedSession(e){');
  const end = source.indexOf('isSessionActive(e,t){', start);
  assert.ok(start >= 0 && end > start);
  const Native = vm.runInNewContext(`(class { ${source.slice(start, end)} })`, {
    t: { wT: s => s.violinBow }, oE: s => s.pendingInput, Gv: s => s.losableBackground,
    Hv: s => s.workflow, qB: s => ({ status_category: s.statusCategory }),
  });
  for (let mask = 0; mask < 64; mask++) {
    const f = { settledMainPermission: !!(mask&1), deferredSends: !!(mask&2), pendingInput: !!(mask&4),
      losableBackground: !!(mask&8), turnRunning: !!(mask&16), workflow: !!(mask&32) };
    for (const statusCategory of [undefined, 'blocked', 'need_input', 'failed', 'done']) {
      const s = { sessionId: 'fixture', deferredSends: f.deferredSends ? [{}] : [], pendingInput: f.pendingInput,
        losableBackground: f.losableBackground, isRunning: f.turnRunning, workflow: f.workflow, statusCategory };
      const native = new Native(); native.deps = { permissionBrokerHasOnlyMainTurnPendingFor: (_id, opts) => {
        assert.equal(opts.settledForMs, 10000); return f.settledMainPermission; } };
      assert.equal(isWaitingOnUser({ ...f, statusCategory }), native.isSessionWaitingOnUser(s, 42));
    }
    const attendance = { scheduledTask: !!(mask&1), dispatchParent: !!(mask&2), dispatchOrigin: !!(mask&4),
      remoteControl: !!(mask&8), bridgeSession: !!(mask&16), violinBow: !!(mask&32) };
    const s = { scheduledTaskId: attendance.scheduledTask, dispatchParentId: attendance.dispatchParent,
      dispatchParentOrigin: attendance.dispatchOrigin, remoteControlEnabled: attendance.remoteControl,
      bridgeSessionId: attendance.bridgeSession, violinBow: attendance.violinBow };
    assert.equal(isUnattended(attendance), new Native().isUnattendedSession(s));
  }
  assert.throws(() => isWaitingOnUser({}), /complete waiting/);
  assert.throws(() => isUnattended({}), /complete attendance/);
});
