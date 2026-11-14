#!/usr/bin/env node
'use strict';
// Produce an NSIS installer, correctly, from ONE command.
//
// WHY THIS EXISTS
//   The repo had no packaging entry point. package.json's `build` and `build:asar` both call
//   build/build.cjs, which only stages a directory or an asar — neither produces an installer. Every
//   installer so far was made by typing an electron-builder command by hand, and that went wrong
//   twice in recorded history:
//
//     1. A spaced path. The project lives under "注册号 逆向". electron-builder passes the output paths
//        into NSIS, and the spaces were mis-quoted: the run "succeeded" and produced a 0.18 MB stub
//        instead of a ~195 MB installer. R460 worked around it by building in C:\ccd-build-r460.
//
//     2. --prepackaged. R460 then reused an existing win-unpacked with that flag to get a working
//        installer quickly. The flag skips the rebuild, so electron-builder never re-read
//        resources/ion-dist — and that directory is a JUNCTION. The result was an installer whose
//        app.asar was 4.7 MB instead of 187.6 MB: an agent with no UI.
//
//   Both mistakes share a shape: the command reported success while producing the wrong thing. A script
//   that checks its own output is the fix.
//
// WHAT THIS SCRIPT DOES
//   1. Refuses to run without a staged win-unpacked it can trust — it builds the asar itself first, so
//      a stale app.asar cannot be packaged.
//   2. Runs electron-builder for real, never with --prepackaged.
//   3. Chooses a staging directory with NO SPACES, because that is the only reliable way to keep NSIS
//      argument handling out of the picture. The staged tree is assembled by copying, not by
//      re-running the whole build, so the ion-dist junction is dereferenced into a real copy.
//   4. VERIFIES the produced installer: minimum size, and the app.asar inside it must contain the files
//      the app needs. A stub fails here rather than shipping.
//
// USAGE
//   node tools/package-installer.cjs            # full run
//   node tools/package-installer.cjs --dry-run  # report the plan and the checked preconditions
//
// The staging directory defaults to C:\ccd-package-<pid> on Windows or a /tmp path elsewhere; override
// with --stage <dir>. It is removed on success unless --keep-stage is passed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveAgentCorePayload, SHIP } = require('../build/packaging.cjs');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const BUILDER_CONFIG = path.join(ROOT, 'electron-builder.json');

// The installer must be at least this large to be believable. The R460 stub was 0.18 MB; a real payload
// is ~195 MB, of which app.asar alone is ~187 MB. 100 MB leaves room for a future trim without letting a
// stub through.
const MIN_INSTALLER_BYTES = 100 * 1024 * 1024;

// Files that must be readable inside the packaged app.asar. These are the ones whose absence produced
// the UI-less installer: the frontend shell and the main process entry.
const REQUIRED_ASAR_ENTRIES = [
  'desktop/main.cjs',
  'desktop/app-protocol.cjs',
  'package.json',
];

function human(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Parse argv into a plain options object. */
function parseArgs(argv) {
  const out = { dryRun: false, keepStage: false, stage: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--keep-stage') out.keepStage = true;
    else if (arg === '--stage') {
      out.stage = argv[++i];
      if (!out.stage) throw new Error('--stage requires a directory');
    }
    else if (arg === '--icon') {
      out.icon = argv[++i];
      if (!out.icon) throw new Error('--icon requires an ICO path');
    }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** Read the asar header and return the parsed JSON, without extracting anything. */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const header = Buffer.alloc(headerSize);
    fs.readSync(fd, header, 0, headerSize, 16);
    return JSON.parse(header.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/** Does the asar contain this slash-separated path? */
function asarHas(header, entryPath) {
  let node = header;
  for (const part of entryPath.split('/')) {
    node = node && node.files && node.files[part];
    if (!node) return false;
  }
  return true;
}

/** Count regular file entries in an asar header, recursively. */
function countAsarFiles(node) {
  if (!node || !node.files) return 1;
  let total = 0;
  for (const child of Object.values(node.files)) total += countAsarFiles(child);
  return total;
}

/**
 * Pick a staging root with no spaces in it.
 *
 * The spaced project path is what broke NSIS quoting in R460. Rather than trusting a flag to quote it
 * correctly, the staged tree is placed somewhere without spaces, so the question cannot arise.
 */
function chooseStageRoot(requested) {
  if (requested) {
    const resolved = path.resolve(requested);
    if (/\s/.test(resolved)) {
      throw new Error(
        `staging directory must not contain spaces: ${resolved}\n`
        + 'That is the exact condition that made electron-builder produce a 0.18 MB stub in R460.');
    }
    return resolved;
  }
  const base = process.platform === 'win32' ? 'C:\\' : os.tmpdir();
  return path.join(base, `ccd-package-${process.pid}`);
}

/**
 * Copy a directory tree, dereferencing junctions/symlinks into real files.
 *
 * Skips entries whose target cannot be stat'ed and records them. The repository contains a deliberately
 * broken junction — resources/ion-dist.broken-r373 points at a WindowsApps path that does not exist on
 * this machine — and a packaging run must report that rather than crash with a bare ENOENT. Anything
 * skipped is listed so a genuinely missing input cannot hide behind the same mechanism.
 *
 * @param {string} from
 * @param {string} to
 * @param {(name: string) => boolean} [filter]
 * @param {{skipped?: string[]}} [state]
 */
function copyTreeDereferenced(from, to, filter = () => true, state = { skipped: [] }) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    // Dirent.isDirectory() is false for a junction on Windows in some Node versions, so stat the target.
    let stat;
    try {
      stat = fs.statSync(src);
    } catch (error) {
      // A dangling link. Record it with the reason; the caller reports the list.
      state.skipped.push(`${src} (${error.code || 'unreadable'})`);
      continue;
    }
    if (stat.isDirectory()) {
      copyTreeDereferenced(src, dst, filter, state);
    } else if (filter(entry.name)) {
      fs.copyFileSync(src, dst);
    }
  }
  return state;
}

/**
 * Verify a built installer.
 *
 * Two independent checks, because the two historical failures were different things:
 *   - a stub (wrong size) is the spaced-path failure
 *   - a present-but-empty app.asar is the --prepackaged failure
 * Only the second catches an installer that is large but has no frontend, so both are needed.
 */
function verifyInstaller(installerPath, unpackedAsar, expectedAsar) {
  const problems = [];

  if (!fs.existsSync(installerPath)) {
    problems.push(`installer was not produced at ${installerPath}`);
    return { ok: false, problems, size: 0, asarBytes: 0, asarFiles: 0 };
  }
  const size = fs.statSync(installerPath).size;
  if (size < MIN_INSTALLER_BYTES) {
    problems.push(
      `installer is ${human(size)}, below the ${human(MIN_INSTALLER_BYTES)} floor. `
      + 'This is the R460 stub failure mode (0.18 MB instead of ~195 MB).');
  }

  let asarBytes = 0;
  let asarFiles = 0;
  if (!fs.existsSync(unpackedAsar)) {
    problems.push(`no app.asar at ${unpackedAsar}, so the payload cannot be checked`);
  } else {
    asarBytes = fs.statSync(unpackedAsar).size;
    let header;
    try {
      header = readAsarHeader(unpackedAsar);
    } catch (error) {
      problems.push(`app.asar header is unreadable: ${error.message}`);
      header = null;
    }
    if (header) {
      asarFiles = countAsarFiles(header);
      const flatten = (node, prefix = '', result = {}) => {
        for (const [name, child] of Object.entries(node.files || {})) {
          const relative = prefix + name;
          if (child.files) flatten(child, relative + '/', result);
          else result[relative] = { size: child.size, hash: child.integrity?.hash };
        }
        return result;
      };
      if (expectedAsar) {
        const expected = flatten(readAsarHeader(expectedAsar));
        const actual = flatten(header);
        // Builder applies its standard source-only exclusions (for example .d.ts).
        // Every emitted file must match the fresh payload, and executable/UI files must remain.
        const runtimeFile = name => /\.(?:cjs|mjs|js|html|css|json)$/i.test(name);
        if (Object.keys(actual).some(name => expected[name]?.size !== actual[name].size || expected[name]?.hash !== actual[name].hash) ||
            Object.keys(expected).some(name => runtimeFile(name) && !actual[name])) {
          problems.push('builder app.asar differs from the freshly built whitelist payload');
        }
      }
      for (const name of Object.keys(flatten(header))) {
        if (/(^|\/)(?:\.data|\.git|\.tmp|sessions|\.env(?:\..*)?|auth\.json|credentials\.json)(\/|$)/i.test(name)) {
          problems.push(`private state path in app.asar: ${name}`);
        }
      }
      for (const entry of REQUIRED_ASAR_ENTRIES) {
        if (!asarHas(header, entry)) {
          problems.push(
            `app.asar is missing ${entry}. An installer that packages without it is the `
            + '--prepackaged failure: a large file with no usable app inside.');
        }
      }
      // The frontend is what a --prepackaged run silently omits, because resources/ion-dist is a
      // junction. Check it exists and is substantial.
      if (!asarHas(header, 'resources/ion-dist')) {
        problems.push('app.asar has no resources/ion-dist: the UI would be missing entirely');
      }
    }
  }

  const resources = path.dirname(unpackedAsar);
  const allowedResources = new Set(['app.asar', 'agent-core', 'elevate.exe', 'default_app.asar']);
  if (fs.existsSync(resources)) for (const name of fs.readdirSync(resources)) {
    if (!allowedResources.has(name)) problems.push(`unexpected external resource: ${name}`);
  }
  try {
    resolveAgentCorePayload(resources);
    const core = path.join(resources, 'agent-core');
    const allowed = new Set(['manifest.json', 'bun', 'claude-code']);
    for (const name of fs.readdirSync(core)) if (!allowed.has(name)) problems.push(`unexpected agent-core entry: ${name}`);
    for (const name of fs.readdirSync(path.join(core, 'claude-code'))) {
      if (name !== 'dist') problems.push(`unexpected agent-core/claude-code entry: ${name}`);
    }
    const manifestText = fs.readFileSync(path.join(core, 'manifest.json'), 'utf8');
    const clean = JSON.stringify(resolveAgentCorePayload(resources).manifest);
    if (JSON.stringify(JSON.parse(manifestText)) !== clean) problems.push('agent-core manifest contains local metadata');
  } catch (error) { problems.push(`CCB payload verification failed: ${error.message}`); }
  return { ok: problems.length === 0, problems, size, asarBytes, asarFiles };
}

/**
 * Run a command, returning stdout; throws with context on failure.
 *
 * `shell` is OFF by default and the command is passed as an argv array. That matters concretely: with
 * shell:true on Windows, an executable path containing spaces ("C:\Program Files\nodejs\node.exe") is
 * split at the first space and the run dies with
 *     'C:\Program' is not recognized as an internal or external command
 * which is the same class of mistake as R460's NSIS quoting failure — an argument boundary lost to a
 * space. Passing argv directly avoids the shell entirely, so no quoting is involved.
 *
 * The one caller that needs a shell is electron-builder's .cmd shim, which cannot be executed without
 * one on Windows; it opts in explicitly and its path is space-free by construction (the staged tree).
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    stdio: options.stdio || 'pipe',
    encoding: 'utf8',
    env: options.env || process.env,
    shell: options.shell === true,
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-1500);
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${detail}`);
  }
  return result.stdout || '';
}

/**
 * Stage a copy of the project into a space-free directory and build the asar there.
 *
 * Only the inputs electron-builder needs are copied, and resources/ion-dist is dereferenced so the
 * junction cannot be skipped. node_modules is copied by link-free recursion; it is required for
 * electron-builder to resolve app-builder-lib.
 */
function stageProject(stageRoot, log) {
  const staged = path.join(stageRoot, 'app');
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true });

  const skipped = [];
  const copy = (from, to, filter) => {
    const state = copyTreeDereferenced(from, to, filter);
    skipped.push(...state.skipped);
  };

  const entries = [...SHIP, 'build', 'package.json', 'electron-builder.json'];
  for (const entry of entries) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) {
      if (entry === 'renderer') continue; // optional in some layouts
      throw new Error(`required input is missing: ${entry}`);
    }
    const stat = fs.statSync(src);
    fs.mkdirSync(path.dirname(path.join(staged, entry)), { recursive: true });
    if (stat.isDirectory()) copy(src, path.join(staged, entry));
    else fs.copyFileSync(src, path.join(staged, entry));
    log(`  staged ${entry}`);
  }

  // agent-core ships OUTSIDE the asar. Copy it whole — INCLUDING sourcemaps — because build.cjs
  // verifies the staged tree against manifest.json, and that manifest hashes the complete bundle
  // (1479 files, treeSha256 e7808bc2…). Dropping .map files here changes the tree hash and the build
  // aborts with "agent-core bundle differs from pinned manifest". The .map exclusion belongs to
  // electron-builder's extraResources filter, which runs later, at package time — not here.
  const agentSrc = path.join(ROOT, 'agent-core');
  if (!fs.existsSync(agentSrc)) throw new Error('agent-core is missing; run tools/setup-agent-core.cjs first');
  const payload = resolveAgentCorePayload(ROOT);
  for (const relative of payload.files) {
    const destination = path.join(staged, 'agent-core', relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(payload.core, relative), destination);
  }
  fs.writeFileSync(path.join(staged, 'agent-core', 'manifest.json'), JSON.stringify(payload.manifest, null, 2) + '\n');
  log('  staged agent-core (pinned files only, sourcemaps kept for manifest verification)');

  // node_modules: electron-builder needs app-builder-lib and the NSIS helpers.
  const nm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nm)) throw new Error('node_modules is missing; run npm install');
  copy(nm, path.join(staged, 'node_modules'));
  log('  staged node_modules');

  // Report what could not be copied. A dangling junction in resources/ is expected (ion-dist.broken-r373
  // points into WindowsApps); anything else is worth a look, so list them all rather than staying silent.
  if (skipped.length) {
    log(`  skipped ${skipped.length} unreadable entries:`);
    for (const item of skipped.slice(0, 10)) log(`    ${item}`);
    if (skipped.length > 10) log(`    ... and ${skipped.length - 10} more`);
  }

  // The staged frontend must be a real tree: this is the exact thing --prepackaged silently omitted.
  const stagedIon = path.join(staged, 'resources', 'ion-dist');
  if (!fs.existsSync(stagedIon) || !fs.readdirSync(stagedIon).length) {
    throw new Error('staged resources/ion-dist is missing or empty — the UI would not ship');
  }

  return staged;
}

function stageElectronRuntime(staged) {
  const source = path.join(staged, 'node_modules', 'electron', 'dist');
  const destination = path.join(staged, 'electron-runtime');
  if (fs.existsSync(destination)) throw new Error('clean Electron runtime destination already exists');
  fs.cpSync(source, destination, { recursive: true, filter: file => {
    const relative = path.relative(source, file).replace(/\\/g, '/');
    return !relative.startsWith('resources/') || relative === 'resources/default_app.asar';
  } });
  return destination;
}

/** Build the asar for the staged tree, then run electron-builder. */
function createInstallerConfig(base, staged, icon) {
  if (!icon) throw new Error('installer icon is required; pass --icon path/to/app.ico');
  const iconPath = path.resolve(staged, icon);
  const bytes = fs.readFileSync(iconPath);
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1 || !bytes.readUInt16LE(4)) {
    throw new Error('installer icon must be a valid ICO file');
  }
  return {
    ...base,
    directories: { ...base.directories, app: 'dist-asar/resources/app', output: 'release' },
    electronDist: path.join(staged, 'electron-runtime'),
    files: ['**/*'],
    extraResources: [{ from: 'dist-asar/resources/agent-core', to: 'agent-core', filter: ['**/*'] }],
    extraMetadata: { ...base.extraMetadata, main: 'desktop/main.cjs' },
    win: { ...base.win, icon: iconPath, signAndEditExecutable: true, signExecutable: false },
    nsis: { ...base.nsis, installerIcon: iconPath, uninstallerIcon: iconPath },
    npmRebuild: false,
  };
}

function buildInstaller(staged, log, icon) {
  // Build the asar from the STAGED tree, not from the live release/, so a stale app.asar cannot be
  // packaged. This is what makes --prepackaged unnecessary rather than merely discouraged.
  log('building app.asar from the staged tree');
  run(process.execPath, [path.join(staged, 'build', 'build.cjs'), '--target', 'asar', '--out',
    path.join(staged, 'dist-asar'), '--keep-app'], { cwd: staged, stdio: 'inherit' });

  const producedAsar = path.join(staged, 'dist-asar', 'resources', 'app.asar');
  if (!fs.existsSync(producedAsar)) throw new Error('build.cjs reported success but produced no app.asar');

  // Stage a win-unpacked-shaped directory electron-builder can reuse as --prepackaged input? No: that is
  // exactly the shortcut that shipped a UI-less installer. Run the real packaging step instead.
  log('running electron-builder (no --prepackaged)');
  stageElectronRuntime(staged);
  // Invoke electron-builder's JS entry with this node binary rather than its .cmd shim. The shim needs a
  // shell, and a shell re-introduces argument splitting — the failure that produced R460's stub. Running
  // the script through execPath passes every argument as a separate argv element, no quoting involved.
  const builderCli = path.join(staged, 'node_modules', 'electron-builder', 'cli.js');
  if (!fs.existsSync(builderCli)) throw new Error(`electron-builder cli.js not found at ${builderCli}`);

  const config = createInstallerConfig(JSON.parse(fs.readFileSync(path.join(staged, 'electron-builder.json'), 'utf8')), staged, icon);
  const configPath = path.join(staged, 'installer-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  run(process.execPath, [builderCli, '--win', '--x64', '--config', configPath, '--publish', 'never'], {
    cwd: staged, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });

  const installerDir = path.join(staged, 'release');
  const installers = fs.existsSync(installerDir)
    ? fs.readdirSync(installerDir).filter((f) => f.endsWith('.exe') && !f.includes('__uninstaller'))
    : [];
  if (!installers.length) throw new Error('electron-builder produced no installer');

  return {
    installer: path.join(installerDir, installers[0]),
    unpackedAsar: path.join(installerDir, 'win-unpacked', 'resources', 'app.asar'),
    expectedAsar: producedAsar,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const log = (line) => console.log(line);

  log('=== package installer ===');
  log(`  project:  ${ROOT}`);
  log(`  config:   ${BUILDER_CONFIG}`);

  const spaces = /\s/.test(ROOT);
  if (spaces) {
    log('  NOTE: the project path contains spaces. That is what broke NSIS quoting in R460, so the');
    log('        build is staged into a space-free directory instead of being run here.');
  }

  log('  frontend: '+JSON.stringify(require('./check-frontend.cjs').check(ROOT)));
  // Preconditions worth stating up front rather than discovering after a long build.
  for (const rel of ['agent-core/manifest.json', 'agent-core/bun/bun.exe',
    'agent-core/claude-code/dist/cli-bun.js', 'resources/ion-dist', 'node_modules']) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) throw new Error(`precondition failed: ${rel} is missing`);
  }
  const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  if (!fs.existsSync(builderCli)) throw new Error('electron-builder CLI is missing');
  const builderVersion = require(path.join(ROOT, 'node_modules', 'electron-builder', 'package.json')).version;
  log(`  electron-builder: ${builderVersion}`);
  log('  preconditions: agent-core payload, ion-dist and node_modules all present');
  const baseConfig = JSON.parse(fs.readFileSync(BUILDER_CONFIG, 'utf8'));
  options.icon = options.icon || baseConfig.win?.icon;
  if (options.icon) createInstallerConfig(baseConfig, ROOT, options.icon);
  log(`  icon: ${options.icon || 'pending: pass --icon path/to/app.ico before final packaging'}`);

  const stageRoot = chooseStageRoot(options.stage);
  log(`  stage:    ${stageRoot}`);

  if (options.dryRun) {
    log('\ndry run: would stage, build the asar, run electron-builder, then verify.');
    log(`  installer floor: ${human(MIN_INSTALLER_BYTES)}`);
    log(`  required asar entries: ${REQUIRED_ASAR_ENTRIES.join(', ')}, resources/ion-dist`);
    return;
  }

  if (!options.icon) throw new Error('installer icon is required; pass --icon path/to/app.ico');
  let succeeded = false;
  try {
    log('\nstaging');
    // The stage is owned by this invocation; never recursively delete a caller's existing tree.
    fs.mkdirSync(stageRoot, { recursive: false });
    const staged = stageProject(stageRoot, log);
    const iconSource = options.icon && path.resolve(ROOT, options.icon);
    if (!iconSource) throw new Error('installer icon is required; pass --icon path/to/app.ico');
    const stagedIcon = path.join(staged, 'installer.ico');
    fs.copyFileSync(iconSource, stagedIcon);

    log('\npackaging');
    const built = buildInstaller(staged, log, stagedIcon);

    log('\nverifying');
    const verdict = verifyInstaller(built.installer, built.unpackedAsar, built.expectedAsar);
    log(`  installer: ${human(verdict.size)}`);
    log(`  app.asar:  ${human(verdict.asarBytes)}, ${verdict.asarFiles} entries`);

    if (!verdict.ok) {
      log('\nVERIFICATION FAILED:');
      verdict.problems.forEach((p) => log(`  - ${p}`));
      log('\nThe built installer was left in place for inspection: ' + built.installer);
      process.exitCode = 1;
      return;
    }

    // Copy the result next to the project so it is where a user expects it.
    fs.mkdirSync(RELEASE, { recursive: true });
    const target = path.join(RELEASE, path.basename(built.installer));
    fs.copyFileSync(built.installer, target);
    const blockmap = built.installer + '.blockmap';
    if (fs.existsSync(blockmap)) fs.copyFileSync(blockmap, target + '.blockmap');

    log(`\nwrote ${target}`);
    log('verification passed');
    succeeded = true;
  } finally {
    // On failure the stage is the only evidence of what went wrong, so keep it and say where it is.
    // On success it is ~1 GB of duplicated inputs with no further use.
    if (succeeded && !options.keepStage) {
      try { fs.rmSync(stageRoot, { recursive: true, force: true }); log(`removed stage ${stageRoot}`); }
      catch (error) { log(`could not remove stage ${stageRoot}: ${error.message}`); }
    } else if (succeeded) {
      log(`kept stage ${stageRoot}`);
    } else {
      log(`\nstage kept for inspection: ${stageRoot}`);
    }
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`packaging failed: ${error.message}`); process.exitCode = 1; }
}
module.exports = { stageElectronRuntime, parseArgs, createInstallerConfig, verifyInstaller, readAsarHeader, chooseStageRoot };
