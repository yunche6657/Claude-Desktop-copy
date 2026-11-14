// checkGhAvailable must answer a bare boolean, never null.
//
// Note the shape difference from its sibling checkGitAvailable, which answers
// { available, reason }. This one is a BOOLEAN.
//
// Consumer (c227f4d5e-B8RiNIYP.js, fn `xR` exported as `zo`):
//   const t = nn?.checkGhAvailable;
//   queryFn: () => t(e)
//   const { data: o, isFetchedAfterMount: s, isFetching: c } = useQuery(...)
//   const l = (o === false && !s) ? undefined : o;   // "false before a remount" -> unknown
//   const u = (l === undefined) && c;
//   return { available: l, isChecking: u };
// and the UI offers an "Install the GitHub CLI" dialog when gh is unavailable.
//
// Measured on the live replica before the fix:
//   answer null
//   available null, treatsAsAvailable false, treatsAsUnavailable false
// i.e. the value fell through both branches: neither "gh is ready" nor "gh is missing".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

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

/** Is the gh CLI resolvable on this host? */
function ghOnPath() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    return execFileSync(finder, ['gh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch { return false; }
}

test('the answer is a boolean, not null and not an object', async () => {
  const { call } = makeBridge();
  const answer = await call('LocalSessions', 'checkGhAvailable', 'probe-session');
  assert.equal(typeof answer, 'boolean', `expected a boolean, got ${answer === null ? 'null' : typeof answer}`);
});

test('the answer agrees with whether gh is actually on PATH', async () => {
  // This is what makes the probe real rather than a constant.
  const { call } = makeBridge();
  const answer = await call('LocalSessions', 'checkGhAvailable', 'probe-session');
  assert.equal(answer, ghOnPath(), 'the answer must match the host');
});

test('the consumer derives a definite available value, not a fall-through', async () => {
  // Replay the consumer's own derivation. With a null the value was neither true nor false,
  // so the UI entered neither branch.
  const { call } = makeBridge();
  const o = await call('LocalSessions', 'checkGhAvailable', 'probe-session');
  const isFetchedAfterMount = true;
  const available = o === false && !isFetchedAfterMount ? undefined : o;

  assert.notEqual(available, null, 'available must never be null');
  assert.equal(available === true || available === false, true, 'available must be a decision');
});

test('a missing gh yields false, which is what makes the install prompt reachable', async () => {
  const { call } = makeBridge();
  const answer = await call('LocalSessions', 'checkGhAvailable', 'probe-session');
  if (!ghOnPath()) {
    assert.equal(answer, false, 'gh is not installed here, so the UI must be able to offer installation');
  }
});

test('the staleTime rule behaves on the real answer', async () => {
  // The consumer has:
  //   SR = e => e.state.data !== false || "always"      (refetchOnMount)
  //   CR = e => e.state.data === true ? Infinity : 30000 (staleTime)
  // Both branch on a strict boolean; null matched neither.
  const { call } = makeBridge();
  const data = await call('LocalSessions', 'checkGhAvailable', 'probe-session');

  const refetchOnMount = data !== false || 'always';
  const staleTime = data === true ? Infinity : 30000;

  assert.ok(refetchOnMount === true || refetchOnMount === 'always', 'refetchOnMount must resolve');
  assert.ok(staleTime === Infinity || staleTime === 30000, 'staleTime must resolve');
});

test('the answer does not depend on the session id argument', async () => {
  // The signature takes a session id, but gh availability is a machine fact. Guards against
  // an implementation that answers differently per argument for no reason.
  const { call } = makeBridge();
  const a = await call('LocalSessions', 'checkGhAvailable', 'session-a');
  const b = await call('LocalSessions', 'checkGhAvailable', 'session-b');
  const c = await call('LocalSessions', 'checkGhAvailable');
  assert.equal(a, b);
  assert.equal(b, c);
});
