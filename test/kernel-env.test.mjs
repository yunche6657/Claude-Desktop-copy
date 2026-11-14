// The kernel child's environment: a writable scratch dir and a spawnable bash.
//
// Both fixes are pinned here because each one, missing, produced a symptom that blamed the
// wrong layer (evidence/ccb-kernel-environment.md):
//   - unwritable TEMP  -> the Bash TOOL reports EPERM on mkdir under %TEMP%\claude
//   - bash.cmd on PATH -> the Bash TOOL reports "Exit code 126 / [Request interrupted...]"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildKernelEnv, findBashDir, defaultScratchDir, BASH_DIR_CANDIDATES } = require('../desktop/kernel-env.cjs');

/** A fake filesystem: only the listed paths exist. */
const fakeFs = (paths) => (file) => paths.some((candidate) => path.resolve(candidate) === path.resolve(file));

test('CCB home is isolated without changing the parent profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-home-'));
  const homeDir = path.join(dir, 'ccb-home');
  const base = { HOME: 'parent', USERPROFILE: 'parent', CLAUDE_CONFIG_DIR: 'parent-config' };
  const built = buildKernelEnv({ base, homeDir, platform: 'linux' });
  assert.equal(built.env.HOME, homeDir);
  assert.equal(built.env.USERPROFILE, homeDir);
  assert.equal(built.env.CLAUDE_CONFIG_DIR, homeDir);
  assert.equal(base.HOME, 'parent');
  assert.equal(base.CLAUDE_CONFIG_DIR, 'parent-config');
  assert.equal(built.applied.homeDir, homeDir);
  fs.writeFileSync(path.join(homeDir, '.claude.json'), '{}');
});

test('an unusable explicit kernel home fails before spawning CCB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-home-'));
  const file = path.join(dir, 'file');
  fs.writeFileSync(file, 'not a directory');
  assert.throws(() => buildKernelEnv({ base: {}, homeDir: path.join(file, 'child') }));
});

test('the scratch directory becomes TEMP, TMP and TMPDIR together', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-env-'));
  const scratch = path.join(dir, 'scratch');
  const built = buildKernelEnv({ base: {}, scratchDir: scratch, platform: 'linux' });
  assert.equal(built.env.TEMP, scratch);
  assert.equal(built.env.TMP, scratch);
  assert.equal(built.env.TMPDIR, scratch);
  assert.equal(built.applied.scratchDir, scratch);
  // The directory must exist afterwards: the kernel assumes its TEMP root exists.
  assert.ok(fs.existsSync(scratch));
});

test('the scratch directory is created, not just named', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-env-'));
  const scratch = path.join(dir, 'deep', 'nested', 'scratch');
  buildKernelEnv({ base: {}, scratchDir: scratch, platform: 'linux' });
  assert.ok(fs.existsSync(scratch));
});

test('no scratch directory is a warning, not a silent default', () => {
  const built = buildKernelEnv({ base: {}, scratchDir: null, platform: 'linux' });
  assert.equal(built.applied.scratchDir, null);
  assert.ok(built.warnings.some((line) => /ambient TEMP/.test(line)));
});

test('a real bash.exe directory is prepended to PATH, not substituted for it', () => {
  const base = { PATH: 'C:\\other;D:\\more', Path: 'C:\\other;D:\\more' };
  const built = buildKernelEnv({
    base,
    scratchDir: null,
    platform: 'win32',
    exists: fakeFs(['C:\\Program Files\\Git\\bin\\bash.exe']),
  });
  assert.equal(built.applied.bashDir, 'C:\\Program Files\\Git\\bin');
  assert.equal(built.env.PATH, 'C:\\Program Files\\Git\\bin;C:\\other;D:\\more');
  // Both spellings are set: Node reads Path on Windows, but child processes and some
  // libraries read PATH, and a mismatch shows up as "the shell has a different PATH".
  assert.equal(built.env.Path, built.env.PATH);
});

test('a bash.cmd shim does not count as a usable bash', () => {
  // Measured on this host: where bash -> C:\Users\...\.local\bin\bash.cmd, which cannot
  // be spawned; the kernel then answers "Exit code 126".
  const dir = findBashDir({
    exists: fakeFs(['C:\\Users\\x\\.local\\bin\\bash.cmd']),
    candidates: ['C:\\Users\\x\\.local\\bin'],
  });
  assert.equal(dir, null, 'a .cmd shim must not satisfy the check');
});

test('findBashDir requires bash.exe specifically', () => {
  const found = findBashDir({ exists: fakeFs(['C:\\Program Files\\Git\\bin\\bash.exe']) });
  assert.equal(found, 'C:\\Program Files\\Git\\bin');
  assert.equal(findBashDir({ exists: () => false }), null);
});

test('the candidate list covers both Program Files spellings and usr/bin', () => {
  assert.ok(BASH_DIR_CANDIDATES.some((dir) => /Git\\bin$/.test(dir)));
  assert.ok(BASH_DIR_CANDIDATES.some((dir) => /\(x86\)/.test(dir)));
  assert.ok(BASH_DIR_CANDIDATES.some((dir) => /Git\\usr\\bin$/.test(dir)));
});

test('a Windows host with no bash anywhere says what will break', () => {
  const built = buildKernelEnv({ base: {}, scratchDir: null, platform: 'win32', exists: () => false });
  assert.equal(built.applied.bashDir, null);
  assert.ok(built.warnings.some((line) => /exit 126/.test(line)));
});

test('a non-Windows host is left alone', () => {
  const base = { PATH: '/usr/bin:/bin' };
  const built = buildKernelEnv({ base, scratchDir: null, platform: 'linux', exists: () => true });
  assert.equal(built.env.PATH, '/usr/bin:/bin');
  assert.equal(built.applied.bashDir, null);
  assert.ok(built.notes.some((line) => /not Windows/.test(line)));
});

test('the base environment is copied, never mutated', () => {
  const base = { PATH: 'X', KEEP: 'yes' };
  const built = buildKernelEnv({ base, scratchDir: null, platform: 'win32', exists: () => true });
  assert.equal(base.PATH, 'X');
  assert.equal(built.env.KEEP, 'yes');
  assert.notEqual(built.env, base);
});

test('the default scratch directory lives inside the workspace', () => {
  const scratch = defaultScratchDir('C:\\work\\project');
  assert.equal(scratch, path.join('C:\\work\\project', '.tmp'));
  // Without a workspace it degrades to a named temp directory rather than to nothing.
  assert.match(defaultScratchDir(null), /ccb-scratch$/);
});

test('this host really has neither of the two problems after applying the policy', () => {
  // A live check of the real machine: the policy must reach a state where a bash.exe is
  // found and a scratch directory can be created. If this fails, the kernel's shell tool is
  // broken on this host and the failure message would blame the tool.
  const built = buildKernelEnv({ base: process.env, scratchDir: defaultScratchDir(process.cwd()), platform: process.platform });
  assert.equal(built.warnings.length, 0, 'the real host must satisfy the policy: ' + built.warnings.join('; '));
  assert.ok(fs.existsSync(built.applied.scratchDir));
  if (process.platform === 'win32') assert.ok(built.applied.bashDir);
});
