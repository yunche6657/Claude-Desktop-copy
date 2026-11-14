import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createNotificationService } = require('../desktop/notification-service.cjs');
const source = readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');

function fixture(original, levels, elsewhere = () => false) {
  const notes = [];
  const navigation = [];
  let time = 100;
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = JSON.parse(JSON.stringify(options)); notes.push(this); }
    show() { this.emit('show'); }
    close() { this.closed = true; this.emit('close'); }
  }
  if (!original) {
    const service = createNotificationService({ Notification: FakeNotification, now: () => time,
      getNotificationLevel: key => levels[key], notifiedElsewhere: elsewhere,
      onNavigate: path => navigation.push(path) });
    return { notes, navigation, show: (...args) => service.show(...args), tick: () => time++ };
  }
  const backendStart = source.indexOf('var rH=new class{');
  const backendEnd = source.indexOf('},_kr=5e3;', backendStart);
  const methodStart = source.indexOf('showNotification(e,t,n,r,i="generic",a,o,s){');
  const methodEnd = source.indexOf('supportsNotificationActions(){', methodStart);
  assert.ok(backendStart >= 0 && backendEnd > backendStart && methodStart >= 0 && methodEnd > methodStart);
  const clock = { now: () => time };
  const context = { a: { Notification: FakeNotification, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, app: {} },
    f: require('node:crypto'), n: { default: require('node:path') }, __dirname: '.', Date: clock,
    process: { platform: 'win32' }, N: { warn() {}, debug() {}, error() {} }, Ee() {},
    hkr: value => value, gkr: () => '', ukr: () => 'unknown',
    nH: value => value, Pkr: () => undefined, Fkr: () => undefined,
    rkr: type => ['remote_idle', 'remote_turn_complete', 'remote_requires_action'].includes(type),
    iH: key => ({ banner: levels[key] === 'banner', badge: levels[key] !== 'off' }),
    Lkr: () => false, Q() {}, oH: null };
  const backend = vm.runInNewContext(`${source.slice(backendStart, backendEnd + 1)}; rH`, context);
  context.rH = backend;
  const method = vm.runInNewContext(`({${source.slice(methodStart, methodEnd)}}).showNotification`, context);
  const service = { isInitialized: true, useSwiftNotifications: false, pendingActionCallbacks: new Map(),
    actionBannerDeliveredAt: new Map(), pendingClickCallbacks: new Map(), shownNotificationTags: new Set(),
    remoteTurnEndLoudByTag: new Map(), remoteAttentionTags: new Set(), notifiedElsewhere: elsewhere,
    requestUserAttention: () => false, releaseRemoteAttention() {}, reachabilityProps: () => ({}),
    electronLifecycleLogger: () => () => {} };
  return { notes, navigation, tick: () => time++, show: (title, body, tag, path, type, attribution) =>
    method.call(service, title, body, tag, path ? () => navigation.push(path) : undefined, type, attribution) };
}

function snapshot(f) {
  return { notes: f.notes.map(note => ({ ...note.options, closed: !!note.closed })), navigation: f.navigation };
}

test('fixed upstream and service match remote level, elsewhere and replacement behavior', () => {
  for (const levels of [{ idle: 'banner', permission: 'banner' }, { idle: 'off', permission: 'badge' }, { idle: 'badge', permission: 'banner' }]) {
    const run = original => {
      const f = fixture(original, levels, id => id === 'elsewhere');
      f.show('idle', 'body', 'shared', '/first', 'remote_idle', { sessionId: 'local' });
      f.show('complete', 'body', 'shared', '/second', 'remote_turn_complete', { sessionId: 'local' });
      f.show('permission', 'body', 'permission', '/third', 'remote_requires_action', { sessionId: 'local' });
      f.show('duplicate', 'body', 'other', '/other', 'generic', { sessionId: 'elsewhere' });
      f.show('channel', 'body', 'channel', '/channel', 'channel_message');
      for (const note of f.notes.filter(note => !note.closed)) note.emit('click');
      return snapshot(f);
    };
    assert.deepEqual(run(false), run(true));
  }
});

test('fixed upstream and service match empty tag and same-time generated tags', () => {
  const run = original => {
    const f = fixture(original, { idle: 'banner', permission: 'banner' });
    f.show('one', '', '', '/one');
    f.show('two', '', '', '/two');
    f.show('three', '', undefined, '/three');
    f.show('four', '', undefined, '/four');
    f.tick();
    f.show('five', '', undefined, '/five');
    return snapshot(f);
  };
  assert.deepEqual(run(false), run(true));
});

test('fixed upstream and service retry empty or failed icon loads and cache a valid icon', () => {
  function run(original) {
    const notes = [];
    let attempts = 0;
    const valid = { isEmpty: () => false, name: 'fixture icon' };
    const load = () => {
      attempts++;
      if (attempts === 1) throw Error('fixture');
      if (attempts === 2) return { isEmpty: () => true };
      return valid;
    };
    class FakeNotification extends EventEmitter {
      static isSupported() { return true; }
      constructor(options) { super(); notes.push(options); }
      show() {}
    }
    let show;
    if (original) {
      const start = source.indexOf('var rH=new class{');
      const end = source.indexOf('},_kr=5e3;', start);
      const backend = vm.runInNewContext(`${source.slice(start, end + 1)}; rH`, {
        a: { Notification: FakeNotification, nativeImage: { createFromPath: load } },
        gkr: () => 'fixture', hkr: value => value, process: { platform: 'win32' },
        N: { warn() {}, error() {} }, Ee() {}, ukr: () => 'unknown',
      });
      show = tag => backend.show({ title: 'title', body: 'body', tag });
    } else {
      const service = createNotificationService({ Notification: FakeNotification, getAppIcon: load });
      show = tag => service.show('title', 'body', tag);
    }
    for (const tag of ['one', 'two', 'three', 'four']) show(tag);
    return { attempts, icons: notes.map(note => note.icon?.name ?? null) };
  }
  assert.deepEqual(run(false), run(true));
  assert.deepEqual(run(false), { attempts: 3, icons: [null, null, 'fixture icon', 'fixture icon'] });
});
