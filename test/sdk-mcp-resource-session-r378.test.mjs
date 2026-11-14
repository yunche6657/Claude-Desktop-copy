import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSdkResourceSession } = require('../desktop/sdk-mcp-resource-session.cjs');

test('concurrent requests with identical client ids get independent server ids', async () => {
  const pending = [];
  const session = createSdkResourceSession({ dispatch(message) { return new Promise(resolve => pending.push({ message, resolve })); } });
  const ccb = session.ccb({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  const host = session.read('ui://alpha/page', 4);
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(pending[0].message.id, pending[1].message.id);
  pending[1].resolve({ jsonrpc: '2.0', id: pending[1].message.id, result: { text: 'host' } });
  pending[0].resolve({ jsonrpc: '2.0', id: pending[0].message.id, result: { text: 'ccb' } });
  assert.deepEqual(await host, { jsonrpc: '2.0', id: 4, result: { text: 'host' } });
  assert.deepEqual(await ccb, { jsonrpc: '2.0', id: 4, result: { text: 'ccb' } });
  session.close();
});

test('close rejects in-flight operations and does not affect another session', async () => {
  let finish;
  const alpha = createSdkResourceSession({ dispatch() { return new Promise(resolve => { finish = resolve; }); } });
  const beta = createSdkResourceSession({ dispatch(m) { return { jsonrpc: '2.0', id: m.id, result: 'beta' }; } });
  const waiting = alpha.read('ui://alpha');
  await new Promise(resolve => setImmediate(resolve));
  alpha.close();
  await assert.rejects(waiting, /closed/);
  finish({ jsonrpc: '2.0', id: 1, result: 'late' });
  await assert.rejects(alpha.read('ui://alpha'), /closed/);
  assert.equal((await beta.read('ui://beta')).result, 'beta');
  beta.close();
});

test('notifications preserve session destination and malformed responses fail', async () => {
  const notifications = [];
  const alpha = createSdkResourceSession({ dispatch: m => ({ jsonrpc: '2.0', id: m.id + 1 }), notifyClient: m => notifications.push(m.method) });
  alpha.notification({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  assert.deepEqual(notifications, ['notifications/tools/list_changed']);
  await assert.rejects(alpha.read('ui://alpha'), /invalid response/);
  alpha.close();
  assert.throws(() => alpha.notification({}), /closed/);
});

test('cancellation maps the CCB id without cancelling a host request with the same server id', async () => {
  const messages = [];
  const session = createSdkResourceSession({ dispatch(message, origin) {
    messages.push({ message, origin });
    if (Object.hasOwn(message, 'id')) return new Promise(() => {});
  } });
  const host = session.read('ui://alpha', 999);
  const ccb = session.ccb({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const settlement = Promise.allSettled([host, ccb]);
  await session.ccb({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'test' } });
  assert.equal(messages[0].message.id, 1);
  assert.equal(messages[1].message.id, 2);
  assert.equal(messages[2].message.params.requestId, 2);
  assert.equal(messages[2].message.params.reason, 'test');
  await session.ccb({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } });
  assert.equal(messages.length, 3);
  session.close();
  await settlement;
});

test('close immediately after request prevents the queued dispatch', async () => {
  let dispatched = 0;
  const session = createSdkResourceSession({ dispatch() { dispatched++; } });
  const request = session.read('ui://alpha');
  session.close();
  await assert.rejects(request, /closed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatched, 0);
});
