import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const oldLoad = Module._load;
const windows = [];
class Window extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.dead = false;
    this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {};
    windows.push(this);
  }
  removeMenu() {}
  loadFile() { return Promise.resolve(); }
  show() {}
  focus() {}
  isFocused() { return false; }
  isDestroyed() { return this.dead; }
  destroy() { this.dead = true; this.emit('closed'); }
}
let ConsentManager;
try {
  Module._load = function(name, ...args) {
    if (name === 'electron') return { BrowserWindow: Window, app: { isPackaged: true } };
    return oldLoad.call(this, name, ...args);
  };
  ({ ConsentManager } = require('../desktop/consent-manager.cjs'));
} finally { Module._load = oldLoad; }

class Parent extends EventEmitter {
  constructor() { super(); this.visible = false; this.minimized = false; this.opacity = 1; this.dead = false; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  getOpacity() { return this.opacity; }
  isDestroyed() { return this.dead; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = { kind: 'run-command', command: 'fixture' };
const countListeners = parent => ['show', 'restore', 'focus', 'closed'].reduce((n, e) => n + parent.listenerCount(e), 0);

test('hidden, minimized and transparent parent wait until show, restore or focus', async () => {
  for (const state of ['hidden', 'minimized', 'transparent']) {
    const parent = new Parent();
    if (state !== 'hidden') parent.visible = true;
    if (state === 'minimized') parent.minimized = true;
    if (state === 'transparent') parent.opacity = 0;
    const manager = new ConsentManager({ parentWindow: parent, ipcMain: {} });
    const before = windows.length;
    try {
      const result = manager.ask(request);
      await tick();
      assert.equal(windows.length, before, state);
      assert.equal(countListeners(parent), 4);
      parent.visible = true; parent.minimized = false; parent.opacity = 1;
      parent.emit(state === 'minimized' ? 'restore' : state === 'hidden' ? 'show' : 'focus');
      await tick();
      assert.equal(windows.length, before + 1);
      assert.equal(windows.at(-1).options.parent, parent);
      assert.equal(countListeners(parent), 0);
      manager.resolve('cancel');
      assert.equal(await result, 'cancel');
    } finally { manager.dispose(); }
  }
});

test('parent replacement rebinds listeners and uses current window', async () => {
  const changes = new EventEmitter(), old = new Parent(), replacement = new Parent();
  let current = old;
  const manager = new ConsentManager({ ipcMain: {}, getParentWindow: () => current,
    subscribeParentChanges: cb => { changes.on('change', cb); return () => changes.removeListener('change', cb); } });
  const before = windows.length;
  try {
    const result = manager.ask(request);
    await tick();
    assert.equal(countListeners(old), 4);
    current = replacement; changes.emit('change');
    assert.equal(countListeners(old), 0);
    assert.equal(countListeners(replacement), 4);
    replacement.visible = true; replacement.emit('show');
    await tick();
    assert.equal(windows.length, before + 1);
    assert.equal(windows.at(-1).options.parent, replacement);
    assert.equal(countListeners(replacement), 0);
    assert.equal(changes.listenerCount('change'), 0);
    manager.resolve('cancel'); assert.equal(await result, 'cancel');
  } finally { manager.dispose(); }
});

test('deadline expires while waiting and dispose cancels wait and cleans listeners', async () => {
  const parent = new Parent();
  const manager = new ConsentManager({ parentWindow: parent, ipcMain: {} });
  const before = windows.length;
  try {
    assert.equal(await manager.ask(request, { timeoutMs: 20 }), 'timeout');
    assert.equal(countListeners(parent), 0);
    assert.equal(windows.length, before);
    const wait = manager.ask(request);
    await tick(); assert.equal(countListeners(parent), 4);
    manager.dispose(); assert.equal(await wait, 'cancel');
    assert.equal(countListeners(parent), 0);
    parent.visible = true; parent.emit('show'); await tick();
    assert.equal(windows.length, before);
  } finally { manager.dispose(); }
});

test('no parent retains existing path; optional hidden mode still requires opacity', async () => {
  const manager = new ConsentManager({ parentWindow: null, ipcMain: {} });
  try {
    const result = manager.ask(request); await tick();
    assert.equal(windows.at(-1).options.parent, undefined);
    manager.resolve('cancel'); assert.equal(await result, 'cancel');
  } finally { manager.dispose(); }
  const parent = new Parent(); parent.opacity = 0;
  const hidden = new ConsentManager({ parentWindow: parent, ipcMain: {}, requireVisible: false });
  const before = windows.length;
  try {
    const result = hidden.ask(request); await tick(); assert.equal(windows.length, before);
    parent.opacity = 1; parent.emit('focus'); await tick();
    assert.equal(windows.length, before + 1);
    hidden.resolve('cancel'); assert.equal(await result, 'cancel');
  } finally { hidden.dispose(); }
});

test('opacity restoration is detected without a window event', async () => {
  const parent = new Parent(); parent.visible = true; parent.opacity = 0;
  const manager = new ConsentManager({ parentWindow: parent, ipcMain: {} });
  const before = windows.length;
  try {
    const result = manager.ask(request, { timeoutMs: 1000 });
    await tick(); parent.opacity = 1;
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(windows.length, before + 1);
    manager.resolve('cancel'); assert.equal(await result, 'cancel');
    assert.equal(countListeners(parent), 0);
  } finally { manager.dispose(); }
});

test('destroying a fixed parent cancels an infinite wait and queued requests', async () => {
  const parent = new Parent();
  const manager = new ConsentManager({ parentWindow: parent, ipcMain: {} });
  const before = windows.length;
  try {
    const first = manager.ask({ kind: 'apply', targets: [] });
    const second = manager.ask(request);
    await tick(); parent.dead = true; parent.emit('closed');
    assert.equal(await first, 'cancel'); assert.equal(await second, 'cancel');
    assert.equal(countListeners(parent), 0); assert.equal(windows.length, before);
  } finally { manager.dispose(); }
});

test('parent is rechecked after wait resumes', async () => {
  const parent = new Parent();
  const manager = new ConsentManager({ parentWindow: parent, ipcMain: {} });
  const before = windows.length;
  try {
    const result = manager.ask(request, { timeoutMs: 1000 });
    await tick(); parent.visible = true; parent.emit('show'); parent.visible = false;
    await tick(); assert.equal(windows.length, before);
    parent.visible = true; parent.emit('show'); await tick();
    assert.equal(windows.length, before + 1);
    manager.resolve('cancel'); assert.equal(await result, 'cancel');
  } finally { manager.dispose(); }
});
