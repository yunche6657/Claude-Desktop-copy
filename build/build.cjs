// Build script.
//
// Produces a runnable app directory plus an app.asar, mirroring how the shipped
// product is laid out (electron runtime + resources/app.asar) while keeping this
// reconstruction's own identity.
//
// Usage:
//   node build/build.cjs [--target dir|asar] [--out <dir>]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createAsar, collectFiles, readAsar } = require('./asar.cjs');
const { buildManifest, resolveShipList, verifyBuild, resolveAgentCorePayload, isRuntimeBackup, SHIP } = require('./packaging.cjs');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { target: 'dir', out: path.join(ROOT, 'dist') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') out.target = argv[++i];
    else if (arg === '--out') out.out = path.resolve(argv[++i]);
    else if (arg === '--link-runtime') out.linkRuntime = true;
    else if (arg === '--keep-app') out.keepApp = true;
    else if (arg === '--help') { out.help = true; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function copyRecursive(from, to, { linkFiles = false, excludeBackups = false } = {}) {
  if (excludeBackups && isRuntimeBackup(path.basename(from))) return;
  const stat = fs.statSync(from);
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (linkFiles) fs.linkSync(from, to);
    else fs.copyFileSync(from, to);
    return;
  }
  if (!stat.isDirectory()) return;
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    copyRecursive(path.join(from, name), path.join(to, name), { linkFiles, excludeBackups });
  }
}

function electronDist() {
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(dist)) {
    throw new Error(`electron runtime not found at ${dist}; run npm install first`);
  }
  return dist;
}

/**
 * Stages the app payload. Returns the staging directory.
 */
function stage(outDir) {
  const { present, missing } = resolveShipList(ROOT);
  if (missing.length) throw new Error(`required files missing: ${missing.join(', ')}`);

  const appDir = path.join(outDir, 'resources', 'app');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });

  for (const entry of present) {
    copyRecursive(path.join(ROOT, entry), path.join(appDir, entry), { excludeBackups: true });
  }

  // The package.json the runtime reads must describe the staged layout, not the
  // source repo (which has devDependencies and test scripts).
  const manifest = buildManifest(ROOT, { target: 'dir' });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return appDir;
}

/** Copy the validated CCB payload outside app.asar, where Bun can be spawned. */
function stageAgentCore(outDir, { rootDir = ROOT, linkRuntime = false } = {}) {
  const payload = resolveAgentCorePayload(rootDir);
  const resources = path.join(outDir, 'resources');
  const destination = path.join(resources, 'agent-core');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of payload.files) copyRecursive(path.join(payload.core, relative), path.join(destination, relative), { linkFiles: linkRuntime });
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(payload.manifest, null, 2) + '\n', 'utf8');
  // Verify what will ship, not only the source pin. Any copy failure/drift fails the build.
  const deployed = resolveAgentCorePayload(resources);
  return { path: destination, version: deployed.manifest.version, files: deployed.files.length + 1,
    bunSha256: deployed.manifest.bun.sha256, bundleTreeSha256: deployed.manifest.bundle.treeSha256 };
}

/** Copies the Electron runtime next to the staged app. */
function stageRuntime(outDir, { linkRuntime = false } = {}) {
  const dist = electronDist();
  const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  for (const name of fs.readdirSync(dist)) {
    if (name === 'resources') continue;
    copyRecursive(path.join(dist, name), path.join(outDir, name), { linkFiles: linkRuntime });
  }
  const exe = path.join(outDir, exeName);
  if (!fs.existsSync(exe)) throw new Error(`runtime executable missing: ${exe}`);
  // Electron treats a binary still named electron.exe as a development runtime,
  // even when it loaded resources/app.asar. Give this app its own executable name.
  const appExe = path.join(outDir, process.platform === 'win32' ? 'CodeDesktop-Reconstruction.exe' : 'code-desktop-reconstruction');
  fs.renameSync(exe, appExe);
  return appExe;
}

/** Packs the staged app directory into resources/app.asar and removes the tree. */
function packAsar(outDir, { keepApp = false } = {}) {
  const appDir = path.join(outDir, 'resources', 'app');
  if (!fs.existsSync(appDir)) throw new Error('nothing staged to pack');

  const files = collectFiles(appDir, ['.']);
  // collectFiles prefixes with '.'; normalise to bare relative paths.
  const normalised = files.map(name => (name.startsWith('./') ? name.slice(2) : name));
  const outFile = path.join(outDir, 'resources', 'app.asar');
  const { fileCount, bytes } = createAsar(appDir, normalised, { outFile });

  if (!keepApp) fs.rmSync(appDir, { recursive: true, force: true });
  return { outFile, fileCount, size: bytes.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node build/build.cjs [--target dir|asar] [--out <dir>] [--link-runtime] [--keep-app]');
    return;
  }
  if (!['dir', 'asar'].includes(args.target)) {
    throw new Error(`unknown target: ${args.target}`);
  }

  fs.rmSync(args.out, { recursive: true, force: true });
  fs.mkdirSync(args.out, { recursive: true });

  console.log(`staging app into ${args.out}`);
  const appDir = stage(args.out);
  const staged = verifyBuild(appDir, { expectFiles: SHIP });
  if (!staged.ok) throw new Error(`staged app is incomplete: ${staged.problems.join('; ')}`);

  console.log('copying pinned CCB runtime outside app.asar');
  const agentCore = stageAgentCore(args.out, { linkRuntime: args.linkRuntime });
  const gatewayRuntime = require('./gateway-runtime.cjs').stageDeploymentRuntime(ROOT, args.out);

  console.log('copying electron runtime');
  const exe = stageRuntime(args.out, { linkRuntime: args.linkRuntime });

  let packed = null;
  if (args.target === 'asar') {
    console.log('packing resources/app.asar');
    packed = packAsar(args.out, { keepApp: args.keepApp });
  }

  const check = verifyBuild(args.out, { expectFiles: [] });
  const report = {
    ok: check.ok,
    target: args.target,
    runtimeStorage: args.linkRuntime ? 'hardlink' : 'copy',
    out: args.out,
    executable: path.relative(ROOT, exe),
    packed,
    agentCore,
    gatewayRuntime,
    leftover: check.problems,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { stage, stageAgentCore, stageRuntime, packAsar, parseArgs };
