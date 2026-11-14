import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createNotificationService } = require('../desktop/notification-service.cjs');

test('notification attribution and group IDs match fixed upstream helpers', () => {
  const source = readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
  const helperText = source.match(/var dkr=\/\^\[A-Za-z0-9_-\].*?function gkr\(\)/s)?.[0].replace(/function gkr\(\)$/, '');
  const groups = source.match(/function aH\(e\).*?function Ikr\(e\)/s)?.[0].replace(/function Ikr\(e\)$/, '');
  assert.ok(helperText && groups);
  const original = vm.runInNewContext(`${helperText};${groups};({ nH, hkr, Fkr })`, { f: require('node:crypto') });
  const made = [];
  class Fake extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; made.push(this); }
    show() {}
    close() { this.emit('close'); }
  }
  const navigations = [];
  const service = createNotificationService({ Notification: Fake, now: () => 100, onNavigate: (...args) => navigations.push(args) });
  const cases = [
    ['tag-sgrp_alpha', { sessionId: 'valid', sessionGroupingId: 'sgrp_alpha' }],
    ['tag-valid', { sessionId: 'valid', sessionGroupingId: 'invalid' }],
    ['unrelated', { sessionId: 'valid', sessionGroupingId: 'chan_example' }],
    [undefined, { sessionId: 'valid', sessionGroupingId: 'chan_example' }],
    ['x'.repeat(80), { sessionId: 'bad value', sessionGroupingId: 'sgrp_ok' }],
  ];
  for (const [tag, attribution] of cases) {
    service.show('title', 'body', tag, '/target', 'unexpected', attribution);
    const options = made.at(-1).options;
    const filtered = original.nH(attribution);
    const group = original.Fkr(tag, filtered);
    assert.equal(options.id, original.hkr(tag ?? 'notification-100'));
    assert.equal(options.groupId, group === undefined ? undefined : original.hkr(group));
    made.at(-1).emit('click');
    assert.equal(navigations.at(-1)[0], '/target');
    assert.deepEqual(navigations.at(-1)[1], { notificationType: 'generic', ...filtered });
  }
});

test('repeated tag replaces notification and click invokes only latest navigation', () => {
  const made = [];
  class Fake extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; made.push(this); }
    show() {}
    close() { this.closed = true; this.emit('close'); }
  }
  const navigated = [];
  const service = createNotificationService({ Notification: Fake, onNavigate: path => navigated.push(path) });
  service.show('first', 'body', 'same', '/first');
  service.show('second', 'body', 'same', '/second');
  assert.equal(made[0].closed, true);
  assert.equal(service.activeCount(), 1);
  made[1].emit('click');
  assert.deepEqual(navigated, ['/second']);
  assert.equal(service.activeCount(), 0);
  made[1].emit('click');
  assert.deepEqual(navigated, ['/second']);
});

test('replacement and terminal events follow upstream callback ownership', () => {
  const source = readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
  const start = source.indexOf('showNotification(e,t,n,r,i=');
  const end = source.indexOf('supportsNotificationActions(){', start);
  assert.ok(start >= 0 && end > start);
  const method = source.slice(start, end);
  function originalHarness() {
    const items = [];
    const backend = { show: (options, interaction, lifecycle) => {
      let settled = false;
      items.push({ options, interaction, lifecycle: event => { if (!settled) { settled = true; lifecycle(event); } } });
    } };
    const show = vm.runInNewContext(`({${method}}).showNotification`, {
      nH: x => x, Pkr: () => undefined, Fkr: () => undefined,
      rkr: () => false, Lkr: () => false, Q: () => {}, N: { debug() {} },
      rH: backend, performance: { now: () => 0 },
    });
    const owner = {
      isInitialized: true, useSwiftNotifications: false,
      pendingActionCallbacks: new Map(), pendingClickCallbacks: new Map(),
      actionBannerDeliveredAt: new Map(), shownNotificationTags: new Set(),
      remoteTurnEndLoudByTag: new Map(), releaseRemoteAttention() {},
      electronLifecycleLogger(_data, failed) { return event => { if (event.event === 'failed') failed(); }; },
      reachabilityProps: () => ({}),
    };
    const calls = [];
    return {
      calls, items,
      show(route) { show.call(owner, 'title', 'body', 'same', route ? () => calls.push(route) : undefined); },
      click(index) { items[index].interaction?.({ action: 'click' }); },
      close(index) { items[index].interaction?.({ action: 'close' }); },
      fail(index) { items[index].lifecycle({ event: 'failed', errorKind: 'unknown' }); },
      display(index) { items[index].lifecycle({ event: 'displayed' }); },
    };
  }
  function replicaHarness() {
    const items = [];
    const calls = [];
    class Fake extends EventEmitter {
      static isSupported() { return true; }
      constructor() { super(); items.push(this); }
      show() {}
      close() { this.emit('close'); }
    }
    const service = createNotificationService({ Notification: Fake, onNavigate: route => calls.push(route) });
    return {
      calls, items,
      show(route) { service.show('title', 'body', 'same', route); },
      click(index) { items[index].emit('click'); },
      close(index) { items[index].emit('close'); },
      fail(index) { items[index].emit('failed', {}, 'unknown'); },
      display(index) { items[index].emit('show'); },
    };
  }
  const scenarios = [
    h => { h.show('/old'); h.show(undefined); h.click(1); },
    h => { h.show('/old'); h.close(0); h.click(0); },
    h => { h.show('/old'); h.fail(0); h.click(0); },
    h => { h.show('/old'); h.show('/new'); h.fail(0); h.click(1); },
    h => { h.show('/old'); h.display(0); h.fail(0); h.click(0); },
  ];
  for (const scenario of scenarios) {
    const original = originalHarness();
    const replica = replicaHarness();
    scenario(original);
    scenario(replica);
    assert.deepEqual(replica.calls, original.calls);
  }
});
