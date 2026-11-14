// Place the V6 agent core (CCB = claude-code-best) where the app can find it, and pin it.
//
// Why this exists (evidence/v6-worklist.md item 0.2): the kernel currently lives in
// %TEMP%\cc-best-ref, a throwaway build nobody can reproduce from the repository, and a
// 115 MB Bun runtime in another %TEMP% folder. A kernel that cannot be reproduced cannot
// be shipped, and one that silently drifts cannot be debugged.
//
// The deliverable is small on purpose. Vendoring the whole upstream checkout would add
// ~1.2 GB of source we do not build from at runtime; what actually executes is
// dist/ (92 MB) plus the Bun binary (115 MB). So agent-core/ holds exactly those two
// things plus a manifest of digests, and the source build is reproducible from the pinned
// commit recorded in that manifest.
//
//   node tools/setup-agent-core.cjs --adopt-from %TEMP%\cc-best-ref   # copy an existing build
//   node tools/setup-agent-core.cjs                                    # full build from the pin
//   node tools/setup-agent-core.cjs --verify                           # re-hash, no network
//   node tools/setup-agent-core.cjs --force                            # wipe agent-core/ first
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'agent-core');
const BUNDLE = path.join(CORE, 'claude-code', 'dist');
const BUN_DIR = path.join(CORE, 'bun');
const MANIFEST = path.join(CORE, 'manifest.json');
const SOURCE_PIN = path.join(CORE, 'SOURCE.md');

const REPO = 'https://github.com/claude-code-best/claude-code';
const COMMIT = '77a7934e15d69da13879112ed7db695c9ee7a52a';
const VERSION = '2.8.4';
const BUN_VERSION = '1.4.4';

function bunExe() {
  const candidates = [
    process.env.CCB_BUN,
    path.join(BUN_DIR, 'bun.exe'),
    path.join(CORE, 'bun-prefix', 'node_modules', 'bun', 'bin', 'bun.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

function kernelEntry() {
  const candidates = [
    process.env.CCB_ENTRY,
    path.join(BUNDLE, 'cli-bun.js'),
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

function run(label, exe, args, opts = {}) {
  process.stderr.write('[' + label + '] ' + args.join(' ') + '\n');
  const result = spawnSync(exe, args, {
    cwd: opts.cwd || ROOT,
    stdio: 'inherit',
    timeout: opts.timeout || 30 * 60 * 1000,
    env: { ...process.env, ...(opts.env || {}) },
    windowsHide: true,
  });
  if (result.error) throw new Error(label + ': ' + result.error.message);
  if (result.status !== 0) throw new Error(label + ': exit ' + result.status);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Digest of the bundle: sorted relative paths plus each file's own digest. */
function digestBundle(dir = BUNDLE) {
  if (!fs.existsSync(path.join(dir, 'cli-bun.js'))) return null;
  const files = [];
  let total = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        total += fs.statSync(full).size;
        files.push(path.relative(dir, full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  files.sort();
  const combined = crypto.createHash('sha256');
  for (const rel of files) {
    combined.update(rel + '\u0000');
    combined.update(sha256File(path.join(dir, rel)));
    combined.update('\n');
  }
  return {
    entry: 'claude-code/dist/cli-bun.js',
    entrySha256: sha256File(path.join(dir, 'cli-bun.js')),
    fileCount: files.length,
    totalBytes: total,
    treeSha256: combined.digest('hex'),
  };
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

/** What the app actually needs at runtime, and nothing else. */
function adopt(sourceRoot, options = {}) {
  const sourceDist = path.join(sourceRoot, 'dist');
  if (!fs.existsSync(path.join(sourceDist, 'cli-bun.js'))) {
    throw new Error('no built bundle at ' + sourceDist + ' (expected cli-bun.js)');
  }

  // The bun binary to install must come from a location that exists.
  //
  // This used to be hardcoded to %TEMP%\bun-prefix\node_modules\bun\bin\bun.exe, which is a
  // ts-node-era artefact of whoever first ran this: that directory is created by an `npm i bun`
  // install into TEMP and disappears with temp cleanup. It is gone now, so --adopt-from threw
  // "no bun.exe at ..." for every invocation even though the repo already ships a verified
  // agent-core/bun/bun.exe. Reuse bunExe(), which already knows the right fallback chain, and
  // prefer a caller-supplied CCB_BUN when the checkout brought its own runtime.
  const sourceBun = options.bunExe
    || process.env.CCB_BUN
    || bunExe()
    || path.join(BUN_DIR, 'bun.exe');
  if (!fs.existsSync(sourceBun)) {
    throw new Error('no bun.exe found (looked at CCB_BUN, agent-core/bun/bun.exe); '
      + 'adopting a dist requires the runtime that will execute it');
  }

  // Snapshot the runtime BEFORE the reset below can delete it.
  //
  // bunExe()'s normal fallback is agent-core/bun/bun.exe, which IS the reset target. Deleting the
  // directory first would leave nothing to copy from, and the earlier "skip if same path" guard
  // would then leave the tree with no bun.exe at all. Read the bytes into memory first.
  let bunBytes = null;
  if (path.resolve(sourceBun) === path.resolve(path.join(BUN_DIR, 'bun.exe'))) {
    bunBytes = fs.readFileSync(sourceBun);
  }

  fs.mkdirSync(CORE, { recursive: true });

  // ALWAYS replace the bundle tree; never merge into it.
  //
  // copyTree() only writes files, so adopting over an existing dist produced a MIXED tree:
  // measured on the first run, fileCount went 1479 -> 2405 and chunks went 734 -> 1197, because
  // the old content-hash chunk names and the new ones both survived. The entry then imports the
  // new names while stale duplicates sit alongside them — a bundle whose digests are computed
  // over a tree that contains two generations of the same module. `--force` used to gate this;
  // merging is never correct here, so it is now unconditional.
  for (const target of [BUNDLE, BUN_DIR]) fs.rmSync(target, { recursive: true, force: true });

  process.stderr.write('[adopt] dist -> ' + path.basename(BUNDLE) + '\n');
  copyTree(sourceDist, BUNDLE);
  fs.mkdirSync(BUN_DIR, { recursive: true });
  process.stderr.write('[adopt] bun.exe -> ' + path.basename(BUN_DIR) + '\n');
  // Do not copy the binary onto itself: bunExe() may already point at the target, and the old
  // tree was just deleted, so the source may be the same path.
  const targetBun = path.join(BUN_DIR, 'bun.exe');
  if (bunBytes) {
    fs.writeFileSync(targetBun, bunBytes);
  } else if (fs.existsSync(sourceBun)) {
    fs.copyFileSync(sourceBun, targetBun);
  } else {
    throw new Error('bun.exe could not be restored after the adopt reset; set CCB_BUN to a bun '
      + 'binary outside agent-core/bun');
  }

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' });
  const actualCommit = String(head.stdout || '').trim();
  return writeManifest({
    source: 'adopted',
    sourceRoot,
    drift: actualCommit && actualCommit !== COMMIT ? { pinnedCommit: COMMIT, actualCommit } : null,
  });
}

function writeManifest(extra = {}) {
  const bundle = digestBundle();
  const bun = bunExe();
  const manifest = {
    // CCB is an independent reverse-engineering project, NOT Anthropic's shipped CLI.
    // Anything derived from it inherits that difference; do not describe it as official.
    agentCore: 'claude-code-best',
    upstream: REPO,
    pinnedCommit: COMMIT,
    version: VERSION,
    builtAt: new Date().toISOString(),
    bun: bun ? {
      path: path.relative(ROOT, bun).split(path.sep).join('/'),
      version: BUN_VERSION,
      sha256: sha256File(bun),
    } : null,
    bundle,
    ...extra,
  };
  fs.mkdirSync(CORE, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(SOURCE_PIN, [
    '# Agent core provenance',
    '',
    '`agent-core/` holds the V6 agent kernel used by the replica.',
    '',
    '| item | value |',
    '|---|---|',
    '| upstream | ' + REPO + ' |',
    '| pinned commit | `' + COMMIT + '` |',
    '| upstream version | ' + VERSION + ' |',
    '| runtime | Bun ' + BUN_VERSION + ' (Node cannot run `dist/cli-node.js`: it crashes on `import.meta.require`) |',
    '',
    '## What is in here',
    '',
    '- `claude-code/dist/` — the built CLI bundle (only `cli-bun.js` and its chunks are executed).',
    '- `bun/bun.exe` — the pinned Bun runtime that runs it.',
    '- `manifest.json` — digests of both, so `--verify` can tell "same kernel" from "different kernel".',
    '',
    '## Licensing and honesty',
    '',
    'CCB states in its own README: *"This project is for educational and research purposes only. ',
    'All rights to Claude Code belong to Anthropic."* It ships no root LICENSE granting reuse.',
    'That means this kernel must not be redistributed as part of a shipped product without a ',
    'licence decision; it is included here for a local reconstruction and is clearly marked as a ',
    "third-party component. Anthropic's own terms govern the Claude Code behaviour it reproduces.",
    '',
    'It is also **508,000 lines we cannot audit**. Nothing in the desktop shell should assume it ',
    'behaves exactly like the official CLI; where behaviour differs, the difference is a finding, ',
    'not a bug in the shell.',
    '',
    '## Rebuilding',
    '',
    '    node tools/setup-agent-core.cjs --adopt-from <a built CCB checkout>',
    '    node tools/setup-agent-core.cjs            # full build from the pinned commit',
    '    node tools/setup-agent-core.cjs --verify   # re-hash what is on disk',
    '',
  ].join('\n'), 'utf8');
  return manifest;
}

function setupFromScratch() {
  const sourceRoot = path.join(CORE, 'claude-code-src');
  fs.mkdirSync(CORE, { recursive: true });

  // Fetch the PIN, not HEAD.
  //
  // This used to be `git clone --depth 1 <repo>`, which takes whatever upstream HEAD happens to
  // be. That silently builds a different commit than COMMIT and then only *warns* about the
  // drift — so `--verify` would report a manifest that faithfully describes the wrong kernel.
  // Measured: pin 77a7934e is reachable via a shallow fetch of the sha itself.
  if (!fs.existsSync(path.join(sourceRoot, 'package.json'))) {
    fs.mkdirSync(sourceRoot, { recursive: true });
    run('init', 'git', ['init', '--quiet'], { cwd: sourceRoot });
    run('remote', 'git', ['remote', 'add', 'origin', REPO], { cwd: sourceRoot });
    run('fetch', 'git', ['fetch', '--depth', '1', 'origin', COMMIT], { cwd: sourceRoot, timeout: 30 * 60 * 1000 });
    run('checkout', 'git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: sourceRoot });
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' });
  const actualCommit = String(head.stdout || '').trim();
  if (actualCommit !== COMMIT) {
    // Hard failure, not a warning: a build of a different commit produces a manifest that is
    // internally consistent and therefore looks verified, while describing something else.
    throw new Error('source tree is at ' + (actualCommit || '(unknown)') + ', expected the pin ' + COMMIT
      + '. Refusing to build a kernel that the manifest would mislabel.');
  }

  const bun = bunExe();
  if (!bun) throw new Error('no bun.exe; run with --adopt-from, or install bun into agent-core/bun first');

  // --ignore-scripts is required, not optional.
  //
  // CCB's `prepare` is `husky`, which is not resolvable here, and its `postinstall` runs
  // `setup-chrome-mcp.mjs`, which throws MODULE_NOT_FOUND. Either one makes bun roll the ENTIRE
  // install back: node_modules ends up with 3 entries and the build fails with a wall of
  // "Could not resolve". The install still reports a long elapsed time and a multi-GB temp
  // footprint, so it looks successful unless node_modules is inspected.
  run('deps', bun, ['install', '--ignore-scripts'], { cwd: sourceRoot, timeout: 30 * 60 * 1000 });
  run('build', bun, ['run', 'build'], { cwd: sourceRoot, timeout: 20 * 60 * 1000 });
  return adopt(sourceRoot, { force: true });
}

function verify() {
  if (!fs.existsSync(MANIFEST)) {
    console.log(JSON.stringify({ ok: false, reason: 'no-manifest', manifest: MANIFEST }, null, 2));
    return 1;
  }
  const previous = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const bundle = digestBundle();
  const bun = bunExe();
  const sameBundle = Boolean(bundle && previous.bundle && bundle.treeSha256 === previous.bundle.treeSha256);
  const sameBun = Boolean(bun && previous.bun && sha256File(bun) === previous.bun.sha256);
  console.log(JSON.stringify({
    ok: Boolean(bundle) && Boolean(bun) && sameBundle && sameBun,
    pinnedCommit: previous.pinnedCommit,
    version: previous.version,
    bundlePresent: Boolean(bundle),
    bunPresent: Boolean(bun),
    sameBundle,
    sameBun,
    entry: bundle ? BUNDLE + path.sep + 'cli-bun.js' : null,
  }, null, 2));
  return Boolean(bundle) && Boolean(bun) && sameBundle && sameBun ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--verify')) process.exit(verify());
  const adoptIndex = args.indexOf('--adopt-from');
  try {
    const manifest = adoptIndex >= 0
      ? adopt(args[adoptIndex + 1], { force: args.includes('--force') })
      : setupFromScratch();
    console.log(JSON.stringify({ ok: true, manifest }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, reason: String(error && error.message) }, null, 2));
    process.exit(1);
  }
}

module.exports = { CORE, BUNDLE, BUN_DIR, MANIFEST, REPO, COMMIT, VERSION, BUN_VERSION, bunExe, kernelEntry, digestBundle, verify };

if (require.main === module) main();
