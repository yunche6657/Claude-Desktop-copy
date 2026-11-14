import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';

const { acquireSingleInstance, resolveInstanceDirectory } = createRequire(import.meta.url)('../desktop/single-instance.cjs');
const { createAppLifecycle } = createRequire(import.meta.url)('../desktop/app-lifecycle.cjs');

function fixture(primary = true) {
  const app = new EventEmitter();
  let userData = path.resolve('workspace-profile');
  const original = userData;
  const calls = [];
  app.getPath = name => name === 'appData' ? path.resolve('user-appdata') : userData;
  app.setPath = (name, value) => { assert.equal(name, 'userData'); userData = value; };
  app.requestSingleInstanceLock = () => { calls.push(['lock', userData]); return primary; };
  app.quit = () => calls.push(['quit']);
  app.relaunch = options => calls.push(['relaunch', options]);
  app.exit = () => {};
  let win = null;
  const controller = acquireSingleInstance({ app, getWindow: () => win, env: {}, mkdir: () => {} });
  return { app, calls, original, controller, setWindow: value => { win = value; } };
}

function windowFixture({ minimized = false, destroyed = false } = {}) {
  const calls = [];
  return { calls, isDestroyed: () => destroyed, isMinimized: () => minimized,
    restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus') };
}

test('native lock uses fixed user profile and restores Chromium profile immediately', () => {
  const f = fixture();
  assert.equal(f.controller.primary, true);
  assert.equal(f.calls[0][1], path.join(path.resolve('user-appdata'), 'CodeDesktop.Reconstruction', 'SingleInstance'));
  assert.equal(f.app.getPath('userData'), f.original);
  assert.equal(resolveInstanceDirectory({ app: f.app, env: { CLAUDE_WORKSPACE: 'build-a' }, cwd: 'build-a' }),
    resolveInstanceDirectory({ app: f.app, env: { CLAUDE_WORKSPACE: 'build-b' }, cwd: 'build-b' }));
});

test('duplicate quits without retaining activation listeners', () => {
  const f = fixture(false);
  assert.equal(f.controller.primary, false);
  assert.deepEqual(f.calls.map(call => call[0]), ['lock', 'quit']);
  assert.equal(f.app.listenerCount('second-instance'), 0);
  assert.equal(f.app.getPath('userData'), f.original);
});

test('second launch restores minimized window, shows hidden tray window and focuses it', () => {
  const f = fixture();
  const win = windowFixture({ minimized: true });
  f.setWindow(win);
  f.app.emit('second-instance');
  assert.deepEqual(win.calls, ['restore', 'show', 'focus']);
});

test('launch during initialization waits for a usable main window', () => {
  const f = fixture();
  f.app.emit('second-instance');
  const dead = windowFixture({ destroyed: true });
  f.setWindow(dead);
  f.controller.windowReady();
  assert.deepEqual(dead.calls, []);
  const win = windowFixture();
  f.setWindow(win);
  f.controller.windowReady();
  f.controller.windowReady();
  assert.deepEqual(win.calls, ['show', 'focus']);
});

test('test profiles are isolated explicitly or by background-check workspace', () => {
  const f = fixture();
  assert.equal(resolveInstanceDirectory({ app: f.app, env: { CLAUDE_INSTANCE_PROFILE: './profile-one' } }), path.resolve('profile-one'));
  const a = resolveInstanceDirectory({ app: f.app, env: { CLAUDE_BACKGROUND_CHECK: '1', CLAUDE_WORKSPACE: 'proof-a' } });
  const b = resolveInstanceDirectory({ app: f.app, env: { CLAUDE_BACKGROUND_CHECK: '1', CLAUDE_WORKSPACE: 'proof-b' } });
  assert.notEqual(a, b);
});

test('profile is restored even if native lock throws', () => {
  const f = fixture();
  f.app.requestSingleInstanceLock = () => { throw new Error('native lock failed'); };
  assert.throws(() => acquireSingleInstance({ app: f.app, getWindow: () => null, env: {}, mkdir: () => {} }), /native lock failed/);
  assert.equal(f.app.getPath('userData'), f.original);
});

test('main entry stops duplicate before startup defaults or services are loaded', () => {
  const main = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  const loaded = [];
  const entry = new vm.Script(`(function(require) { ${main}\n})`).runInNewContext();
  entry(name => {
    loaded.push(name);
    if (name === 'electron') return { app: {} };
    if (name === 'node:path' || name === 'node:fs') return {};
    if (name === './single-instance.cjs') return { acquireSingleInstance: () => ({ primary: false }) };
    throw new Error(`duplicate unexpectedly loaded ${name}`);
  });
  assert.deepEqual(loaded, ['electron', 'node:path', 'node:fs', './single-instance.cjs']);
});

test('relaunch keeps singleton owned throughout deferred cleanup and schedules replacement', async () => {
  const f = fixture();
  let releaseCleanup;
  f.app.releaseSingleInstanceLock = () => assert.fail('singleton must remain held until process exit');
  f.app.quit = () => {
    const event = { preventDefault() {} };
    f.app.emit('before-quit', event);
  };
  const lifecycle = createAppLifecycle({ app: f.app, prepareForQuit: () => new Promise(resolve => { releaseCleanup = resolve; }) });
  lifecycle.relaunchApp();
  await new Promise(resolve => setImmediate(resolve));
  const win = windowFixture();
  f.setWindow(win);
  f.app.emit('second-instance');
  assert.deepEqual(win.calls, ['show', 'focus']);
  releaseCleanup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call[0] === 'relaunch').length, 1);
  lifecycle.dispose();
});
