import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const oldLoad = Module._load;
const windows = [];

class Window extends EventEmitter {
  constructor() {
    super();
    this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = () => {};
    this.dead = false;
    this.closeCalls = 0;
    windows.push(this);
  }
  removeMenu() {}
  loadFile() { return Promise.resolve(); }
  show() {}
  focus() {}
  isFocused() { return false; }
  isDestroyed() { return this.dead; }
  close() { this.closeCalls++; this.emit('close'); }
  destroy() { this.dead = true; this.emit('closed'); }
}

let ConsentManager, CHOOSE_CHANNEL;
try {
  Module._load = function(name, ...args) {
    if (name === 'electron') return { BrowserWindow: Window, app: { isPackaged: true } };
    return oldLoad.call(this, name, ...args);
  };
  ({ ConsentManager, CHOOSE_CHANNEL } = require('../desktop/consent-manager.cjs'));
} finally { Module._load = oldLoad; }

const tick = () => new Promise(resolve => setImmediate(resolve));
const request = { kind: 'run-command', command: 'fixture' };
function ipc() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, handler) => {
      assert.equal(handlers.has(channel), false);
      handlers.set(channel, handler);
    },
    removeHandler: channel => handlers.delete(channel),
  };
}

test('dispose before queued work starts cancels it and future requests', async () => {
  const connection = ipc();
  const manager = new ConsentManager({ parentWindow: null, ipcMain: connection });
  manager.register();
  const start = windows.length;
  const first = manager.ask(request);
  const second = manager.ask(request);
  manager.dispose();
  manager.dispose();
  assert.equal(await first, 'cancel');
  assert.equal(await second, 'cancel');
  assert.equal(await manager.ask(request), 'cancel');
  assert.equal(windows.length, start);
  assert.equal(connection.handlers.size, 0);
});

test('delayed close blocks queue, invalidates old asks across re-registration, and accepts new asks', async () => {
  const connection = ipc();
  const manager = new ConsentManager({ parentWindow: null, ipcMain: connection });
  manager.register();
  const start = windows.length;
  try {
    const first = manager.ask(request);
    await tick();
    const oldWindow = windows.at(-1);
    const queued = manager.ask(request);
    manager.dispose();
    manager.dispose();
    assert.equal(oldWindow.closeCalls, 1);
    assert.equal(await manager.ask(request), 'cancel');
    manager.register();
    manager.register();
    assert.equal(connection.handlers.size, 1);
    const fresh = manager.ask(request);
    await tick();
    assert.equal(windows.length, start + 1);
    oldWindow.destroy();
    assert.equal(await first, 'cancel');
    assert.equal(await queued, 'cancel');
    await tick();
    assert.equal(windows.length, start + 2);
    const newWindow = windows.at(-1);
    const event = { sender: newWindow.webContents, senderFrame: { url: 'file:///consent.html', parent: null } };
    assert.deepEqual(connection.handlers.get(CHOOSE_CHANNEL)(event, 'cancel'), { ok: true, decision: 'cancel' });
    assert.equal(newWindow.closeCalls, 1);
    newWindow.destroy();
    assert.equal(await fresh, 'cancel');
  } finally { manager.dispose(); }
});
