// "Import isn't enabled for this deployment" is the CORRECT answer here, not a defect.
//
// The settings panel 导入和导出 shows that sentence (zh-Hans id r3JVDltSqg). Tracing where it
// comes from: the UI calls HistoryImport.getImportCapabilities and renders the disabled message
// when every capability flag is false. Measured live:
//
//   getImportCapabilities() -> { canImport:false, canExport:false, canAutoImport:false,
//                               disabledReason: 'Importing history is not available in this build.' }
//   getImportHistory()      -> []
//
// So the panel is honest: there is no session-import subsystem in this shell and the bridge
// says so. This file exists to keep that conclusion from being "fixed" by accident, because
// the previous shape of this code caused a real crash:
//
//   "errorCode":"0TA57KU","route":"/new"   <- the whole surface behind an error boundary
//
// i.e. answering null made the caller throw while rendering, and the user saw a blank page
// instead of a missing feature. An explicit capability object is what stops that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('import capabilities are an explicit object, not a bare false', () => {
  // A bare false/nul made the renderer throw; the object shape is what it reads.
  const at = BRIDGE.indexOf("'claude.settings_$_HistoryImport_$_getImportCapabilities'");
  assert.ok(at > 0, 'the capabilities handler is missing');
  const block = BRIDGE.slice(at, at + 400);
  assert.match(block, /canImport: false/);
  assert.match(block, /canExport: false/);
  assert.match(block, /disabledReason: /, 'the refusal does not explain itself');
});

test('the import containers are real arrays, so a caller may spread or map them', () => {
  // The comment above these handlers records the crash this prevents.
  for (const marker of [
    "'claude.settings_$_HistoryImport_$_getImportHistory'",
    "'claude.settings_$_HistoryImport_$_enumerateSessionSources'",
    "'claude.settings_$_HistoryImport_$_listSourceExtras'",
  ]) {
    const at = BRIDGE.indexOf(marker);
    assert.ok(at > 0, 'handler missing: ' + marker);
    assert.match(BRIDGE.slice(at, at + 160), /=> \[\]|importHistory\.slice\(\)/, marker + ' does not answer an array');
  }
});

test('the disabled reason names the build, not a fabricated policy', () => {
  // "contact your administrator" would be a lie: there is nothing to turn on.
  assert.match(BRIDGE, /Importing history is not available in this build\./);
});
