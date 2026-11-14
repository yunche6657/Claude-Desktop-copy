// Tests for the Windows packaging signal that gates Cowork.
//
// The shipped main process decides Cowork availability from whether the app looks
// like an MSIX / Windows Store install:
//
//   function Kr(){ ... process.windowsStore ? true : execPathUnderWindowsApps ? true : false }
//   if (platform === "win32" && !Kr())
//     return { status:"unsupported", unsupportedCode:"msix_required" }
//
// A development Electron run lives in node_modules, so the check fails and Cowork
// stays gated. These tests pin both the detection and the explicit override.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectPackaging, forcedMsix, packagingState } = require('../desktop/packaging-signals.cjs');

test('an exec path under WindowsApps counts as MSIX', () => {
  const state = detectPackaging({
    execPath: 'C:\\Program Files\\WindowsApps\\Claude_2.42304.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe',
    windowsStore: false,
  });
  assert.equal(state.isMsix, true);
  assert.equal(state.detectionSource, 'appPath');
});

test('the windowsStore flag counts as MSIX', () => {
  const state = detectPackaging({ execPath: 'C:\\anything\\app.exe', windowsStore: true });
  assert.equal(state.isMsix, true);
  assert.equal(state.detectionSource, 'windowsStore');
});

test('a node_modules exec path is not MSIX', () => {
  const state = detectPackaging({
    execPath: 'C:\\repo\\claude-code-desktop\\node_modules\\electron\\dist\\electron.exe',
    windowsStore: false,
  });
  assert.equal(state.isMsix, false);
  assert.equal(state.detectionSource, null);
});

test('the WindowsApps directory name is matched case-insensitively', () => {
  const state = detectPackaging({ execPath: 'C:\\X\\windowsapps\\pkg\\a.exe', windowsStore: false });
  assert.equal(state.isMsix, true);
});

test('forcedMsix accepts only the documented truthy spellings', () => {
  const saved = process.env.CLAUDE_FORCE_MSIX;
  try {
    delete process.env.CLAUDE_FORCE_MSIX;
    assert.equal(forcedMsix(), false);
    for (const v of ['1', 'true']) {
      process.env.CLAUDE_FORCE_MSIX = v;
      assert.equal(forcedMsix(), true, v);
    }
    for (const v of ['0', 'false', '', 'yes']) {
      process.env.CLAUDE_FORCE_MSIX = v;
      assert.equal(forcedMsix(), false, v);
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_FORCE_MSIX;
    else process.env.CLAUDE_FORCE_MSIX = saved;
  }
});

test('packagingState reports the override as its source', () => {
  const saved = process.env.CLAUDE_FORCE_MSIX;
  try {
    process.env.CLAUDE_FORCE_MSIX = '1';
    const state = packagingState({ execPath: 'C:\\repo\\node_modules\\electron\\electron.exe' });
    assert.equal(state.isMsix, true);
    assert.equal(state.detectionSource, 'forced');
    assert.equal(state.forced, true);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_FORCE_MSIX;
    else process.env.CLAUDE_FORCE_MSIX = saved;
  }
});

test('without the override the detected state stands', () => {
  const saved = process.env.CLAUDE_FORCE_MSIX;
  try {
    delete process.env.CLAUDE_FORCE_MSIX;
    const state = packagingState({ execPath: 'C:\\repo\\node_modules\\electron\\electron.exe' });
    assert.equal(state.isMsix, false);
    assert.equal(state.forced, false);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_FORCE_MSIX;
    else process.env.CLAUDE_FORCE_MSIX = saved;
  }
});
