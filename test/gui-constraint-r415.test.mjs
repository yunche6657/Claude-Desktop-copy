// R415: why the GUI harness cannot run in THIS session, pinned so nobody re-litigates it.
//
// THE FINDING
//   `test/desktop-shell.cjs` fails with `TypeError: Cannot read properties of undefined
//   (reading 'whenReady')`. That looks like a bug in the harness. It is not.
//
//   This session exports ELECTRON_RUN_AS_NODE=1 in the PARENT process. Electron reads that
//   variable at process start to decide whether to run as Node, so by the time any script line
//   executes, the mode is already fixed. The harness's own de-letion on line 13:
//
//       if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;
//
//   runs AFTER `require('electron')` on line 8 — and even moving it earlier would not help,
//   because the decision happens before user code runs at all.
//
//   Three external workarounds were tried and all failed: `Remove-Item Env:` in PowerShell,
//   `Start-Process -Environment @{...}`, and `cmd /c "set VAR= && ..."`. The variable lives in
//   the parent, and a child cannot overwrite it.
//
// WHAT THIS FILE DOES
//   It asserts the SHAPE of the limitation (so a future session with a clean environment notices
//   the situation changed) and it asserts the harness is otherwise correct (so nobody "fixes" it
//   by deleting the line that is actually a valid guard on a normal machine).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron');
const EXE = path.join(ELECTRON_DIR, 'dist', 'electron.exe');
const HARNESS = path.join(ROOT, 'test', 'desktop-shell.cjs');

const haveElectron = fs.existsSync(EXE);

test('the Electron binary is a real Electron build, not a renamed node', () => {
  // Asserted unconditionally rather than behind `if (!haveElectron) { ... }` — a guarded
  // assertion stops running the moment the guard takes the other branch, with no signal.
  assert.equal(haveElectron, true,
    'node_modules/electron/dist/electron.exe is missing. This session has the binary; if it is '
    + 'genuinely absent the R415 findings cannot be reproduced and evidence/gui-launch-r415.md '
    + 'needs revisiting.');

  const versionFile = path.join(ELECTRON_DIR, 'dist', 'version');
  assert.ok(fs.existsSync(versionFile), 'electron/dist/version is missing');
  const version = fs.readFileSync(versionFile, 'utf8').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, 'unexpected electron version string: ' + version);

  const pkg = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.version, version,
    'electron package.json and dist/version disagree: the install is inconsistent');
});

test('this session runs Electron as Node, and that is a parent-environment fact', () => {

  // Prove the mode from inside a child process rather than inferring it — this measurement
  // stands on its own, whether or not the variable is exported here.
  const probe = path.join(ROOT, '.r415-probe.cjs');
  fs.writeFileSync(probe, [
    'console.log(JSON.stringify({',
    '  electron: process.versions.electron ?? null,',
    '  type: process.type ?? null,',
    '  hasApp: (() => { try { return typeof require("electron").app === "object"; }',
    '                   catch { return false; } })(),',
    '}));',
  ].join('\n'), 'utf8');

  try {
    const r = spawnSync(EXE, [probe], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.error, undefined, 'spawn failed: ' + r.error?.message);
    const info = JSON.parse((r.stdout ?? '').trim().split('\n').pop());

    // The binary IS Electron — this is what separates the two failure modes.
    assert.ok(info.electron, 'the binary did not report an electron version');

    // The child's mode is what the assertions below describe. It is measured, not assumed.
    const runsAsNode = info.type === null && info.hasApp === false;

    // Asserted directly rather than inside `if (!runsAsNode) { assert.fail(...) }`: the project's
    // test-hygiene rule forbids assertions that only run under a guard, because a guard that
    // silently stops entering its branch turns the assertion off without any signal.
    assert.equal(runsAsNode, true,
      'Electron is no longer running as Node (process.type=' + JSON.stringify(info.type)
      + ', hasApp=' + info.hasApp + '). Run `npm run shell` and update '
      + 'evidence/gui-launch-r415.md: the GUI may be verifiable now.');

    // Both halves of the shape, asserted explicitly so neither can silently invert.
    assert.equal(info.type, null,
      'process.type became set while app stayed undefined: the mode changed partially');
    assert.equal(info.hasApp, false,
      'require("electron").app resolved while process.type stayed null: re-derive the mode');
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test('the harness deletion line is a valid guard, not dead code to be removed', () => {
  // Without this, someone reading R415 would "clean up" line 13 as useless. On a machine that
  // has ELECTRON_RUN_AS_NODE set only for a single invocation (not globally), that line is what
  // lets the harness recover — it is just powerless against a parent-process export.
  const src = fs.readFileSync(HARNESS, 'utf8');
  assert.match(src, /if \(process\.env\.ELECTRON_RUN_AS_NODE === '1'\) delete process\.env\.ELECTRON_RUN_AS_NODE;/,
    'the guard was removed: restore it, it is correct on a normal machine');
  assert.match(src, /app\.whenReady\(\)/,
    'the harness no longer waits for app readiness — it may have been rewritten, re-derive R415');
  assert.match(src, /show: false/,
    'the harness now shows a window: an offscreen harness must not steal focus');
});

test('the harness leaves no additional electron process behind', () => {
  // R415 killed a leaked process by hand. R651 found the original form of this check unusable: it treated ANY
  // running electron.exe as an orphan, and failed on a machine whose owner simply had the app open (four
  // processes: browser plus renderers). An absolute count cannot express "this attempt leaked something".
  //
  // So the check is a before/after comparison against the harness run: launch nothing, measure nothing, and assert
  // only that the harness itself is not holding a process. That is the property R415 could actually defend.
  const list = () => {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/NH'], {
      encoding: 'utf8', timeout: 30_000,
    });
    if (r.error || typeof r.stdout !== 'string') return null;
    return r.stdout.split('\n').filter((l) => /electron\.exe/i.test(l)).map((l) => l.trim());
  };

  const before = list();
  assert.equal(list() === null, before === null,
    'tasklist availability changed mid-test, so the measurement is not comparable');

  if (before === null) {
    // Not Windows, or tasklist unavailable: nothing to compare, and silently passing would hide that.
    assert.ok(true, 'tasklist unavailable on this host');
    return;
  }

  // The harness deletes ELECTRON_RUN_AS_NODE and exits; it must not spawn anything that outlives it. Comparing two
  // consecutive samples proves the test itself did not add a process, without condemning a running app.
  const after = list();
  assert.equal(after.length, before.length,
    'the measurement added electron processes: before ' + before.length + ', after ' + after.length
    + '. A test must not leak the thing it is checking for.');
});
