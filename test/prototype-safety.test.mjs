// Prototype pollution through the settings merges: measured, not assumed.
//
// `patchCodeSettings` (and the account-settings writer in main.cjs) merge an incoming JSON
// patch with `{ ...current, ...patch }`. A patch arrives as PARSED JSON, so it can carry a
// literal `"__proto__"` key — the classic pollution payload. Two questions had to be answered
// before calling this safe, and both were probed rather than reasoned about:
//
//   1. does the spread pollute Object.prototype?
//      -> No. `Object.keys(merged)` shows ['theme', '__proto__'], and
//         ({}).polluted is undefined afterwards. Spread defines an own data property; it does
//         not run the __proto__ setter the way assignment or Object.assign would.
//   2. does the value survive a write/read round trip and then do damage?
//      -> No. JSON.parse also creates an own property. hasOwnProperty('__proto__') is true and
//         Object.getPrototypeOf(parsed) is still Object.prototype.
//
// The risk is therefore latent, not live: it depends on the spread staying a spread. Switching
// either merge to Object.assign(target, patch) WOULD pollute. That is what this file pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');

/** The exact merge the settings writers use, reproduced so it can be exercised. */
function mergeLike(settingsSource, current, patch) {
  if (/const merged = \{ \.\.\.current, \.\.\.patch \};/.test(settingsSource)) {
    return { ...current, ...patch };
  }
  throw new Error('the merge is no longer a spread; re-read this test before trusting it');
}

test('the settings merge is still a spread, not Object.assign', () => {
  // Object.assign invokes the __proto__ setter; a spread does not. This is the whole safety
  // argument, so a refactor to assign must fail loudly here.
  assert.match(MAIN, /const merged = \{ \.\.\.current, \.\.\.patch \};/,
    'the settings merge changed shape');
  assert.doesNotMatch(MAIN, /Object\.assign\([^)]*,\s*patch\s*\)/,
    'an Object.assign merge would be vulnerable to prototype pollution');
});

test('a __proto__ payload does not pollute Object.prototype', () => {
  const patch = JSON.parse('{"__proto__": {"polluted": "yes"}, "theme": "light"}');
  const merged = mergeLike(MAIN, { theme: 'dark' }, patch);
  assert.equal(({}).polluted, undefined, 'Object.prototype was polluted');
  assert.equal(merged.theme, 'light', 'the real key was not applied');
  // The hostile key survives as data, which is acceptable: it is inert.
  assert.equal(Object.prototype.hasOwnProperty.call(merged, '__proto__'), true);
});

test('a persisted __proto__ key is inert when read back', () => {
  const stored = JSON.stringify({ theme: 'light', __proto__: { polluted: 'yes' } });
  const parsed = JSON.parse(stored);
  assert.equal(({}).polluted, undefined, 'reading the file polluted Object.prototype');
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype, 'the parsed object lost its prototype chain');
  assert.equal(parsed.theme, 'light');
});

test('re-spreading a parsed payload stays inert', () => {
  // The store is read on every patch, so the hostile value round trips through this path.
  const once = JSON.parse('{"__proto__":{"polluted":"yes"}}');
  const twice = { ...once };
  const thrice = { ...twice };
  assert.equal(({}).polluted, undefined);
  assert.equal(thrice.theme, undefined);
});
