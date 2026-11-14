'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('a rejecting backend cannot silently dispatch ordinary queued user input', async (t) => {
  const firstEntered = Promise.withResolvers();
  const rejectFirst = Promise.withResolvers();
  const requests = [], events = [];
  const listeners = new Set();
  const backend = {
    id: 'ccb',
    start() {},
    cancel() {},
    dispose() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async sendMessage(_id, text) {
      const first = requests.length === 0;
      requests.push(text);
      if (first) {
        firstEntered.resolve();
        await rejectFirst.promise;
        throw new Error('fixture CCB transport rejection');
      }
      return { text: 'unexpected send', stopReason: 'end_turn' };
    },
  };
  const kernel = createSessionKernel({
    backend,
    emit: (e) => events.push(e),
    readFeatureValue: (key, fallback) => key === '4122449738' ? true : fallback,
    readFeatureOn: (key, fallback) => key === '4122449738' ? false : fallback,
  });
  t.after(() => { rejectFirst.resolve(); kernel.dispose(); });

  const { sessionId } = kernel.start({});
  const first = kernel.sendMessage(sessionId, 'first');
  await firstEntered.promise;
  await kernel.sendMessage(sessionId, 'second', {
    messageUuid: B, deferIfBusy: true, plainInput: true,
  });

  rejectFirst.resolve();
  const outcome = await first;
  assert.equal(outcome.ok, false);
  await tick();
  await tick();

  assert.deepEqual(requests, ['first'], 'ordinary queued text must not auto-send after backend rejection');
  assert.ok(kernel.getQueuedMessages(sessionId).some((row) => row.uuid === B),
    'the held UUID must remain queryable for withdrawal or explicit promotion');
  assert.deepEqual(kernel.getSession(sessionId).sendsHeldAfterError, [B],
    'the session must announce the held input after a transport-level failure');
});
test('a success result frame without completed backend lifecycle cannot release the next user send', async t => {
  const entered = Promise.withResolvers();
  const dropTransport = Promise.withResolvers();
  const requests = [], listeners = new Set();
  const backend = {
    id: 'ccb', start() {}, cancel() {}, dispose() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async sendMessage(sessionId, message) {
      const first = requests.length === 0;
      requests.push(message);
      if (first) {
        entered.resolve();
        await dropTransport.promise;
        for (const fn of listeners) {
          fn({ type: 'raw', sessionId, frame: {
            type: 'result', subtype: 'success', is_error: false,
            uuid: crypto.randomUUID(), result: 'the model emitted a successful frame',
          } });
        }
        throw new Error('fixture CLI exited before turn settlement');
      }
      return { text: 'unexpected send', stopReason: 'end_turn' };
    },
  };
  const kernel = createSessionKernel({
    backend,
    emit() {},
    readFeatureValue: (key, fallback) => key === '4122449738' ? true : fallback,
    readFeatureOn: (key, fallback) => key === '4122449738' ? false : fallback,
  });
  t.after(() => { dropTransport.resolve(); kernel.dispose(); });
  const { sessionId } = kernel.start({});
  const active = kernel.sendMessage(sessionId, 'active');
  await entered.promise;
  await kernel.sendMessage(sessionId, 'queued after active', {
    messageUuid: B, deferIfBusy: true, plainInput: true,
  });
  dropTransport.resolve();
  assert.equal((await active).ok, false);
  await tick();
  await tick();
  assert.deepEqual(requests, ['active'],
    'the next user send must not auto-dispatch solely because a result frame was healthy');
  assert.deepEqual(kernel.getSession(sessionId).sendsHeldAfterError, [B]);
});

