// Permission modes: what the user picks must be what the gate uses.
//
// MEASURED LIVE (replica :10370). A FRESH session starts in acceptEdits; setting it to
// bypassPermissions and then sending a Bash command produced:
//
//   new session            permissionMode: acceptEdits
//   setPermissionMode      -> bypassPermissions
//   sendMessage(Bash ...)  -> 4 rows, running:false, NO approval card
//   .tmp/bypass2.txt       -> exists, content 'RAN'
//
// So bypass really bypasses, and the command really ran. The counterpart was measured in
// round 270: under the default mode the same kind of command DID raise a card, and the turn
// sat at running:true until the card was answered.
//
// A NOTE ON A FALSE ALARM. An earlier attempt in this round set bypass on an EXISTING session
// and still saw a card, which looked like a mode that does not take effect. The cause was the
// probe, not the product: a stale session was being reused. Re-running on a fresh session
// showed the bypass working. That is why the measurement below names the session state
// explicitly instead of assuming it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('bypassPermissions is a blanket pass in classify', () => {
  // The whole point of the mode: prompt for nothing.
  const permissions = read('desktop/permissions.cjs');
  assert.match(permissions, /case MODES\.BYPASS:\s*\n\s*return result\(false, 'bypassPermissions prompts for nothing'\);/,
    'bypass no longer passes everything');
});

test('a bridge session downgrades bypass to acceptEdits instead of honouring it', () => {
  // The shipped desktop does this; reproducing it keeps a remote session from silently
  // becoming a blanket bypass.
  const permissions = read('desktop/permissions.cjs');
  assert.match(permissions, /if \(effective === MODES\.BYPASS && isBridge\) \{/);
  assert.match(permissions, /effective = MODES\.ACCEPT_EDITS;/);
  assert.match(permissions, /downgraded = true;/);
});

test('the executor is built with isBridge defaulting to false', () => {
  // A local kernel session is not a bridge session, so the downgrade must not apply to it.
  const approval = read('desktop/tool-approval.cjs');
  assert.match(approval, /isBridge = false/);
});

test('the kernel passes the session\'s own mode to the agent factory', () => {
  // Round 253 fixed a runner that read only process config, so a session set to auto still
  // raised a card for every Write. This pins that fix.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /permissionMode: session\.permissionMode/, 'the session mode is not forwarded');
});

test('the agent factory is keyed by mode, so a change takes effect next turn', () => {
  // Measured: setting the mode then sending produced a card-free run, which is only possible
  // if the factory rebuilt for the new mode.
  const main = read('desktop/main.cjs');
  // The factory now forwards BOTH the mode and the model; the mode must still come first.
  assert.match(main, /createAgent: \(opts\) => getAgent\(\s*opts && opts\.permissionMode,/,
    'the factory ignores the requested mode');
});