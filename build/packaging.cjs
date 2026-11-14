// Packaging.
//
// The shipped product identity (from the artifact's package.json):
//   name         @ant/desktop
//   productName  Claude
//   version      2.42304.0
//   desktopName  com.anthropic.Claude.desktop
//   main         .vite/build/index.pre.js
//   engines.node >=22.0.0
//
// This reconstruction must NOT reuse those identifiers: it is an independent
// workspace, and shipping under Anthropic's app id would collide with a real
// install and misrepresent the artifact. The layout is mirrored, the identity is
// deliberately different, and the difference is recorded rather than blurred.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Mirrors the shipped window geometry measured in evidence/measurements.json.
const WINDOW = Object.freeze({
  width: 1936,
  height: 1048,
  minWidth: 960,
  minHeight: 640,
});

// Files that must ship for the app to run. Anything not listed here and not
// reachable from these is excluded, so a stray test fixture cannot leak into a
// package.
const SHIP = Object.freeze([
  'server.mjs',
  'engine.mjs',
  'renderer',
  'desktop',
  'resources/ion-dist',
  'resources/i18n-overlay',
  'resources/bootstrap-3p.json',
]);

// Never shipped, regardless of SHIP.
const EXCLUDE = Object.freeze([
  'test',
  'evidence',
  'node_modules/.cache',
  '.git',
  'ccd-ref',
  'probe-*',
]);

// Native executables must live outside app.asar. Ship only these pinned inputs;
// agent-core/claude-code/.tmp and any local settings are deliberately not traversed.
const AGENT_CORE_PAYLOAD = Object.freeze(['manifest.json', 'bun/bun.exe', 'claude-code/dist']);

function isRuntimeBackup(relative) {
  return relative.split(/[\\/]/).some(name => /\.bak(?:$|[-.])/i.test(name) || /\.sync-tmp$/i.test(name));
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Validate the pinned runtime and enumerate exactly the files safe to copy. */
function resolveAgentCorePayload(rootDir) {
  const core = path.join(rootDir, 'agent-core');
  const regular = file => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`agent-core payload is not a regular file: ${file}`);
    return stat;
  };
  const directory = file => {
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`agent-core payload is not a plain directory: ${file}`);
  };
  directory(core);
  regular(path.join(core, 'manifest.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(core, 'manifest.json'), 'utf8'));
  if (manifest.agentCore !== 'claude-code-best' || manifest.bun?.path !== 'agent-core/bun/bun.exe' ||
      manifest.bundle?.entry !== 'claude-code/dist/cli-bun.js') throw new Error('unsupported agent-core pin layout');
  for (const digest of [manifest.bun.sha256, manifest.bundle.entrySha256, manifest.bundle.treeSha256]) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid agent-core pin digest');
  }
  directory(path.join(core, 'bun'));
  const bun = path.join(core, 'bun', 'bun.exe');
  regular(bun);
  if (hashFile(bun) !== manifest.bun.sha256) throw new Error('agent-core Bun SHA256 differs from pinned manifest');
  directory(path.join(core, 'claude-code'));
  const bundle = path.join(core, 'claude-code', 'dist');
  directory(bundle);
  const files = [];
  let totalBytes = 0;
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`agent-core payload contains a symbolic link: ${full}`);
      if (stat.isDirectory()) walk(full);
      else {
        regular(full);
        totalBytes += stat.size;
        files.push(path.relative(bundle, full).split(path.sep).join('/'));
      }
    }
  };
  walk(bundle);
  files.sort();
  const digest = crypto.createHash('sha256');
  for (const relative of files) digest.update(relative + '\u0000').update(hashFile(path.join(bundle, relative))).update('\n');
  if (files.length !== manifest.bundle.fileCount || totalBytes !== manifest.bundle.totalBytes ||
      digest.digest('hex') !== manifest.bundle.treeSha256 ||
      hashFile(path.join(bundle, 'cli-bun.js')) !== manifest.bundle.entrySha256) {
    throw new Error('agent-core bundle differs from pinned manifest');
  }
  // Runtime provenance contains no sourceRoot, settings, credentials or build-machine paths.
  const publishedManifest = {
    agentCore: manifest.agentCore, upstream: manifest.upstream, pinnedCommit: manifest.pinnedCommit,
    version: manifest.version,
    bun: { path: manifest.bun.path, version: manifest.bun.version, sha256: manifest.bun.sha256 },
    bundle: { entry: manifest.bundle.entry, entrySha256: manifest.bundle.entrySha256,
      fileCount: manifest.bundle.fileCount, totalBytes: manifest.bundle.totalBytes, treeSha256: manifest.bundle.treeSha256 },
  };
  return { core, manifest: publishedManifest, files: ['bun/bun.exe', ...files.map(file => `claude-code/dist/${file}`)] };
}

function readAppPackage(rootDir) {
  const file = path.join(rootDir, 'package.json');
  if (!fs.existsSync(file)) throw new Error(`package.json not found at ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed;
}

/**
 * Builds the package manifest for the given target.
 *
 * `target` is 'dir' | 'msix' | 'nsis'. The manifest difference is small but real:
 * MSIX needs an application id and a publisher display name, NSIS needs an
 * installer icon and per-user install scope.
 */
function buildManifest(rootDir, { target = 'dir' } = {}) {
  const pkg = readAppPackage(rootDir);
  if (!['dir', 'msix', 'nsis'].includes(target)) {
    throw new Error(`unknown target: ${target}`);
  }

  const base = {
    name: pkg.name,
    productName: pkg.productName || pkg.name,
    version: pkg.version,
    description: pkg.description || '',
    main: pkg.main,
    type: pkg.type,
    private: true,
    engines: { node: pkg.engines?.node || '>=22.0.0' },
    files: SHIP,
  };

  if (target === 'msix') {
    return {
      ...base,
      windows: {
        // An application id is required by the MSIX manifest. It is derived from
        // our own package name, not borrowed from the artifact.
        applicationId: 'CodeDesktopReconstruction',
        packageIdentity: `${pkg.name}.${pkg.version}`,
        publisherDisplayName: 'Independent reconstruction',
        capabilities: ['runFullTrust'],
      },
    };
  }

  if (target === 'nsis') {
    return {
      ...base,
      windows: {
        target: 'nsis',
        // Per-user install avoids needing elevation for a reconstruction build.
        perMachine: false,
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
      },
    };
  }

  return base;
}

/** Resolves which SHIP entries actually exist, so a package never lists a ghost. */
function resolveShipList(rootDir) {
  const present = [];
  const missing = [];
  for (const entry of SHIP) {
    if (fs.existsSync(path.join(rootDir, entry))) present.push(entry);
    else missing.push(entry);
  }
  return { present, missing };
}

/**
 * Verifies a built app directory: the entry point exists, every shipped file is
 * there, and nothing from EXCLUDE leaked in.
 */
function verifyBuild(rootDir, { expectFiles = SHIP } = {}) {
  const problems = [];

  for (const entry of expectFiles) {
    if (!fs.existsSync(path.join(rootDir, entry))) {
      problems.push(`missing: ${entry}`);
    }
  }

  for (const entry of EXCLUDE) {
    const full = path.join(rootDir, entry);
    if (entry.includes('*')) {
      const dir = path.dirname(entry);
      const prefix = path.basename(entry).replace('*', '');
      const base = path.join(rootDir, dir);
      if (fs.existsSync(base)) {
        for (const name of fs.readdirSync(base)) {
          if (name.startsWith(prefix)) problems.push(`excluded file present: ${path.join(dir, name)}`);
        }
      }
      continue;
    }
    if (fs.existsSync(full)) problems.push(`excluded path present: ${entry}`);
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  WINDOW,
  SHIP,
  EXCLUDE,
  AGENT_CORE_PAYLOAD,
  resolveAgentCorePayload,
  isRuntimeBackup,
  readAppPackage,
  buildManifest,
  resolveShipList,
  verifyBuild,
};
