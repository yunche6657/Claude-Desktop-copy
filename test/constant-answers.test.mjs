// A constant answer is either an honest limit or a lie. These are the honest ones.
//
// 25 handlers return a literal — no state read, no call. That shape is suspicious on purpose:
// it is exactly how `getBusyShellPtyKeys` used to lie ({ live: [], probed: true } while a shell
// was running). Each was therefore checked against the question "does the capability I claim
// here actually exist?".
//
// HONEST FALSE (the build really does not offer it):
//   supportsNotificationActions  false   Windows notifications have no action buttons here
//   isLocalDevMcpEnabled         false
//   isHostLoopModeEnabled        false   no host-loop VM mode in this shell
//   getKeptHidden                false   the window is not kept hidden
//
// HONEST TRUE, verified by CALLING the action rather than trusting the flag:
//   CoworkFilePreview.isOpenInDefaultAppEnabled -> true
//     FileSystem.showInFolder('C:/')     -> { ok: true }
//     FileSystem.openLocalFile(missing)  -> { ok: false, error: 'not found' }
//   Launch.isAvailable -> true, and getAllSessionPreviewTabs -> {}
//
// HONEST EMPTY (no such data on this host):
//   ClaudeCode.getStatus            'not_installed'   the CLI is genuinely absent
//   GitState.getGitStateSnapshot    []
//   ForgeState.getForgeStateSnapshot []
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

/** The full define(...) line for a method. */
function line(method) {
  const at = SRC.lastIndexOf('define(', SRC.indexOf('_$_' + method + "'"));
  assert.ok(at > 0, 'handler not found: ' + method);
  const end = SRC.indexOf('\n', at);
  return SRC.slice(at, end > at ? end : at + 200);
}

test('a capability flag that answers true is backed by a real action', () => {
  // Measured live: showInFolder answers { ok: true } and openLocalFile reports not-found
  // rather than pretending. The flag is not a bluff.
  assert.match(line('isOpenInDefaultAppEnabled'), /=> true\)/, 'the flag changed');
  assert.match(SRC, /'claude\.web_\$_FileSystem_\$_showInFolder'/, 'the advertised action is gone');
  assert.match(SRC, /'claude\.web_\$_FileSystem_\$_openLocalFile'/, 'the advertised action is gone');
});

test('the FileSystem open actions report failure instead of throwing', () => {
  // A missing file answers { ok: false, error: 'not found' }; a throw would surface as a
  // tool failure with no reason attached.
  const at = SRC.indexOf("'claude.web_$_FileSystem_$_openLocalFile'");
  const block = SRC.slice(at, at + 1200);
  assert.match(block, /ok: false/, 'the failure path does not answer ok:false');
});

test('the unsupported capabilities are still declared unsupported', () => {
  // These are honest: the shipped UI reads them to hide affordances it cannot honour.
  assert.match(line('supportsNotificationActions'), /=> false\)/);
  assert.match(line('isLocalDevMcpEnabled'), /=> false\)/);
  assert.match(line('isHostLoopModeEnabled'), /=> false\)/);
});

test('an absent CLI is reported as not_installed rather than guessed', () => {
  // If this ever hard-codes 'installed' the Code pane would advertise a missing CLI.
  assert.match(line('getStatus'), /'not_installed'/);
});
