import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createKeepAwakeClaims } = require('../desktop/keep-awake-claims.cjs');
const { bindKeepAwakePreference } = require('../desktop/keep-awake-preference.cjs');
const source = readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
const start = source.indexOf('var oV=new Set,sV=null;function vCr(');
const end = source.indexOf('var CCr="confirm_"', start);
assert.ok(start >= 0 && end > start);

function harness(original, initial = false) {
  const actions = [], prefs = new EventEmitter(), callbacks = new Set();
  let value = initial, allowed = true, id = 0;
  prefs.get = () => value;
  const blocker = { start: kind => { actions.push(['start', kind]); return ++id; }, stop: blockerId => actions.push(['stop', blockerId]) };
  const subscribePolicy = callback => { callbacks.add(callback); return () => callbacks.delete(callback); };
  let claims, binding;
  if (original) {
    const ctx = { a: { powerSaveBlocker: blocker }, $B: () => allowed, fKe: () => actions.push(['beforeStop']),
      N: { info() {} }, bv: prefs, yv: prefs.get, Hu: subscribePolicy };
    const native = vm.runInNewContext(source.slice(start, end) + ';({bind:SCr, claim:cV, release:lV})', ctx);
    native.bind(); claims = native;
  } else {
    claims = createKeepAwakeClaims({ powerSaveBlocker: blocker, isAllowed: () => allowed, beforeStop: () => actions.push(['beforeStop']) });
    binding = bindKeepAwakePreference({ preferences: prefs, claims, subscribePolicy });
  }
  return { actions, prefs, callbacks, claims, binding,
    pref: next => { value = next; prefs.emit('keepAwakeEnabled', next); },
    policy: next => { allowed = next; for (const callback of callbacks) callback(); } };
}

test('global user claim and managed gate match fixed original including shared session claims', () => {
  const native = harness(true), replica = harness(false);
  for (const h of [native, replica]) {
    h.pref(true); h.claims.claim('code_turn'); h.policy(false); h.pref(false);
    h.pref(true); h.policy(true); h.pref(false); h.claims.release('code_turn');
    h.pref('true'); h.pref(true); h.policy(false); h.policy(true); h.pref(false);
  }
  assert.deepEqual(replica.actions, native.actions);
  assert.deepEqual(replica.actions, [
    ['start','prevent-app-suspension'], ['beforeStop'], ['stop',1],
    ['start','prevent-app-suspension'], ['beforeStop'], ['stop',2],
    ['start','prevent-app-suspension'], ['beforeStop'], ['stop',3],
    ['start','prevent-app-suspension'], ['beforeStop'], ['stop',4],
  ]);
});

test('initial persisted true preference claims immediately', () => {
  const native = harness(true, true), replica = harness(false, true);
  assert.deepEqual(replica.actions, native.actions);
  assert.deepEqual(replica.actions, [['start','prevent-app-suspension']]);
  replica.binding.dispose();
});

test('disposal releases only the preference claim and removes both subscriptions', () => {
  const h = harness(false);
  h.pref(true); h.claims.claim('code_turn'); h.binding.dispose(); h.binding.dispose();
  assert.equal(h.prefs.listenerCount('keepAwakeEnabled'), 0); assert.equal(h.callbacks.size, 0);
  assert.equal(h.claims.isBlocking(), true);
  h.claims.release('code_turn'); assert.equal(h.claims.isBlocking(), false);
});

test('binding fails closed if the policy update source is missing or invalid', () => {
  const preferences = new EventEmitter(); preferences.get = () => true;
  const calls = [];
  const claims = { claim: x => calls.push(x), release() {}, reconcile() {} };
  assert.throws(() => bindKeepAwakePreference({ preferences, claims, subscribePolicy: () => undefined }), /unsubscribe/);
  assert.equal(preferences.listenerCount('keepAwakeEnabled'), 0); assert.deepEqual(calls, []);
});
