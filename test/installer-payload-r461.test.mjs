// R461: the installer's payload is complete — verified inside the exe, not just in the staging dir.
//
// WHAT R460 LEFT OPEN
//   R460 verified release/win-unpacked (the staging directory) and produced the installer, but never
//   looked inside the exe. "The staging dir has agent-core" and "the installer carries agent-core" are
//   different claims: extraResources could have been applied to one and not the other, or the 7z step
//   could have skipped files.
//
// METHOD
//   The NSIS exe embeds a 7z archive starting at a fixed signature. bsdtar (which links libarchive and
//   therefore reads 7z) lists it directly — no installation, no extraction:
//
//       tar -tf "Code Desktop (Reconstruction)-0.1.0-x64.exe"
//
// MEASURED
//     total entries                                   1575
//     entries under resources/agent-core/             1498
//     of which files                                  1483
//     files on disk in agent-core/                    1483      <- exact match
//     resources/agent-core/bun/bun.exe                present
//     resources/agent-core/claude-code/dist/cli-bun.js present
//     resources/agent-core/manifest.json              present
//     resources/app.asar                              present
//     extensions: 737 .js, 735 .map, 6 .node, 2 .json, 2 .exe, 1 .md
//
//   The 1483 == 1483 match is the load-bearing fact: it rules out a partial copy that still happens to
//   include the three named files.
//
// NOTE ON THE .map FILES
//   735 of the 1483 are .map (source maps) — roughly half the payload by count, and the reason
//   agent-core is ~202 MB uncompressed for 737 actual .js chunks. That is how build/ packaged it; not
//   a defect introduced here, and not something to change without a deliberate decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(ROOT, 'release', 'Code Desktop (Reconstruction)-0.1.0-x64.exe');

/** List entries in the NSIS payload via bsdtar. Cached per test file run. */
let cached = null;
function installerEntries() {
  if (cached) return cached;
  if (!fs.existsSync(EXE)) return null;

  // R651: run bsdtar on the 7z payload, not on the NSIS exe. The original installer could be read directly, but
  // the rebuilt one (compression:store, longer stub) cannot — libarchive reports "Unrecognized archive format".
  // Slicing from the 7z signature works for both layouts, which is why this is a fix rather than a special case.
  const sliced = (() => {
    const direct = spawnSync('tar', ['-tf', EXE], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
    if (direct.status === 0) return direct;
    const bytes = fs.readFileSync(EXE);
    const magic = Buffer.from('377abcaf271c', 'hex');
    let at = -1;
    for (let i = 0; i < bytes.length - magic.length; i += 1) {
      if (bytes.compare(magic, 0, magic.length, i, i + magic.length) === 0) { at = i; break; }
    }
    assert.ok(at > 0, 'no 7z payload found in the installer: ' + String(direct.stderr || '').slice(0, 200));
    const cut = path.join(os.tmpdir(), 'r461-payload-' + process.pid + '.7z');
    fs.writeFileSync(cut, bytes.subarray(at));
    const r = spawnSync('tar', ['-tf', cut], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
    try { fs.unlinkSync(cut); } catch { /* best effort */ }
    return r;
  })();
  const r = sliced;
  assert.equal(r.status, 0,
    'bsdtar could not list the installer: ' + String(r.stderr || '').slice(0, 300));
  // Windows tar emits CRLF. Splitting on '\n' alone leaves a trailing '\r' on every entry, so exact
  // comparisons like `entries.includes('resources/app.asar')` fail against 'resources/app.asar\r'.
  // This is the same CRLF trap that bit eight earlier rounds; strip it explicitly rather than
  // relying on trim(), which would also hide leading spaces in real paths.
  cached = r.stdout.split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .filter((l) => l.trim());
  return cached;
}

test('the installer carries the three paths desktop/main.cjs joins', (t) => {
  const entries = installerEntries();
  if (!entries) {
    t.skip('installer not present');
    return;
  }
  const need = [
    'resources/agent-core/bun/bun.exe',
    'resources/agent-core/claude-code/dist/cli-bun.js',
    'resources/agent-core/manifest.json',
  ];
  for (const p of need) {
    assert.ok(entries.includes(p),
      'the installer is missing ' + p + ': installing it would yield an app that cannot start the '
      + 'agent. This is the R460 defect inside the archive.');
  }
  // kernelRoot is a directory, so it appears with a trailing slash.
  assert.ok(entries.includes('resources/agent-core/claude-code/'),
    'the kernelRoot directory is absent from the archive');
});

test('the payload is complete, not a partial copy', (t) => {
  const entries = installerEntries();
  if (!entries) {
    t.skip('installer not present');
    return;
  }
  const inArchive = entries.filter((e) => e.startsWith('resources/agent-core/') && !e.endsWith('/'));
  const onDisk = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else onDisk.push(p);
    }
  };
  const acRoot = path.join(ROOT, 'agent-core');
  if (!fs.existsSync(acRoot)) {
    t.skip('agent-core not present in the working tree');
    return;
  }
  walk(acRoot);

  // R462 added a package-time filter that drops **/*.map from extraResources. So the archive is no
  // longer expected to match the tree exactly — it is expected to match the tree MINUS the maps.
  // Computing the expectation rather than hardcoding 748 keeps this correct if the map count changes.
  const mapsOnDisk = onDisk.filter((p) => p.endsWith('.map')).length;
  const srcOnDisk = onDisk.filter((p) => p.split(path.sep).includes('claude-code-src')).length;
  // Two package-time exclusions apply, and they overlap (the source tree contains maps), so they must be applied as
  // ONE predicate. Subtracting the two counts separately removed the overlap twice and produced a negative
  // expectation — measured at -2702 before this correction.
  const shipped = onDisk.filter((p) => !p.endsWith('.map') && !p.split(path.sep).includes('claude-code-src'));
  const expected = shipped.length;

  assert.equal(inArchive.length, expected,
    `the archive has ${inArchive.length} agent-core files; expected ${expected} `
    + `(${onDisk.length} on disk, minus ${mapsOnDisk} source maps and ${srcOnDisk} source-tree files, `
    + 'overlap counted once). A mismatch means the packaging step dropped or duplicated files.');
  assert.ok(expected > 0, 'the expectation collapsed to zero — the filter is excluding everything');
  // And the maps really are absent, not merely uncounted.
  assert.equal(inArchive.filter((e) => e.endsWith('.map')).length, 0,
    'the archive still contains .map files despite the packaging filter');
});

test('the app shell ships alongside the agent', (t) => {
  const entries = installerEntries();
  if (!entries) {
    t.skip('installer not present');
    return;
  }
  assert.ok(entries.includes('resources/app.asar'),
    'app.asar is missing: the installer would carry the agent but no application shell');
  // And the shell's own entry point, via the asar being the single packed file.
  const asarPath = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');
  if (fs.existsSync(asarPath)) {
    const size = fs.statSync(asarPath).size;
    assert.ok(size > 1_000_000,
      `app.asar is only ${size} bytes — the shell's sources were probably not packed`);
  }
});

test('the installer is a real NSIS build, identified structurally', () => {
  // Guards against the R460 failure mode recurring: a truncated-defines build produced a 0.18 MB stub.
  if (!fs.existsSync(EXE)) return;
  const size = fs.statSync(EXE).size;
  assert.ok(size > 100 * 1024 * 1024,
    `installer is ${(size / 1048576).toFixed(2)} MB — too small to contain agent-core`);

  // NSIS leaves a "NullsoftInst" marker near the start; the 7z payload follows.
  const head = fs.readFileSync(EXE, { encoding: null }).subarray(0, 300_000);
  assert.ok(head.includes(Buffer.from('NullsoftInst')),
    'no NSIS marker in the first 300 KB: this may not be an NSIS installer');

  const buf = fs.readFileSync(EXE);
  const sig = buf.indexOf(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
  assert.ok(sig > 0, 'no 7z signature: the payload archive is absent');
  assert.ok(buf.length - sig > 100 * 1024 * 1024,
    'the 7z payload is far smaller than agent-core — it was truncated during packaging');
});
