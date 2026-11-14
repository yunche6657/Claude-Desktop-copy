// A guard against the defect class that bit twice in a row.
//
// listSessionDirectory and readSessionFileWithStatus were both DECLARED in bridge-map and
// had NO handler. Neither threw: the channel registered, the call resolved, and the answer
// was null. The failure only showed up when a consumer read a field off that null, and by
// then the symptom was "Folder is empty" or a tab that spins forever — nowhere near the
// real cause.
//
// This test pins the specific methods whose consumers read fields off the answer, so a
// future edit that drops a handler fails here instead of silently reverting a feature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const channels = [...handlers.keys()];
  return { kernel, channels, handlers };
}

/**
 * The methods whose consumers destructure or read a property off the answer.
 *
 * For these, `null` is not a benign empty value: it is a crash or an endless loading
 * state. Each entry names the consumer that reads it.
 */
const MUST_ANSWER_STRUCTURED = [
  // cf3dc8013-DPZGVxPE.js `S`: reads i.status / i.file / i.unavailable
  'LocalSessions_$_readSessionFileWithStatus',
  // cfac349aa-C6zhOLan.js `at`: `?? []`, so null became "Folder is empty"
  'LocalSessions_$_listSessionDirectory',
];

test('every method whose answer is destructured has its own handler', async () => {
  // A dropped handler does NOT remove the channel: the generic fallback still registers
  // every declared method, so "is the channel present?" is always true and proves nothing.
  // (Confirmed by the regression proof: removing either handler left this assertion green.)
  //
  // What actually distinguishes a real handler is behaviour — the fallback answers a
  // generic empty value, never a domain shape. That is what the next test checks.
  const { channels } = makeBridge();
  for (const frag of MUST_ANSWER_STRUCTURED) {
    assert.ok(channels.some((c) => c.includes(frag)), `${frag} is not registered at all`);
  }
});

test('the fallback cannot impersonate a real handler', async () => {
  // The fallback answers `[]`-ish empty values. These two must never produce those:
  // one returns a status wrapper, the other an array of {name,path,isDirectory} objects.
  const { kernel, channels, handlers } = makeBridge();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard2-'));
  fs.writeFileSync(path.join(root, 'f.txt'), 'x');
  const s = kernel.start({ cwd: root });
  const invoke = (frag, ...args) => handlers.get(channels.find((c) => c.includes(frag)))({}, ...args);

  const listed = await invoke('LocalSessions_$_listSessionDirectory', s.sessionId, root);
  assert.ok(Array.isArray(listed));
  assert.ok(listed.length > 0, 'a folder with a file in it must not list as empty');
  assert.equal(typeof listed[0].name, 'string', 'the fallback would not produce this shape');

  const read = await invoke('LocalSessions_$_readSessionFileWithStatus', s.sessionId, path.join(root, 'f.txt'));
  assert.equal(typeof read, 'object');
  assert.equal(typeof read.status, 'string', 'the fallback would answer a bare empty value');
});

test('those channels answer a value, not null', async () => {
  const { kernel, channels, handlers } = makeBridge();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  fs.writeFileSync(path.join(root, 'f.txt'), 'x');
  const s = kernel.start({ cwd: root });

  const invoke = (frag, ...args) => {
    const channel = channels.find((c) => c.includes(frag));
    const fn = handlers.get(channel);
    return fn({}, ...args);
  };

  const listed = await invoke('LocalSessions_$_listSessionDirectory', '___', root);
  assert.notEqual(listed, null, 'listSessionDirectory must not answer null');

  const read = await invoke('LocalSessions_$_readSessionFileWithStatus', s.sessionId, path.join(root, 'f.txt'));
  assert.notEqual(read, null, 'readSessionFileWithStatus must not answer null');
  assert.equal(typeof read.status, 'string');
});

test('the scan finds handlers written with template literals too', async () => {
  // The first version of the audit script only matched define('literal') and therefore
  // reported respondToToolPermission as unhandled — a false positive that would have sent
  // me "fixing" something already correct. Both namespaces are registered from one loop
  // using a template, so the guard has to model that.
  const { channels } = makeBridge();
  for (const ns of ['LocalSessions', 'LocalAgentModeSessions']) {
    assert.ok(
      channels.some((c) => c.includes(`${ns}_$_respondToToolPermission`)),
      `${ns}.respondToToolPermission should be registered by the shared loop`,
    );
  }
});
