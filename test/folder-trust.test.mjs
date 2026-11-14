// Folder trust has exactly ONE store, and both readers agree with it.
//
// HISTORY. LocalAgentModeSessions.isFolderTrusted / addTrustedFolder / removeTrustedFolder /
// browseAndAddTrustedFolder had no handlers, so they answered through the generic fallback:
//
//   isFolderTrusted(x)        -> false
//   addTrustedFolder(x)       -> null
//   isFolderTrusted(x) again  -> false
//
// The first fix added a `trustedFolders` Set to the kernel. That was WRONG:
// LocalSessions.checkTrust / checkStoredTrust / saveTrust already maintain a trust store
// (~/.claude.json plus an overlay). Two stores can disagree about the same folder —
// isFolderTrusted(p) true while checkTrust(p).trusted is false — which is worse than the
// feature being absent, because the trust prompt and the trust badge would contradict.
//
// The handlers now delegate to the existing store, and the kernel set is gone. These tests pin
// both halves of that: the channels exist, and there is no second store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the four folder-trust channels have real handlers', () => {
  const bridge = read('desktop/bridge-services.cjs');
  for (const method of ['isFolderTrusted', 'addTrustedFolder', 'removeTrustedFolder', 'browseAndAddTrustedFolder']) {
    // Written with template literals, so the channel name closes with a backtick.
    assert.ok(bridge.includes('_$_' + method + '`'), method + ' has no handler');
  }
});

test('folder trust reads and writes the shared trust store', () => {
  const bridge = read('desktop/bridge-services.cjs');
  const start = bridge.indexOf('_$_isFolderTrusted`');
  assert.ok(start > 0, 'isFolderTrusted handler is gone');
  const window = bridge.slice(start, start + 900);
  assert.match(window, /readTrustStore\(\)/, 'isFolderTrusted does not consult the trust store');
  assert.match(bridge.slice(bridge.indexOf('_$_addTrustedFolder`')), /^[\s\S]{0,700}?writeTrustStore\(/, 'addTrustedFolder does not write the trust store');
});

test('there is no second trust store in the kernel', () => {
  // The removed Set is the specific regression this guards.
  const kernel = read('desktop/session-kernel.cjs');
  assert.equal(kernel.split('trustedFolders').length - 1, 0, 'a second trust store came back in the kernel');
  assert.equal(kernel.split('isFolderTrusted').length - 1, 0, 'the kernel grew its own isFolderTrusted again');
});

test('the trust store path is the shared overlay, not the session store', () => {
  // A trust decision must survive a session-store deletion, and vice versa.
  const bridge = read('desktop/bridge-services.cjs');
  assert.match(bridge, /const readTrustStore = \(\) => \{/, 'readTrustStore disappeared');
  assert.match(bridge, /claudeJsonPath\(\)/, 'the trust store no longer reads the CLI file');
});
