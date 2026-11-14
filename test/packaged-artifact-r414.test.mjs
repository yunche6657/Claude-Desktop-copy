// R414: the PACKAGED artifact contains the current engine and that engine runs.
//
// WHY THIS IS STRONGER THAN R413
//   R413 executed the vendored tree in agent-core/. That proves the bundle runs, but not that a
//   build carries it. Packaging is where a whole class of failures lives: a `files` list that
//   omits a directory, an extraResources step that silently copies nothing, an asar that swallows
//   a native binary. None of those would show up in R413.
//
// THE ONE THAT WOULD HAVE BEEN INVISIBLE
//   `electron-builder.json`'s `files` array does NOT mention `agent-core` — so reading that file
//   alone says the 97MB engine is not shipped. It IS shipped, because build/packaging.cjs adds it
//   as an extraResource outside the asar. A pack-time assertion that trusted the config file would
//   have been wrong in the pessimistic direction; one that trusted nothing would have been wrong
//   in the optimistic direction. This file checks the OUTPUT, which is the only thing that decides.
//
// PRE-EXISTING TRAP IN THIS REPO
//   release/ holds an installer dated 2026-10-18 that predates every change in this session, and
//   its resources/ contains no agent-core at all. Its existence proves nothing about the current
//   build. These assertions therefore read dist-r413 (built this round), never release/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-r413');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'agent-core', 'manifest.json'), 'utf8'),
);

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Recompute the packaged bundle digest from the files on disk.
 *
 * This deliberately does NOT read a build report: build/build.cjs only prints its summary to
 * stdout, and trusting a self-report would mean the check passes whenever the builder *says* it
 * copied the right tree. Hashing the output is the only claim that cannot be faked by a stale log.
 *
 * The order and separator must match tools/setup-agent-core.cjs's tree digest so the numbers are
 * comparable with agent-core/manifest.json.
 */
function packagedTreeDigest(coreDir) {
  const dist = path.join(coreDir, 'claude-code', 'dist');
  const files = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else files.push(rel);
    }
  };
  walk(dist, '');
  const hash = crypto.createHash('sha256');
  for (const rel of files) hash.update(rel + '\u0000' + sha(path.join(dist, rel)) + '\n');
  return { digest: hash.digest('hex'), fileCount: files.length };
}

/** Load-bearing check: the packaged tree must exist before anything else is meaningful. */
function requirePackaged() {
  assert.ok(fs.existsSync(OUT),
    'dist-r413 is missing. Package first:\n'
    + '  node build/build.cjs --target dir --out dist-r413');
}

test('the packaged app carries agent-core with the pinned tree digest', () => {
  requirePackaged();
  const core = path.join(OUT, 'resources', 'agent-core');
  assert.ok(fs.existsSync(core),
    'resources/agent-core is missing from the package: the engine would be absent at runtime');

  // Recompute from the packaged bytes rather than reading the builder's own summary.
  const { digest, fileCount } = packagedTreeDigest(core);
  assert.equal(digest, MANIFEST.bundle.treeSha256,
    'the packaged dist tree differs from agent-core/manifest.json (fileCount '
    + fileCount + '): the installer would ship a different engine than the one under test');
  assert.equal(fileCount, MANIFEST.bundle.fileCount,
    'the packaged dist has ' + fileCount + ' files but the manifest pins '
    + MANIFEST.bundle.fileCount);

  assert.equal(
    sha(path.join(core, 'bun', 'bun.exe')), MANIFEST.bun.sha256,
    'the packaged bun differs from the pinned manifest',
  );
});

test('the packaged engine contains THIS sessions changes, not just some engine', () => {
  // Digest equality already implies this, but naming the changes makes a regression legible:
  // when it breaks, the message says which feature went missing.
  requirePackaged();
  const dist = path.join(OUT, 'resources', 'agent-core', 'claude-code', 'dist');
  const chunks = fs.readdirSync(dist).filter((n) => n.endsWith('.js'));

  const contains = (marker) => chunks.some((n) => {
    const p = path.join(dist, n);
    if (fs.statSync(p).size > 20_000_000) return false;
    return fs.readFileSync(p, 'utf8').includes(marker);
  });

  const expected = {
    'SendFeedback tool definition (R412)': 'SendFeedbackTool = buildTool(',
    'fork ignores effort guard (R407)': '!isForkPath && effort',
    'monitor expiry notification (R409)': 'monitor-timeout-',
    'ProposeGoal tool (R400)': 'ProposeGoalTool = buildTool(',
    'RefreshMcpTools tool (R403)': 'RefreshMcpToolsTool = buildTool(',
  };
  const missing = Object.entries(expected)
    .filter(([, marker]) => !contains(marker))
    .map(([label]) => label);
  assert.deepEqual(missing, [],
    'the packaged engine is missing changes made this session');
});

test('the packaged bun runs the packaged engine', () => {
  // The end-to-end statement: a binary inside the package, executing the engine inside the
  // package, producing real output. Neither half can be satisfied by a stray file elsewhere.
  requirePackaged();
  const bun = path.join(OUT, 'resources', 'agent-core', 'bun', 'bun.exe');
  const cli = path.join(OUT, 'resources', 'agent-core', 'claude-code', 'dist', 'cli-bun.js');
  assert.ok(fs.existsSync(bun), 'packaged bun missing');
  assert.ok(fs.existsSync(cli), 'packaged entry missing');

  const r = spawnSync(bun, [cli, '--version'], {
    cwd: path.dirname(cli), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.error, undefined, 'spawn failed: ' + r.error?.message);
  assert.equal(r.status, 0, 'packaged engine exited ' + r.status + ': ' + (r.stderr ?? '').slice(0, 300));
  assert.match(r.stdout ?? '', /2\.8\.4/,
    'packaged engine did not report its version: ' + JSON.stringify((r.stdout ?? '').slice(0, 120)));
});

test('the packaged engine loads its full module graph', () => {
  // --version may only read a constant. --help walks commander's registry and dynamically imports
  // dozens of chunks, so it fails if any packaged chunk is truncated or missing.
  requirePackaged();
  const bun = path.join(OUT, 'resources', 'agent-core', 'bun', 'bun.exe');
  const cli = path.join(OUT, 'resources', 'agent-core', 'claude-code', 'dist', 'cli-bun.js');
  const r = spawnSync(bun, [cli, '--help'], {
    cwd: path.dirname(cli), encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 0, 'packaged --help failed: ' + (r.stderr ?? '').slice(0, 300));
  const out = r.stdout ?? '';
  assert.ok(out.split('\n').length > 40,
    'packaged --help produced too few lines: ' + out.split('\n').length);
  for (const flag of ['--print', '--add-dir']) {
    assert.ok(out.includes(flag), 'packaged --help is missing ' + flag);
  }
  assert.ok(out.includes('doctor'), 'packaged --help is missing the doctor subcommand');
});

test('the package ships no credentials and leaves no staging leftovers', () => {
  // A packaged build that inlined credentials would leak them to every installer.
  // Checked on the filesystem, not from a build summary: a summary stating "not bundled" while
  // the file sits there is exactly the failure worth catching.
  requirePackaged();
  const resources = path.join(OUT, 'resources');
  const suspicious = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^(\.credentials|auth)\.json$/.test(e.name)) suspicious.push(full);
    }
  };
  walk(resources);
  assert.deepEqual(suspicious, [], 'credential files were packaged: ' + suspicious.join(', '));
});

test('release/ no longer holds the stale installer — R460 rebuilt it', () => {
  // R414 pinned the opposite: the shipped installer had no agent-core, so it was evidence of a
  // broken package rather than proof of a working one.
  //
  // R460 rebuilt it (extraResources + a space-free build path; see evidence/installer-gap-r460.md).
  // The assertion therefore flips: a rebuilt release/win-unpacked MUST now carry agent-core, and a
  // missing one means the rebuild regressed rather than that the tree is clean.
  const legacy = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'agent-core');
  const legacyInstaller = path.join(ROOT, 'release', 'Code Desktop (Reconstruction)-0.1.0-x64.exe');
  if (!fs.existsSync(legacyInstaller)) {
    // Acceptable: release/ may be cleaned. Nothing to guard.
    return;
  }
  assert.equal(fs.existsSync(legacy), true,
    'release/win-unpacked has no agent-core: the packaged app cannot start the agent. This is the '
    + 'R460 defect returning — rebuild with extraResources and a space-free project path');
  // The three paths desktop/main.cjs joins are the concrete requirement, not just the directory.
  for (const rel of [['bun', 'bun.exe'],
                     ['claude-code', 'dist', 'cli-bun.js']]) {
    assert.ok(fs.existsSync(path.join(legacy, ...rel)),
      'agent-core is present but ' + rel.join('/') + ' is missing: main.cjs would fail to spawn');
  }
});
