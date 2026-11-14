// checkGitAvailable must answer the {available, reason} object the UI reads.
//
// The consumer (cb92a6d7a-B_0aRBoJ.js) does:
//   l.setState({ gitAvailable: e })                       // stores whatever comes back
//   t?.available === false && e.available && ...           // transition when it becomes usable
//   l.getState().gitAvailable?.available !== true && d()   // re-check while not available
//   C({hostGit}) -> hostGit?.available === false ? ... : null
// and renders a reason-specific banner for n.StartupFailed.
//
// The reason enum is { NotFound:"not-found", ExecBlocked:"exec-blocked",
//                      StartupFailed:"startup-failed" }  (shared-0-BRYCPbU4.js, `Db`)
//
// With no handler the fallback answered `null`, so `.available` was `undefined` and every
// `=== false` branch was skipped: the app behaved as if git were fine without ever asking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { kernel, call };
}

const REASONS = new Set(['not-found', 'exec-blocked', 'startup-failed']);

test('the answer is an object with a boolean `available`', async () => {
  const { call } = makeBridge();
  const answer = await call('ClaudeCode', 'checkGitAvailable');
  assert.equal(typeof answer, 'object', 'must not be null: the consumer reads .available');
  assert.equal(typeof answer.available, 'boolean');
});

test('git on this host is reported available, because it really runs', async () => {
  const { call } = makeBridge();
  const answer = await call('ClaudeCode', 'checkGitAvailable');
  // git 2.55 is installed on this host (verified with `git --version`).
  assert.equal(answer.available, true);
  // An available answer needs no reason.
  assert.equal(answer.reason, undefined);
});

test('when git is available no reason is reported', async () => {
  const { call } = makeBridge();
  const answer = await call('ClaudeCode', 'checkGitAvailable');
  if (answer.available === true) {
    assert.equal(answer.reason, undefined, 'a working git has nothing to explain');
  }
});

test('a reason, when present, is a member of the UI enum', async () => {
  // The banner component compares against n.StartupFailed etc. A reason outside the enum
  // would render nothing, which is the same silent failure the null answer caused.
  const { call } = makeBridge();
  const answer = await call('ClaudeCode', 'checkGitAvailable');
  if (answer.available === false) {
    assert.ok(REASONS.has(answer.reason), `reason ${JSON.stringify(answer.reason)} is outside the enum`);
  }
});

test('the consumer\'s three predicates behave correctly on the real answer', async () => {
  // Replay the exact expressions from the bundle rather than trusting the shape alone.
  const { call } = makeBridge();
  const gitAvailable = await call('ClaudeCode', 'checkGitAvailable');

  const isUnavailable = gitAvailable?.available === false;
  const needsRecheck = gitAvailable?.available !== true;
  const becameAvailable = gitAvailable?.available === true;

  assert.equal(isUnavailable, false, 'git works here, so the unavailable branch must not fire');
  assert.equal(needsRecheck, false, 'a usable git must stop the 15s re-check loop');
  assert.equal(becameAvailable, true);
});

test('the answer does not claim availability without running git', async () => {
  // Guard against a hard-coded `{available:true}`.
  //
  // A previous version of this test only checked the key set, and a second version only
  // checked the exported classifier -- both stayed GREEN when the handler was replaced by
  // a constant, because they inspected code the constant does not touch. The regression
  // proof caught that twice.
  //
  // What actually distinguishes a real probe is that the handler's answer depends on
  // whether git can run. Force that dependency to be observable: run the handler with a
  // PATH that cannot contain git and require the answer to change.
  const { classifyGitFailure, registerBridgeServices } = require('../desktop/bridge-services.cjs');
  assert.equal(typeof classifyGitFailure, 'function');

  // The classifier is still asserted, because the handler must route failures through it.
  assert.equal(classifyGitFailure({ code: 'ENOENT' }), 'not-found');
  assert.equal(classifyGitFailure({ code: 'EPERM' }), 'exec-blocked');
  assert.equal(classifyGitFailure({ code: 'EACCES' }), 'exec-blocked');
  assert.equal(classifyGitFailure({ code: 'UNKNOWN' }), 'startup-failed');

  // Now the dependency itself: with PATH emptied, git cannot be found, so a real probe
  // must report unavailable with reason not-found. A hard-coded answer cannot do this.
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const channel = [...handlers.keys()].find((c) => c.endsWith('_$_checkGitAvailable'));
  const fn = handlers.get(channel);

  const savedPath = process.env.PATH;
  const savedPathExt = process.env.PATHEXT;
  try {
    // An empty PATH means git cannot be resolved.
    process.env.PATH = '';
    if (process.platform === 'win32') process.env.PATHEXT = '';
    const withoutGit = await fn({});
    assert.equal(withoutGit.available, false, 'with no git on PATH the probe must say unavailable');
    assert.ok(REASONS.has(withoutGit.reason), `reason ${JSON.stringify(withoutGit.reason)} outside enum`);
  } finally {
    process.env.PATH = savedPath;
    if (savedPathExt !== undefined) process.env.PATHEXT = savedPathExt;
  }

  // And with the real PATH restored it must come back available again.
  const withGit = await fn({});
  assert.equal(withGit.available, true, 'git works on this host once PATH is restored');
});
