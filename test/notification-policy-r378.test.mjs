import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createNotificationPolicy } = require('../desktop/notification-policy.cjs');
const { createNotificationService } = require('../desktop/notification-service.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

test('notification policy matches fixed original signals and sound', () => {
  const source = readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
  const start = source.indexOf('kkr="879583975",Akr=40,jkr=');
  const end = source.indexOf('function aH(', start);
  const soundStart = source.indexOf('function Lkr(){', end);
  const soundEnd = source.indexOf('var Rkr=', soundStart);
  assert.ok(start >= 0 && end > start && soundStart > end && soundEnd > soundStart);
  let preferences = {};
  let enabled = false;
  const ctx = { yv: key => preferences[key], ey: () => enabled };
  const original = vm.runInNewContext(`var ${source.slice(start, end)}${source.slice(soundStart, soundEnd)}; ({iH,Lkr})`, ctx);
  const policy = createNotificationPolicy({ getPreferences: () => preferences, getFeatureValue: () => enabled });
  for (const gate of [false, true]) for (const level of [undefined, 'off', 'badge', 'banner']) {
    enabled = gate;
    preferences = { notificationLevels: { permission: level }, notificationSound: gate ? 'none' : 'system' };
    assert.deepEqual({ ...policy.getSignals('permission') }, { ...original.iH('permission') });
    assert.equal(policy.getSilent(), original.Lkr());
  }
});

test('live bridge preference updates affect fake notification policy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notification-policy-'));
  const handlers = new Map();
  const settings = { dataDir: dir };
  const bridge = registerBridgeServices({ ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler() {} },
    bridgeMap: require('../desktop/shim/bridge-map.json'), getMainWindow: () => null, settings, frontend: { root: process.cwd() } });
  try {
    const set = [...handlers].find(([key]) => key.endsWith('_$_AppPreferences_$_setPreference'))[1];
    const notes = [];
    class FakeNotification extends EventEmitter {
      static isSupported() { return true; }
      constructor(options) { super(); notes.push(options); }
      show() {}
    }
    const policy = createNotificationPolicy({ getPreferences: () => settings.preferences });
    const service = createNotificationService({ Notification: FakeNotification, ...policy });
    await set({}, 'notificationLevels', { idle: 'off', permission: 'banner' });
    await set({}, 'notificationSound', 'none');
    service.show('suppressed', '', 'one', null, 'remote_idle');
    service.show('allowed', '', 'two', null, 'remote_requires_action');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].silent, true);
    await set({}, 'notificationLevels', { idle: 'banner', permission: 'off' });
    await set({}, 'notificationSound', 'system');
    service.show('allowed', '', 'three', null, 'remote_idle');
    service.show('suppressed', '', 'four', null, 'remote_requires_action');
    assert.equal(notes.length, 2);
    assert.equal(notes[1].silent, false);
  } finally {
    await bridge.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
