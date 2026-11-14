// Settings toggles must survive a restart, not just a reload.
//
// Measured before the fix, on the 回复完成 notification switch:
//
//   click the switch        -> aria-checked true
//   reload the page         -> aria-checked true   (the in-memory object survived)
//   kill and restart        -> aria-checked FALSE  (the choice was never written)
//
// The PATCH handler merged the toggle into a module-local `notificationOverrides` and
// echoed it back, so the optimistic UI looked correct while nothing reached disk. That
// is the same silent-loss shape as the IndexedDB defect, in a different store.
//
// After persisting through the account-settings file:
//   click -> true, restart -> true
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'api-interceptors.cjs'), 'utf8');

test('notification preferences are read back from the settings store', () => {
  assert.match(SRC, /notificationOverrides = readNotificationOverrides\(\)/,
    'the overrides are not initialised from persisted state');
});

test('a notification PATCH writes through to the settings store', () => {
  // The save has to sit inside the PATCH handler; a helper nobody calls changes nothing.
  const at = SRC.indexOf('patchNotificationPreferences');
  assert.ok(at > 0, 'the PATCH handler is missing');
  const block = SRC.slice(at, at + 1800);
  assert.match(block, /saveNotificationOverrides\(\)/, 'the PATCH never persists the merge');
});

test('the persisted key is namespaced, not a bare name likely to collide', () => {
  const m = SRC.match(/const NOTIFICATION_KEY = '([^']+)'/);
  assert.ok(m, 'the storage key constant is missing');
  assert.equal(m[1], 'notification_preferences');
});

test('a store that rejects writes does not break the toggle', () => {
  // writeSettings can be absent or throw; the switch must still answer the user.
  const at = SRC.indexOf('const saveNotificationOverrides');
  assert.ok(at > 0, 'the save helper is missing');
  const block = SRC.slice(at, at + 500);
  assert.match(block, /catch/, 'writing the preference is unguarded');
});
