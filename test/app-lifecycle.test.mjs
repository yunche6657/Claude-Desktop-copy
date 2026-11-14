import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const { createAppLifecycle } = createRequire(import.meta.url)('../desktop/app-lifecycle.cjs');

function fixture(prepareForQuit = async () => {}, isPackaged = false, quiesce = async () => {}) {
  const app = new EventEmitter();
  app.isPackaged = isPackaged;
  const calls = [];
  app.quit = () => {
    calls.push('quit');
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit('before-quit', event);
    calls.push(event.defaultPrevented ? 'held' : 'allowed');
  };
  const relaunchOptions = [];
  app.relaunch = options => { relaunchOptions.push(options); calls.push('relaunch'); };
  app.exit = code => calls.push(`exit:${code}`);
  const errors = [];
  const scheduled = new Map();
  let id = 0;
  const timers = {
    setTimeout(fn, delay) { const key = ++id; scheduled.set(key, { fn, delay }); return key; },
    clearTimeout(key) { scheduled.delete(key); },
  };
  const fire = delay => {
    const entry = [...scheduled].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `missing timer ${delay}`);
    scheduled.delete(entry[0]);
    entry[1].fn();
  };
  const lifecycle = createAppLifecycle({ app, prepareForQuit, quiesce, timers, onError: error => errors.push(error) });
  return { app, calls, errors, lifecycle, fire, relaunchOptions };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('relaunch holds quit until preparation, then schedules one restart and quits', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(f.lifecycle.relaunchApp(), undefined);
  f.lifecycle.relaunchApp();
  await tick();
  assert.deepEqual(f.calls, ['quit', 'held']);
  f.app.quit();
  assert.deepEqual(f.calls, ['quit', 'held', 'quit', 'held']);
  finish();
  await tick();
  assert.deepEqual(f.calls, ['quit', 'held', 'quit', 'held', 'relaunch', 'quit', 'allowed']);
});

test('ordinary quit waits for cleanup and quiesce and does not relaunch', async () => {
  let finishCleanup, finishWrites;
  const f = fixture(() => new Promise(resolve => { finishCleanup = resolve; }), false,
    () => new Promise(resolve => { finishWrites = resolve; }));
  f.app.quit();
  await tick();
  f.app.quit();
  f.lifecycle.relaunchApp();
  assert.deepEqual(f.calls, ['quit', 'held', 'quit', 'held']);
  finishCleanup();
  await tick();
  assert.deepEqual(f.calls, ['quit', 'held', 'quit', 'held']);
  finishWrites();
  await tick();
  assert.deepEqual(f.calls, ['quit', 'held', 'quit', 'held', 'quit', 'allowed']);
  assert.deepEqual(f.relaunchOptions, []);
});

test('cleanup failure still waits for quiesce and continues', async () => {
  const failure = new Error('cleanup failed');
  const f = fixture(async () => { throw failure; });
  f.app.quit();
  await tick();
  assert.deepEqual(f.errors, [failure]);
  assert.deepEqual(f.calls, ['quit', 'held', 'quit', 'allowed']);
});

test('quiesce timeout permits quit and late completion does not quit twice', async () => {
  let finish;
  const f = fixture(async () => {}, false, () => new Promise(resolve => { finish = resolve; }));
  f.app.quit();
  await tick();
  f.fire(5000);
  await tick();
  assert.deepEqual(f.calls, ['quit', 'held', 'quit', 'allowed']);
  assert.match(f.errors[0].message, /quiesce timed out/);
  finish();
  await tick();
  assert.equal(f.calls.filter(call => call === 'quit').length, 2);
});

test('will-quit starts the same gate if before-quit did not run', async () => {
  const f = fixture();
  let prevented = false;
  f.app.emit('will-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await tick();
  assert.deepEqual(f.calls, ['quit', 'allowed']);
});

test('pending cleanup times out and a stuck quit is forced to exit', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }), true);
  f.lifecycle.relaunchApp();
  await tick();
  f.fire(75000);
  await tick();
  assert.deepEqual(f.calls, ['quit', 'held', 'relaunch', 'quit', 'allowed']);
  finish();
  await tick();
  assert.equal(f.calls.filter(call => call === 'relaunch').length, 1);
  f.fire(15000);
  assert.equal(f.calls.at(-1), 'exit:0');
  assert.match(f.errors[0].message, /cleanup timed out/);
  assert.match(f.errors[1].message, /quit timed out/i);
});

test('detach prevents a pending cleanup from relaunching', async () => {
  const f = fixture(() => new Promise(() => {}));
  f.lifecycle.relaunchApp();
  f.lifecycle.dispose();
  await tick();
  assert.deepEqual(f.calls, ['quit', 'held']);
});


test('relaunch supplies constructed args and appends internal additions', async () => {
  const f = fixture();
  f.lifecycle.relaunchApp(['--startup', 'extra']);
  await tick();
  const { buildRelaunchArgs } = createRequire(import.meta.url)('../desktop/relaunch-args.cjs');
  assert.deepEqual(f.relaunchOptions, [{ args: buildRelaunchArgs(process.argv, process.defaultApp, ['--startup', 'extra']) }]);
});

test('E2E exit-only suppresses relaunch while completing quit', async () => {
  const previous = process.env.CLAUDE_E2E_RELAUNCH_EXIT_ONLY;
  const previousHook = globalThis.isDeveloperApprovedE2eTestHooksEnabled;
  process.env.CLAUDE_E2E_RELAUNCH_EXIT_ONLY = '1';
  globalThis.isDeveloperApprovedE2eTestHooksEnabled = true;
  try {
    const f = fixture();
    f.lifecycle.relaunchApp();
    await tick();
    assert.deepEqual(f.calls, ['quit', 'held', 'quit', 'allowed']);
    assert.deepEqual(f.relaunchOptions, []);
  } finally {
    if (previousHook === undefined) delete globalThis.isDeveloperApprovedE2eTestHooksEnabled;
    else globalThis.isDeveloperApprovedE2eTestHooksEnabled = previousHook;
    if (previous === undefined) delete process.env.CLAUDE_E2E_RELAUNCH_EXIT_ONLY;
    else process.env.CLAUDE_E2E_RELAUNCH_EXIT_ONLY = previous;
  }
});


test('E2E environment alone does not suppress relaunch without approved hook', async () => {
  const previous = process.env.CLAUDE_E2E_RELAUNCH_EXIT_ONLY;
  const previousHook = globalThis.isDeveloperApprovedE2eTestHooksEnabled;
  process.env.CLAUDE_E2E_RELAUNCH_EXIT_ONLY = '1';
  delete globalThis.isDeveloperApprovedE2eTestHooksEnabled;
  try {
    const f = fixture();
    f.lifecycle.relaunchApp();
    await tick();
    assert.equal(f.relaunchOptions.length, 1);
  } finally {
    if (previousHook !== undefined) globalThis.isDeveloperApprovedE2eTestHooksEnabled = previousHook;
    if (previous === undefined) delete process.env.CLAUDE_E2E_RELAUNCH_EXIT_ONLY;
    else process.env.CLAUDE_E2E_RELAUNCH_EXIT_ONLY = previous;
  }
});

