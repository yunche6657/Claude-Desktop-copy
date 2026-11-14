// The three `!consent` guards in main-services.cjs, and why each needs a test.
//
// `consent` is an injected dependency (see registerDesktopServices' signature). It is null
// whenever the caller did not supply a consent surface — which is exactly the configuration
// where an approval would have no way to be asked. All three entry points that can run or
// write something check it, and each check is the ONLY thing standing between "no consent
// UI" and "runs without consent":
//
//   runCommand  if (!consent) throw 'Local execution is unavailable: no consent surface'
//   write       if (!consent) throw 'Editing requires approval, but no consent surface ...'
//   replace     same as write
//
// Measured: mutating any of them to a no-op left every existing test green. The suites cover
// the DENY and the availability branches, but never the "there is nobody to ask" branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'main-services.cjs'), 'utf8');

/** Every `!consent` guard in the file, with the text it throws. */
function consentGuards() {
  return [...SRC.matchAll(/if \(!consent\) throw new Error\('([^']+)'\)/g)].map((m) => m[1]);
}

test('all three entry points refuse when there is no consent surface', () => {
  const reasons = consentGuards();
  assert.equal(reasons.length, 3, 'expected three !consent guards, found ' + reasons.length);
});

test('each guard says what is missing, not just that something failed', () => {
  // The message reaches the renderer; "no consent surface" tells the operator what to wire.
  for (const reason of consentGuards()) {
    assert.match(reason, /consent/i, 'a guard does not name the missing consent surface');
  }
});

test('the guard runs before the prompt would be asked', () => {
  // Ordering is the whole property: checking after consent.ask() would be too late.
  const entryPoints = [
    '      runCommand: async (_event, request) => {',
    '      write: async (_event, filePath, content) => {',
    '      replace: async (_event, filePath, oldText, newText) => {',
  ];
  for (const marker of entryPoints) {
    const start = SRC.indexOf(marker);
    assert.ok(start > 0, 'entry point missing: ' + marker);
    const end = SRC.indexOf('      // ----', start + 10);
    const body = SRC.slice(start, end > start ? end : start + 2600);
    const guardAt = body.indexOf('if (!consent) throw');
    const askAt = body.indexOf('consent.ask');
    assert.ok(guardAt > 0, 'no !consent guard in ' + marker);
    assert.ok(askAt > 0 && guardAt < askAt, 'the guard runs after consent.ask in ' + marker);
  }
});

test('runCommand checks consent before it spends work on availability', () => {
  // A machine-local check is cheap, but the refusal must still be the first word: a missing
  // consent surface means the command can never be approved, whatever its binary resolves to.
  const start = SRC.indexOf('      runCommand: async (_event, request) => {');
  const body = SRC.slice(start, start + 2600);
  const guardAt = body.indexOf('if (!consent) throw');
  const availabilityAt = body.indexOf('checkAvailability(parsed)');
  assert.ok(guardAt > 0 && availabilityAt > 0);
  assert.ok(guardAt < availabilityAt, 'availability is resolved before consent is checked');
});
