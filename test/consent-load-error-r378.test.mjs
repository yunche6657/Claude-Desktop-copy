import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const windows = [];
let loads = [];

class Window extends EventEmitter {
  constructor() {
    super();
    this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = () => {};
    this.dead = false;
    windows.push(this);
  }
  removeMenu() {}
  loadFile() {
    const action = loads.shift();
    if (action === 'throw') throw new Error('load failed');
    if (action === 'reject') return Promise.reject(new Error('load failed'));
    if (action === 'main-event') {
      this.webContents.emit('did-fail-load', {}, -6, 'failed', 'file:///consent.html', true);
      return Promise.reject(new Error('load failed'));
    }
    return Promise.resolve();
  }
  show() {}
  showInactive() {}
  focus() {}
  isDestroyed() { return this.dead; }
  isFocused() { return false; }
  destroy() { this.dead = true; this.emit('closed'); }
}

let ConsentManager;
try {
  Module._load = function(name, ...args) {
    if (name === 'electron') return { BrowserWindow: Window, app: { isPackaged: true } };
    return originalLoad.call(this, name, ...args);
  };
  ({ ConsentManager } = require('../desktop/consent-manager.cjs'));
} finally {
  Module._load = originalLoad;
}
const { createApprovalExecutor } = require('../desktop/tool-approval.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = { kind: 'run-command', command: 'fixture' };

test('loadFile throws, rejects or reports main-frame failure as error and queue continues', async () => {
  for (const failure of ['throw', 'reject', 'main-event']) {
    loads = [failure, 'ok'];
    const manager = new ConsentManager({ parentWindow: null, ipcMain: {} });
    try {
      const failed = manager.ask(request);
      const next = manager.ask(request);
      assert.equal(await failed, 'error', failure);
      await tick();
      const window = windows.at(-1);
      assert.equal(window.dead, false);
      manager.resolve('allow');
      assert.equal(await next, 'allow');
      assert.equal(window.dead, true);
    } finally { manager.dispose(); }
  }
});

test('subframe failure and user close retain cancellation behavior', async () => {
  const manager = new ConsentManager({ parentWindow: null, ipcMain: {} });
  try {
    loads = ['ok'];
    const failed = manager.ask(request);
    await tick();
    windows.at(-1).webContents.emit('did-fail-load', {}, -6, 'failed', 'file:///frame.html', false);
    assert.equal(await failed, 'cancel');
    loads = ['ok'];
    const closed = manager.ask(request);
    await tick();
    windows.at(-1).destroy();
    assert.equal(await closed, 'cancel');
  } finally { manager.dispose(); }
});

test('prompt load errors prevent command and edit execution without claiming user refusal', async () => {
  for (const name of ['Bash', 'Write']) {
    loads = ['reject'];
    const manager = new ConsentManager({ parentWindow: null, ipcMain: {} });
    let ran = false;
    const events = [];
    try {
      const execute = createApprovalExecutor({
        mode: 'ask', ask: request => manager.ask(request),
        tools: [{ name, handler: async () => { ran = true; return { content: 'ran' }; } }],
        onEvent: event => events.push(event),
      });
      const result = await execute({ name, input: { path: 'fixture', command: 'fixture' } });
      assert.equal(ran, false);
      assert.equal(result.isError, true);
      assert.match(result.content, /approval prompt failed/i);
      assert.doesNotMatch(result.content, /user declined/i);
      assert.equal(events.find(event => event.type === 'tool_denied').decision, 'error');
    } finally { manager.dispose(); }
  }
});

test('approval callback rejection is reported as a prompt failure', async () => {
  let ran = false;
  const execute = createApprovalExecutor({
    mode: 'ask', ask: async () => { throw new Error('unavailable'); },
    tools: [{ name: 'Write', handler: async () => { ran = true; } }],
  });
  const result = await execute({ name: 'Write', input: { path: 'fixture' } });
  assert.equal(ran, false);
  assert.match(result.content, /approval prompt failed/i);
});
