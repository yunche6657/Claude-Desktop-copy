import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { createNotificationService } = require('../desktop/notification-service.cjs');

test('bridge matches the fixed 2.42304 main handler positional and void contract', async () => {
  const source = readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
  const match = source.match(/showNotification:(\(e,t,n,r,i,a\)=>\{sH\.showNotification\(e,t,n,l\(r\),tH\(i\),nH\(a\)\)\})/);
  assert.ok(match, 'fixed upstream notification handler not found');
  const originalCalls = [];
  const original = vm.runInNewContext(match[1], {
    sH: { showNotification: (...args) => { originalCalls.push(args); return 'ignored'; } },
    l: x => x, tH: x => x, nH: x => x,
  });
  const handlers = new Map();
  const actualCalls = [];
  registerBridgeServices({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: () => {} },
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => null,
    settings: { showNotification: (...args) => { actualCalls.push(args); return 'ignored'; } },
    frontend: { root: process.cwd() },
  });
  const entry = [...handlers].find(([channel]) => channel.endsWith('_$_DesktopNotifications_$_showNotification'));
  assert.ok(entry);
  const args = ['title', 'body', 'tag', '/chat/example', 'generic', { sessionId: 'fixture' }];
  assert.equal(original(...args), undefined);
  assert.equal(await entry[1]({}, ...args), undefined);
  assert.deepEqual(actualCalls[0], originalCalls[0]);
});

test('fake notifications attach listeners before show and release on terminal events', () => {
  const created = [];
  const results = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; created.push(this); }
    show() {
      assert.equal(this.listenerCount('show'), 1);
      assert.equal(this.listenerCount('failed'), 1);
    }
  }
  const service = createNotificationService({ Notification: FakeNotification, onResult: (...args) => results.push(args) });
  assert.equal(service.show('title', 'body', 'tag'), undefined);
  assert.deepEqual(created[0].options, { title: 'title', body: 'body', id: 'tag', silent: false, urgency: 'normal' });
  assert.equal(service.activeCount(), 1);
  created[0].emit('show');
  assert.equal(results[0][0], 'show');
  assert.equal(service.activeCount(), 1);
  created[0].emit('close');
  assert.equal(service.activeCount(), 0);
  service.show('other', 'body');
  created[1].emit('failed', {}, 'fixture error');
  assert.deepEqual(results[1].slice(0, 2), ['failed', 'fixture error']);
  assert.equal(service.activeCount(), 0);
  service.show('other', 'body');
  created[2].emit('click');
  assert.equal(service.activeCount(), 0);
});

test('fake unsupported and synchronous failure are reported without throwing', () => {
  const results = [];
  const unsupported = createNotificationService({ Notification: { isSupported: () => false }, onResult: event => results.push(event) });
  assert.equal(unsupported.show('a', 'b'), undefined);
  class Broken extends EventEmitter {
    static isSupported() { return true; }
    show() { throw Error('fixture'); }
  }
  const broken = createNotificationService({ Notification: Broken, onResult: event => results.push(event) });
  assert.equal(broken.show('a', 'b'), undefined);
  assert.equal(broken.activeCount(), 0);
  assert.deepEqual(results, ['unsupported', 'failed']);
});
