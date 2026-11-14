import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { storeChannel, createStoreBridge, registerServiceStore } = require('../desktop/service-store.cjs');

function transport(getState) {
  const handlers = new Map();
  const main = new EventEmitter();
  const renderer = new EventEmitter();
  main.handle = (channel, fn) => handlers.set(channel, fn);
  main.removeHandler = channel => handlers.delete(channel);
  renderer.invoke = async channel => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error('No handler: ' + channel);
    return fn({});
  };
  renderer.sendSync = channel => { const event = {}; main.emit(channel, event); return event.returnValue; };
  const service = registerServiceStore({ ipcMain: main, domain: 'claude.web', service: 'Launch', name: 'activeServers',
    getState, send: (channel, state) => renderer.emit(channel, {}, state) });
  return { main, renderer, service, bridge: createStoreBridge(renderer, 'claude.web', 'Launch', 'activeServers') };
}

test('Launch store uses the captured preload channel including update message prefix', () => {
  assert.equal(storeChannel('claude.web', 'Launch', 'activeServers', 'update'),
    '$eipc_message$_6010a08f-a0fa-48b4-99da-0689b9e2de7b_$_claude.web_$_Launch_$_activeServers_$store$_update');
});

test('snapshots and subscriptions carry server state and detach without losing other subscribers', async () => {
  let state = [];
  const t = transport(() => structuredClone(state));
  try {
    assert.deepEqual(await t.bridge.getState(), []);
    assert.deepEqual(t.bridge.getStateSync(), []);
    const first = [], second = [];
    const detach = t.bridge.onStateChange(s => first.push(s));
    const detachSecond = t.bridge.onStateChange(s => second.push(s));
    state = [{ serverId: 'actual-server', port: 43210, status: 'running' }];
    t.service.publish();
    detach();
    state[0].status = 'stopped';
    t.service.publish();
    assert.equal(first.length, 1);
    assert.equal(first[0][0].status, 'running');
    assert.equal(second.length, 2);
    assert.equal(second[1][0].status, 'stopped');
    assert.deepEqual(await t.bridge.getState(), state);
    detachSecond();
  } finally { t.service.dispose(); }
});

test('store disposal removes its own listeners and fails future reads explicitly', async () => {
  const t = transport(() => []);
  t.service.dispose(); t.service.dispose();
  assert.equal(t.service.publish(), false);
  assert.throws(() => t.bridge.getStateSync(), /No reply/);
  await assert.rejects(t.bridge.getState(), /No handler/);
  assert.equal(t.main.listenerCount(storeChannel('claude.web', 'Launch', 'activeServers', 'getStateSync')), 0);
});

test('store read errors reach async and sync consumers instead of pretending ready', async () => {
  const t = transport(() => { throw new Error('snapshot unavailable'); });
  try {
    await assert.rejects(t.bridge.getState(), /snapshot unavailable/);
    assert.throws(() => t.bridge.getStateSync(), /snapshot unavailable/);
  } finally { t.service.dispose(); }
});
