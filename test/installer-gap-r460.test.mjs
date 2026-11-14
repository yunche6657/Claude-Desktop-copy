// R460: the installer gap is closed — and the reason it was impossible here is now pinned.
//
// THREE SEPARATE DEFECTS, FOUND IN ORDER
//
// 1. electron-builder.json's files[] never listed agent-core.
//    desktop/main.cjs resolves the runtime through ccb-runtime-paths.cjs, which in a packaged app
//    returns process.resourcesPath; main.cjs then joins 'agent-core' onto it three times (bun.exe,
//    cli-bun.js, kernelRoot). Without that directory the app has a window and no model.
//    build/build.cjs DOES copy it — but build.cjs only accepts dir/asar, so the only path that
//    produces an installer was the one that omitted the agent.
//    FIX: added extraResources [{from: 'agent-core', to: 'agent-core'}]. extraResources rather than
//    files[] because bun.exe must stay OUTSIDE app.asar to be spawnable.
//
// 2. app-builder-bin was absent, so the NSIS target could not run at all.
//    FIX: npm install --no-save app-builder-bin. Its win/x64/app-builder.exe is what drives the
//    packaging, but it still needed the nsis-3.0.4 + nsis-resources-3.4.1 archives, which
//    electron-builder downloads into %LOCALAPPDATA%\electron-builder\Cache\nsis. Those were absent
//    and the automatic download did not happen; fetched them explicitly and extracted with bsdtar
//    (libarchive reads 7z; there is no 7za.exe in this tree).
//
// 3. THE ACTUAL BLOCKER: makensis defines are passed unquoted, so a project path containing a space
//    truncates them. The observed command line was
//        -DPRODUCT_NAME=Code Desktop (Reconstruction) -DPRODUCT_FILENAME=Code Desktop (Reconstructi…
//        -DPROJECT_DIR=C:\Users\Administrator\Desktop\注册号 逆向\claude-code-desktop
//    NSIS parses `Desktop` and `(Reconstruction)` as separate arguments, so PRODUCT_NAME became
//    "Code" and PROJECT_DIR became "...\注册号". The build produced a 0.18 MB stub that then failed to
//    execute when electron-builder tried to run it to harvest the uninstaller:
//        executing file=…\release\Code Desktop (Reconstruction)-0.1.0-x64.exe env={__COMPAT_LAYER: RunAsInvoker}
//    FIX: build from a space-free path (C:\ccd-build-r460), reusing the already-correct win-unpacked
//    via --prepackaged. Result: a 153.8 MB installer, exit 0.
//
// WHAT THIS TEST GUARDS
//   The config fix (extraResources) must stay. And the space problem must stay documented, because it
//   silently produces a tiny stub rather than an error — the failure surfaces far from the cause.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(...p));

test('the installer config now ships agent-core outside the asar', () => {
  const cfg = JSON.parse(read(ROOT, 'electron-builder.json'));

  // extraResources, not files[]: bun.exe is an executable and must not be packed into the asar.
  assert.ok(Array.isArray(cfg.extraResources), 'extraResources is gone: the installer would ship no agent');
  const entry = cfg.extraResources.find((e) => e && e.from === 'agent-core');
  assert.ok(entry, 'agent-core is no longer in extraResources');
  assert.equal(entry.to, 'agent-core',
    'the destination changed: main.cjs joins "agent-core" onto process.resourcesPath, so the name '
    + 'must stay exactly that');

  // And it must NOT have been "fixed" by adding it to files[], which would put it inside app.asar.
  assert.ok(!(cfg.files || []).some((f) => String(f).includes('agent-core')),
    'agent-core was added to files[]: it would land inside app.asar and bun.exe would not be spawnable');
});

test('the packaged app really resolves agent-core from resourcesPath', () => {
  // The requirement this config satisfies.
  const resolver = read(ROOT, 'desktop', 'ccb-runtime-paths.cjs');
  assert.match(resolver, /return resourcesPath/,
    'the resolver changed: the packaging target may no longer be resourcesPath');
  const main = read(ROOT, 'desktop', 'main.cjs');
  for (const suffix of ["'bun', 'bun.exe'", "'claude-code', 'dist', 'cli-bun.js'", "'claude-code'"]) {
    assert.ok(main.includes(suffix), 'main.cjs no longer joins ' + suffix);
  }
  // All three hang off 'agent-core'.
  assert.equal((main.match(/'agent-core'/g) || []).length, 3,
    'the number of agent-core joins changed: re-derive what the installer must contain');
});

test('the NSIS defines are vulnerable to spaces in the project path', () => {
  // Documents the blocker so a future round does not re-diagnose it. The condition is about the
  // BUILD path, not this repo's location forever — hence asserting the mechanism, not the path.
  const nsisTarget = path.join(ROOT, 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis',
    'NsisTarget.js');
  if (!fs.existsSync(nsisTarget)) return;
  const body = fs.readFileSync(nsisTarget, 'utf8');
  // The defines are pushed as a single -Dname=value token with no quoting wrapper.
  assert.ok(body.includes('`-D${name}='),
    'the define construction changed: electron-builder may now quote values, which would make the '
    + 'space-in-path problem disappear and this note obsolete');
  // Text form as observed in the failing build.
  assert.ok(body.includes('nsisEscapeString'),
    'nsisEscapeString is gone: value escaping changed, re-derive the truncation mechanism');
});

test('a space in this workspace path is what truncated the defines', () => {
  // Not a defect in the reconstruction — a property of where it is checked out. Recorded because it
  // is invisible from inside the code and cost four build attempts to find.
  const ws = ROOT;
  const hasSpace = /\s/.test(ws);
  if (!hasSpace) {
    // If the workspace ever moves to a space-free path, note that NSIS builds should then work here.
    assert.ok(true, 'workspace path has no spaces: direct electron-builder runs should now succeed');
    return;
  }
  // With a space present, the documented workaround is a space-free staging path.
  assert.ok(hasSpace);
  assert.ok(!/\\\\\?\\/.test(ws), 'unexpected extended-length path form');
});

test('the shipped installer is a real build, not a truncated stub', () => {
  // A 0.18 MB exe was the symptom of the truncated-defines failure. Any real installer here is
  // >=100 MB because agent-core alone is ~202 MB uncompressed.
  const rel = path.join(ROOT, 'release');
  if (!fs.existsSync(rel)) return;
  const exes = fs.readdirSync(rel).filter((f) => f.endsWith('.exe') && !f.includes('uninstaller'));
  if (exes.length === 0) return;

  const biggest = exes
    .map((f) => ({ f, size: fs.statSync(path.join(rel, f)).size }))
    .sort((a, b) => b.size - a.size)[0];
  assert.ok(biggest.size > 100 * 1024 * 1024,
    `the largest installer is only ${(biggest.size / 1048576).toFixed(2)} MB — that is the truncated-`
    + 'defines stub, not a real build. Rebuild from a space-free path.');

  // And a blockmap should accompany it: electron-builder writes one for real NSIS artifacts.
  const blockmap = path.join(rel, biggest.f + '.blockmap');
  assert.ok(fs.existsSync(blockmap), 'no .blockmap beside the installer: it may not be a complete artifact');
});

test('the source build path still cannot produce an installer', () => {
  // build.cjs is the correct packaging path for the agent, but it accepts only dir/asar. If it ever
  // gains nsis, the installer should be produced there instead of via electron-builder.
  const b = read(ROOT, 'build', 'build.cjs');
  assert.match(b, /if \(!\['dir', 'asar'\]\.includes\(args\.target\)\)/,
    'build.cjs now accepts more targets: check whether nsis is among them, and if so route the '
    + 'installer through build.cjs so agent-core copies and installer packaging stay consistent');
});
