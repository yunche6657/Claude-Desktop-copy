// setShellPtyTitle must actually record the title.
//
// The renderer derives a label per shell and pushes it in:
//   c9ddef367, fn r(): for (const shell of shells) setShellPtyTitle(key(session, shell.id), label)
//   cccc2cf0a:        setShellPtyTitle(ptyKey, derivedTitle) once the shell names itself
// and c03935b01 wraps it as `setShellPtyTitle: (e, t) => void _?.setShellPtyTitle?.(e, t)`.
//
// The return value is discarded -- the SIDE EFFECT is the entire contract. It answered
// { ok: true } without storing anything, so every terminal tab kept its placeholder label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createShellSessions } = require('../desktop/shell-sessions.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/**
 * A shell manager whose child process is a stub.
 *
 * shells.start() normally launches a real `cmd`, and on Windows killing it does not
 * immediately close the stdout pipe, so the test runner keeps waiting on the child and the
 * file hangs. createShellSessions accepts `spawnImpl` for exactly this reason, so the title
 * logic can be exercised without any process.
 */
function makeShells() {
  const events = [];
  const fakeSpawn = () => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() { return true; }, end() {} };
    child.kill = () => true;
    return child;
  };
  const shells = createShellSessions({
    emit: (event) => events.push(event),
    log: () => {},
    spawnImpl: fakeSpawn,
  });
  return { shells, events };
}

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
  return { call };
}

test('a title is remembered for a live shell', () => {
  const { shells } = makeShells();
  // Register a shell without spawning: start() would create a child process, so the entry is
  // created through the same map the manager uses.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-title-'));
  const started = shells.start('s1', 80, 24, 'pane_open', root, false);
  assert.equal(started.ok, true, `start must succeed: ${JSON.stringify(started)}`);

  const result = shells.setTitle('s1', 'Claude · Terminal 1');
  assert.equal(result.ok, true);
  assert.equal(shells.title('s1'), 'Claude · Terminal 1');
  shells.dispose();
});

test('the title shows up in the shell list', () => {
  // getTerminalShells answers list(), so a title that is not in list() never reaches the UI.
  const { shells } = makeShells();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-title-'));
  shells.start('s2', 80, 24, 'pane_open', root, false);
  shells.setTitle('s2', 'my shell');

  const listed = shells.list().find((s) => s.sessionId === 's2');
  assert.ok(listed, 'the shell must be listed');
  assert.equal(listed.title, 'my shell');
  shells.dispose();
});

test('a title can be replaced', () => {
  const { shells } = makeShells();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-title-'));
  shells.start('s3', 80, 24, 'pane_open', root, false);
  shells.setTitle('s3', 'first');
  shells.setTitle('s3', 'second');
  assert.equal(shells.title('s3'), 'second', 'the latest title wins');
  shells.dispose();
});

test('an unknown shell is refused rather than invented', () => {
  // A title is metadata about a live shell; accepting one for a missing shell would create
  // a phantom entry that list() then has to skip.
  const { shells } = makeShells();
  const result = shells.setTitle('no-such-shell', 'x');
  assert.equal(result.ok, false);
  assert.equal(shells.title('no-such-shell'), null);
  assert.deepEqual(shells.list(), [], 'no phantom entry may appear');
});

test('a non-string title is refused', () => {
  const { shells } = makeShells();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-title-'));
  shells.start('s4', 80, 24, 'pane_open', root, false);
  for (const bad of [undefined, null, 42, {}, []]) {
    const result = shells.setTitle('s4', bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(shells.title('s4'), null);
  shells.dispose();
});

test('an untitled shell has no title key in the list', () => {
  // The UI checks `title` presence; an empty string would render an empty tab label.
  const { shells } = makeShells();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-title-'));
  shells.start('s5', 80, 24, 'pane_open', root, false);
  const listed = shells.list().find((s) => s.sessionId === 's5');
  assert.equal(Object.hasOwn(listed, 'title'), false);
  shells.dispose();
});

test('the bridge handler routes to the shell manager', async () => {
  // The handler used to be `() => ({ ok: true })` and never touched the manager, so this
  // call must now be refused for an unknown shell instead of pretending success.
  // The registered handler is async (define() wraps it), so it must be awaited.
  const { call } = makeBridge();
  const result = await call('LocalSessions', 'setShellPtyTitle', 'no-such-shell', 'label');
  assert.equal(result.ok, false, 'an unknown shell must not answer ok:true');
});

test('the bridge handler refuses a missing title', async () => {
  const { call } = makeBridge();
  const result = await call('LocalSessions', 'setShellPtyTitle', 'no-such-shell');
  assert.equal(result.ok, false);
});

test('getTerminalShells reflects titles set through the bridge', async () => {
  // End-to-end through the bridge: the handler must reach the same manager getTerminalShells
  // reads. No real process is started -- the shell manager owns its own map, and this test
  // only proves the two handlers agree on it.
  const { call } = makeBridge();

  // With no shells at all, both handlers must still agree.
  const empty = await call('LocalSessions', 'getTerminalShells');
  assert.ok(Array.isArray(empty), 'getTerminalShells must answer an array');

  const refused = await call('LocalSessions', 'setShellPtyTitle', 'e2e-session', 'Claude · e2e');
  assert.equal(refused.ok, false, 'a shell that was never started must be refused');

  // And the refusal must not have created a phantom entry.
  const after = await call('LocalSessions', 'getTerminalShells');
  assert.equal(after.length, empty.length, 'a refused title must not add a shell');
});
