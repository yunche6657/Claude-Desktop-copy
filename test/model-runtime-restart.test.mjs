import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createModelRuntimeRestart, modelRuntimeBusy } = require('../desktop/model-runtime-restart.cjs');
const { applyStartupDefaults, clearStartupDefaultsForRelaunch } = require('../desktop/startup-defaults.cjs');

function fixture(isBusy = () => false) {
  let timer, restarts = 0;
  const controller = createModelRuntimeRestart({ isBusy, relaunch: () => restarts++,
    timers: { setTimeout(fn) { timer = fn; return 1; }, clearTimeout() { timer = undefined; } } });
  return { controller, fire() { const fn = timer; timer = undefined; fn?.(); }, get restarts() { return restarts; } };
}

test('save closes admission immediately, coalesces notifications and relaunches once', () => {
  const f = fixture();
  f.controller.request();
  assert.throws(() => f.controller.assertReady(), { code: 'MODEL_RUNTIME_RESTART_PENDING' });
  f.controller.request();
  f.fire(); f.fire(); f.controller.request(); f.fire();
  assert.equal(f.restarts, 1);
});

test('live runner finishes intact while new calls and cached runner calls are held', async () => {
  const f = fixture();
  let finish;
  const runner = f.controller.guardRunner({ run: () => new Promise(resolve => { finish = resolve; }) });
  const current = runner.run();
  f.controller.request(); f.fire();
  assert.equal(f.restarts, 0);
  await assert.rejects(runner.run(), { code: 'MODEL_RUNTIME_RESTART_PENDING' });
  finish('completed');
  assert.equal(await current, 'completed');
  f.fire();
  assert.equal(f.restarts, 1);
});

test('CCB turns, queued work, approvals and background work defer restart; idle actors do not', () => {
  let processes = [{ hasPendingTurn: true }];
  const backends = [{ getActiveProcesses: () => processes }];
  const f = fixture(() => modelRuntimeBusy({ backends }));
  f.controller.request(); f.fire(); assert.equal(f.restarts, 0);
  for (const protection of ['backgroundTasks', 'cron', 'loopWakeup', 'remoteControl']) {
    processes = [{ protection: { flags: { [protection]: true } } }];
    f.fire(); assert.equal(f.restarts, 0);
  }
  processes = [{ pendingApprovals: 1 }]; f.fire(); assert.equal(f.restarts, 0);
  processes = [{ pendingControls: 1 }]; f.fire(); assert.equal(f.restarts, 0);
  processes = [{ initialized: true, idleEligible: true }]; f.fire();
  assert.equal(f.restarts, 1);
});

test('bridge running and pending queries defer restart before CCB spawn', () => {
  const bridge = { diagnose: () => ({ sessions: [{ sessionId: 's', isRunning: false }] }),
    getWarmLifecycleState: () => ({ hasActiveQuery: true }) };
  assert.equal(modelRuntimeBusy({ bridge }), true);
  bridge.getWarmLifecycleState = () => ({ hasActiveQuery: false });
  assert.equal(modelRuntimeBusy({ bridge }), false);
});

test('CCB guard blocks new actors and turns, preserving native methods, approvals and cancellation', () => {
  const f = fixture(); const calls = [];
  const backend = { start: () => calls.push('start'), sendMessage: () => calls.push('send'),
    warm: () => calls.push('warm'), cancel: () => calls.push('cancel'), acceptSteer: () => calls.push('steer') };
  assert.equal(f.controller.guardBackend(backend), backend);
  backend.start(); f.controller.request();
  for (const method of ['start', 'sendMessage', 'warm']) {
    assert.throws(() => backend[method](), { code: 'MODEL_RUNTIME_RESTART_PENDING' });
  }
  backend.cancel(); backend.acceptSteer();
  assert.deepEqual(calls, ['start', 'cancel', 'steer']);
});

test('failed existing inference releases activity and permits restart without logging provider data', async () => {
  const f = fixture();
  let fail;
  const result = f.controller.run(() => new Promise((_resolve, reject) => { fail = reject; }));
  f.controller.request(); f.fire();
  assert.equal(f.restarts, 0);
  fail(new Error('fixture failure'));
  await assert.rejects(result, /fixture failure/);
  f.fire(); assert.equal(f.restarts, 1);
});

test('busy inspection errors fail closed and retry without exposing exception text', () => {
  let throws = true, restarts = 0, timer;
  const errors = [];
  const controller = createModelRuntimeRestart({
    isBusy: () => { if (throws) throw new Error('fixture private provider data'); return false; },
    relaunch: () => restarts++, onError: message => errors.push(message),
    timers: { setTimeout(fn) { timer = fn; return 1; }, clearTimeout() {} },
  });
  controller.request(); timer();
  assert.equal(restarts, 0);
  assert.deepEqual(errors, ['Model configuration restart deferred']);
  throws = false; timer(); assert.equal(restarts, 1);
});

test('ordinary quit disposes pending restart', () => {
  const f = fixture(); f.controller.request(); f.controller.dispose(); f.fire();
  assert.equal(f.restarts, 0);
});

test('relaunch clears profile-derived environment so startup uses the newly selected provider', () => {
  const env = {};
  const resolve = gateway => () => gateway;
  const runtime = () => ({});
  applyStartupDefaults(env, resolve({ baseUrl: 'https://old.invalid', apiKey: 'fixture-old', model: 'old-model' }), runtime);
  clearStartupDefaultsForRelaunch(env);
  applyStartupDefaults(env, resolve({ baseUrl: 'https://new.invalid', apiKey: 'fixture-new', model: 'new-model' }), runtime);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://new.invalid');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN === 'fixture-new', true);
  assert.equal(env.CLAUDE_AGENT_MODEL, 'new-model');
});
