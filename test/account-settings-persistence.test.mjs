// Account-scoped settings must round-trip through a full process restart.
//
// Measured this round against PATCH /api/account/settings:
//
//   PATCH { code_default_transcript_view: 'probe-round-170' }
//     -> 200, echoed in the response body
//   GET /api/account_profile
//     -> settings.code_default_transcript_view === 'probe-round-170'
//   kill and restart the process
//     -> still 'probe-round-170'
//
// This is the control case for round 169: the notification switches lost their value on
// restart because they were written to a module-local object. The account-settings path
// was already correct, and these assertions keep it that way -- if someone ever replaces
// the persisted overlay with an in-memory bag, this goes red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'api-interceptors.cjs'), 'utf8');

test('effectiveSettings merges persisted overrides over the bootstrap', () => {
  // The merge is what makes a restart show the stored value rather than the template.
  const at = SRC.indexOf('const effectiveSettings = () => {');
  assert.ok(at > 0, 'effectiveSettings is missing');
  const block = SRC.slice(at, at + 600);
  assert.match(block, /readSettings\(\)/, 'it never reads the persisted bag');
  assert.match(block, /\.\.\.base/, 'the bootstrap settings are dropped instead of merged');
});

test('the account settings route dispatches to the writer', () => {
  // Anchor on the ROUTE, not on the first mention of the path: the first two mentions are
  // documentation comments, so a slice from there never reaches the handler. That mistake
  // made this assertion fail against correct code.
  const at = SRC.indexOf("path === '/api/account/settings' && method === 'PATCH'");
  assert.ok(at > 0, 'the account settings route is missing');
  const block = SRC.slice(at, at + 200);
  assert.match(block, /writeAccountSettings\(request\)/, 'the route does not call the writer');
});

test('the writer persists through the injected store', () => {
  const at = SRC.indexOf('const writeAccountSettings =');
  assert.ok(at > 0, 'writeAccountSettings is missing');
  const block = SRC.slice(at, at + 900);
  assert.match(block, /writeSettings\(/, 'the writer never calls the injected store');
});

test('a rejected write does not take the endpoint down', () => {
  // writeSettings may throw on a read-only store; the user must still get an answer.
  const at = SRC.indexOf('/api/account/settings');
  const block = SRC.slice(at, at + 1600);
  assert.match(block, /catch/, 'the write is unguarded');
});