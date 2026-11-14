// getGitInfo must describe a real repository.
//
// The Changes pane and the branch label read it (shared-11-Ci0VQatJ.js):
//
//   let {git, dir} = ...
//   if (a === undefined || t.repo.toLowerCase() !== a.toLowerCase()) return false
//   ... t.root, t.trees[].folder, t.branch, t.defaultBranch
//
// The fallback answered null, which the pane treats as "not a repository" and
// renders empty — indistinguishable from a clean tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 's', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => null,
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { call };
}

/** Create a throwaway repository; returns its path, or null when git is absent. */
function makeRepo({ remote } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gitinfo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  try {
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    git('add', '.');
    git('commit', '-m', 'init');
    if (remote) git('remote', 'add', 'origin', remote);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return dir;
}

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

test('a real repository is described, not reported as absent', { skip: !hasGit }, async (t) => {
  const { call } = makeBridge();
  const repo = makeRepo({ remote: 'https://github.com/acme/widget.git' });
  // A repository that cannot be created is an environment failure, not a pass. Skipping
  // with a reason keeps it visible in the report instead of vanishing as green.
  if (!repo) return t.skip('git could not create a temporary repository on this host');
  try {
    const info = await call('LocalSessions', 'getGitInfo', repo);
    assert.ok(info, 'a null answer makes the Changes pane look empty');
    assert.equal(info.isRepo, true);
    assert.equal(info.repo, 'acme/widget', 'the UI compares repo as owner/name');
    assert.equal(typeof info.root, 'string');
    assert.ok(info.root.length > 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the branch name is reported', { skip: !hasGit }, async (t) => {
  const { call } = makeBridge();
  const repo = makeRepo();
  // A repository that cannot be created is an environment failure, not a pass. Skipping
  // with a reason keeps it visible in the report instead of vanishing as green.
  if (!repo) return t.skip('git could not create a temporary repository on this host');
  try {
    const info = await call('LocalSessions', 'getGitInfo', repo);
    assert.equal(typeof info.branch, 'string');
    assert.ok(info.branch.length > 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an ssh remote yields owner/name too', { skip: !hasGit }, async (t) => {
  const { call } = makeBridge();
  const repo = makeRepo({ remote: 'git@github.com:acme/widget.git' });
  // A repository that cannot be created is an environment failure, not a pass. Skipping
  // with a reason keeps it visible in the report instead of vanishing as green.
  if (!repo) return t.skip('git could not create a temporary repository on this host');
  try {
    const info = await call('LocalSessions', 'getGitInfo', repo);
    assert.equal(info.repo, 'acme/widget');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a folder outside any repository reports isRepo:false instead of inventing one', async () => {
  const { call } = makeBridge();
  const outside = mkdtempSync(join(tmpdir(), 'notrepo-'));
  try {
    const info = await call('LocalSessions', 'getGitInfo', outside);
    assert.equal(info.isRepo, false);
    assert.equal(info.repo, '');
    assert.equal(info.root, null);
    assert.deepEqual(info.trees, []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a nonexistent folder does not throw', async () => {
  // The pane passes whatever folder the session uses; a deleted one must not break it.
  const { call } = makeBridge();
  const info = await call('LocalSessions', 'getGitInfo', join(tmpdir(), 'definitely-not-here-xyz'));
  assert.equal(info.isRepo, false);
});

test('trees lists the worktree folder when inside a repo', { skip: !hasGit }, async (t) => {
  const { call } = makeBridge();
  const repo = makeRepo();
  // A repository that cannot be created is an environment failure, not a pass. Skipping
  // with a reason keeps it visible in the report instead of vanishing as green.
  if (!repo) return t.skip('git could not create a temporary repository on this host');
  try {
    const info = await call('LocalSessions', 'getGitInfo', repo);
    assert.ok(Array.isArray(info.trees));
    assert.ok(info.trees.length >= 1);
    assert.equal(typeof info.trees[0].folder, 'string');
    assert.equal(info.trees[0].removed, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});