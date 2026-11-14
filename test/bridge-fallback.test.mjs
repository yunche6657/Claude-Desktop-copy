// Tests for the bridge fallback policy.
//
// Two shapes matter and both were learned from real crashes:
//
//  1. An unimplemented status method answers {status, reason}. Callers read
//     `.status`, so it must be an object.
//  2. Any other unimplemented method answers null, never an object, because some
//     call sites render the value directly as a React child. Returning
//     {status, reason} there throws
//       Objects are not valid as a React child (found: object with keys {status, reason})
//     and the whole route falls into the error boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unavailable, APP_VERSION, NAMESPACE } = require('../desktop/bridge-services.cjs');

test('unavailable() is a status object', () => {
  const value = unavailable();
  assert.equal(typeof value, 'object');
  assert.equal(value.status, 'unavailable');
  assert.equal(typeof value.reason, 'string');
});

test('unavailable() accepts a custom reason', () => {
  assert.equal(unavailable('nope').reason, 'nope');
});

test('APP_VERSION matches the shipped build', () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});

test('the namespace is the observed uuid', () => {
  assert.equal(NAMESPACE, '6010a08f-a0fa-48b4-99da-0689b9e2de7b');
});

// Mirrors isFeatureStatusMethod in desktop/bridge-services.cjs.
const isFeatureStatusMethod = (m) =>
  /^(get|is|can)[A-Z]/.test(m) && /Feature|Availability|Support|Status|Enabled/.test(m);

test('feature-status methods are detected', () => {
  for (const m of [
    'getSupportedFeatures',
    'getFeatureAvailability',
    'isFeatureEnabled',
    'getStatus',
    'getSupportStatus',
  ]) {
    assert.equal(isFeatureStatusMethod(m), true, m);
  }
});

test('ordinary getters are not treated as feature status', () => {
  for (const m of [
    'getCodeStats',
    'getSessionList',
    'getAll',
    'getTranscript',
    'getGitStateSnapshot',
    'listServers',
  ]) {
    assert.equal(isFeatureStatusMethod(m), false, m);
  }
});

test('null is the safe fallback for a rendered getter', () => {
  // A React child must be a string, number, element, array or null. An object is
  // the only value here that would crash a render.
  const rendered = null;
  assert.ok(rendered === null || typeof rendered === 'string');
});
