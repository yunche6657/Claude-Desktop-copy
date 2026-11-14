// Environment the CCB kernel children need on this host, and why.
//
// Both of these were measured on 2026-10-23 (evidence/ccb-kernel-environment.md). Each one
// produced a misleading symptom that pointed at the wrong layer:
//
//   1. %TEMP%\claude\... is not writable for the child process.
//      The kernel keeps per-session scratch state under %TEMP%\claude\<cwd-slug>\<uuid>.
//      When that mkdir fails, the **Bash tool** reports
//         EPERM: operation not permitted, mkdir '...\\Temp\\claude\\...'
//      which reads like a tool bug. It is an environment bug: the same directory is
//      writable from a normal shell, and pointing TEMP at a workspace-local folder makes
//      the tool work.
//
//   2. `bash` on PATH is a .cmd shim, not an executable.
//      Measured: `where bash` -> C:\Users\Administrator\.local\bin\bash.cmd
//      A .cmd cannot be spawned as a program, so the kernel's Bash tool fails with
//         Exit code 126
//         [Request interrupted by user for tool use]
//      "126" means found-but-not-executable; the "[Request interrupted...]" wrapper is the
//      kernel's way of reporting that it never got a usable shell. Prepending Git's bin
//      directory (which holds a real bash.exe) fixes it — measured output "SH_OK".
//
// Both belong in ONE place: a launch that sets one and forgets the other produces a kernel
// whose shell tool fails for a reason that has nothing to do with the shell.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Where a real bash.exe is likely to live, in preference order, on Windows. */
const BASH_DIR_CANDIDATES = Object.freeze([
  'C:\\Program Files\\Git\\bin',
  'C:\\Program Files (x86)\\Git\\bin',
  'C:\\Program Files\\Git\\usr\\bin',
]);

/**
 * Find a directory that actually contains bash.exe.
 *
 * Deliberately checks for `bash.exe`, not `bash`: on this host a `bash.cmd` earlier on
 * PATH shadowed the real binary, and a checker that accepted "some file named bash" would
 * have declared the environment fine.
 */
function findBashDir({ exists = (file) => fs.existsSync(file), candidates = BASH_DIR_CANDIDATES } = {}) {
  for (const dir of candidates) {
    if (exists(path.join(dir, 'bash.exe'))) return dir;
  }
  return null;
}

/**
 * Build the environment a CCB child should run with.
 *
 * @param {{
 *   base?: object,                    // process.env by default
 *   scratchDir?: string,              // where TEMP/TMP should point
 *   exists?: (file: string) => boolean,
 *   platform?: string,
 *   candidates?: readonly string[],
 * }} opts
 * @returns {{env: object, applied: {scratchDir: string|null, bashDir: string|null},
 *            notes: string[], warnings: string[]}}
 */
function buildKernelEnv({
  base = process.env,
  scratchDir = null,
  homeDir = null,
  exists = (file) => fs.existsSync(file),
  platform = process.platform,
  candidates = BASH_DIR_CANDIDATES,
} = {}) {
  const env = { ...base };
  const notes = [];
  const warnings = [];

  // CCB writes ~/.claude.json during initialization. Give the child its own
  // writable home so it neither fails on the host profile nor imports a
  // different CLI gateway from the user's settings. Never mutate the host env.
  let appliedHome = null;
  if (homeDir) {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.accessSync(homeDir, fs.constants.W_OK);
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
    env.CLAUDE_CONFIG_DIR = homeDir;
    appliedHome = homeDir;
    notes.push(`kernel home directory is ${homeDir}`);
  }

  // 1. A writable scratch directory.
  //
  // The kernel appends its own `claude` subdirectory, so pointing TEMP at
  // <workspace>/.tmp puts everything under <workspace>/.tmp/claude/<slug>/<uuid> — inside
  // the tree we control, which is also what makes the state inspectable after a failure.
  let appliedScratch = null;
  if (scratchDir) {
    try {
      fs.mkdirSync(scratchDir, { recursive: true });
      appliedScratch = scratchDir;
      env.TEMP = scratchDir;
      env.TMP = scratchDir;
      env.TMPDIR = scratchDir;
      notes.push(`kernel scratch directory is ${scratchDir}`);
    } catch (error) {
      warnings.push(`could not create the kernel scratch directory ${scratchDir}: ${error && error.message}`);
    }
  } else {
    warnings.push('no scratch directory given; the kernel will use the ambient TEMP, which may be unwritable');
  }

  // 2. A spawnable bash, on Windows only.
  let appliedBash = null;
  if (platform === 'win32') {
    const bashDir = findBashDir({ exists, candidates });
    if (bashDir) {
      const current = env.PATH || env.Path || '';
      // Prepend rather than replace: the shell tool still needs the rest of PATH (git,
      // node, the project's own tooling), and prepending is what makes the real bash.exe
      // win over the .cmd shim.
      const separated = current ? `${bashDir};${current}` : bashDir;
      env.PATH = separated;
      env.Path = separated;
      appliedBash = bashDir;
      notes.push(`bash comes from ${bashDir} (prepended to PATH)`);
    } else {
      warnings.push('no bash.exe found in the usual Git locations; the kernel Bash tool will fail with exit 126');
    }
  } else {
    notes.push('not Windows; PATH left alone');
  }

  return { env, applied: { scratchDir: appliedScratch, bashDir: appliedBash, homeDir: appliedHome }, notes, warnings };
}

/** The scratch directory a session should use: <workspace>/.tmp when the workspace is known. */
function defaultScratchDir(workspaceRoot) {
  if (!workspaceRoot) return path.join(os.tmpdir(), 'ccb-scratch');
  return path.join(workspaceRoot, '.tmp');
}

module.exports = { BASH_DIR_CANDIDATES, buildKernelEnv, findBashDir, defaultScratchDir };
