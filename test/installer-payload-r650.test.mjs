// R650: the installer's payload was verified byte-for-byte, replacing R649's "not tested" gap with a stronger claim.
//
// THE ATTEMPT THAT FAILED, AND WHY THAT IS NOT A DEFECT
//     Start-Process ... /S /D=C:\ccd-install-r650   -> no window, no process, no install dir
//     cmd /c "...exe" /S /D=...                     -> exit code 2
//   NSIS exit 2 means "cancelled by user". A GUI installer started from this restricted session has no usable
//   desktop, the same limitation R640 measured for Electron itself. A normal desktop double-click shows the wizard.
//
// THE VERIFICATION THAT WORKED
//   The NSIS package appends a 7z payload at offset 576832 (magic 377abcaf271c, 260.5 MB). Cut it out and Windows'
//   own bsdtar reads it:
//       tar -tf payload-7z   ->  5333 entries, including resources/app.asar, with no claude-code-src
//   Extract that asar (188 MB) and compare:
//       user-menu-model  true
//       apply-fix        true
//       openSetupWindow  true
//       sha256 installer payload == sha256 release/win-unpacked/resources/app.asar
//
//   Byte equality is a stronger statement than "I clicked through the wizard once": it describes what is in the
//   package, not the outcome of one install.
//
// WHAT IS NOT CLAIMED
//   Not that the wizard was completed: it cannot start here (exit 2).
//   Not that an installed copy runs, writes shortcuts, or uninstalls: only the packaged bytes were verified.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'release', 'Code Desktop (Reconstruction)-0.1.0-x64.exe');
const UNPACKED_ASAR = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('the installer still contains an appended 7z payload', () => {
  assert.ok(fs.existsSync(INSTALLER), 'the installer is missing');
  const b = fs.readFileSync(INSTALLER);
  const magic = Buffer.from('377abcaf271c', 'hex');
  let at = -1;
  for (let i = 0; i < b.length - magic.length; i += 1) {
    if (b.compare(magic, 0, magic.length, i, i + magic.length) === 0) { at = i; break; }
  }
  assert.ok(at > 0, 'no 7z payload found in the installer');
  // R650 measured offset 576832 and a 260.5 MB payload; the offsets may shift, the presence may not.
  assert.ok(b.length - at > 100 * 1048576, 'the payload is implausibly small');
});

test('the unpacked asar still carries all three edits', () => {
  // The installer payload was proven identical to this file, so this is the single source the equality rests on.
  assert.ok(fs.existsSync(UNPACKED_ASAR), 'release/win-unpacked/resources/app.asar is missing');
  const t = fs.readFileSync(UNPACKED_ASAR, 'latin1');
  assert.ok(t.includes('user-menu-model'), 'the Model entry is gone');
  assert.ok(t.includes('if(!e.ok){try{T('), 'the R645 apply() report is gone');
  assert.ok(t.includes('openSetupWindow'), 'the R641 opener is gone');
});

test('the unpacked asar is the size the payload check reported', () => {
  const mb = fs.statSync(UNPACKED_ASAR).size / 1048576;
  // R650 measured 188 MB. A different size means the build changed and the identity claim needs re-deriving.
  assert.ok(mb > 170 && mb < 210, `asar is ${mb.toFixed(1)} MB, outside the verified band`);
});

test('the payload excludes the shipped source tree', () => {
  // Included source is what pushed NSIS past its mmap ceiling (R649). The payload listing had no claude-code-src;
  // the same must hold for the unpacked tree that the payload was packed from.
  const ac = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'agent-core');
  assert.ok(fs.existsSync(ac), 'agent-core is missing');
  assert.ok(!fs.existsSync(path.join(ac, 'claude-code-src')), 'claude-code-src returned to the package');
});

test('the evidence states that the wizard never ran', () => {
  const doc = path.join(ROOT, 'evidence', 'installer-payload-verified-r650.md');
  assert.ok(fs.existsSync(doc), 'the evidence document is missing');
  const text = fs.readFileSync(doc, 'utf8');
  assert.ok(text.includes('exit code 2'), 'the failed installer run is not recorded');
  assert.ok(text.includes('不声称我走完了安装向导'), 'the unperformed step is not declared');
  assert.ok(text.includes('a20d738efefe2909ad483053fbb83175e2a21a91'),
    'the hash equality that the round rests on is not recorded');
});
