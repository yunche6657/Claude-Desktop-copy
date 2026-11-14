import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createGitStatus } = require('../desktop/git-status.cjs');

test('IPC working-tree status follows the existing saved-trust decision', async t => {
  const { dir, git } = fixture(t);
  const previousStore = process.env.CLAUDE_TRUST_STORE;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-git-trust-'));
  process.env.CLAUDE_TRUST_STORE = path.join(isolated, 'trust.json');
  process.env.CLAUDE_CONFIG_DIR = isolated;
  const handlers = new Map();
  const bridge = require('../desktop/bridge-services.cjs').registerBridgeServices({
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => null,
    settings: {}, frontend: { root: dir },
  });
  t.after(() => {
    bridge.dispose();
    if (previousStore === undefined) delete process.env.CLAUDE_TRUST_STORE; else process.env.CLAUDE_TRUST_STORE = previousStore;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    fs.rmSync(isolated, { recursive: true, force: true });
  });
  const call = (method, ...args) => {
    const key = [...handlers.keys()].find(key => key.includes('_$_LocalSessions_$_') && key.endsWith(`_$_${method}`));
    assert.ok(key, method);
    return handlers.get(key)({}, ...args);
  };
  await call('saveTrust', dir, false);
  assert.equal(await call('getWorkingTreeStatus', dir), null);
  assert.equal(await call('getGitDiff', dir, 'HEAD'), null);
  assert.equal(await call('getGitCommits', dir, 'HEAD'), null);
  assert.deepEqual(await call('getLocalBranches', dir), ['main']);
  assert.equal((await call('saveTrust', dir, true)).ok, true);
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new');
  fs.writeFileSync(path.join(dir, 'text.txt'), 'one\ntwo\nthree\n');
  const result = await call('getWorkingTreeStatus', dir);
  assert.ok(result.files.some(file => file.path === 'new.txt' && file.status === '??'));
  assert.equal(typeof result.additions, 'number');
  const diff = await call('getGitDiff', dir, 'HEAD');
  assert.ok(diff.files.some(file => file.filename === 'text.txt' && file.additions === 1));
  const stats = await call('getGitDiffStats', dir, 'HEAD');
  assert.equal(stats.fileCount, 2);
  assert.deepEqual(await call('getDiffFileContent', dir, diff.merge_base, 'text.txt'), { oldText: 'one\ntwo\n', newText: 'one\ntwo\nthree\n' });
  assert.match(await call('getGitDiffFilePatch', dir, diff.merge_base, 'text.txt'), /\+three/);
  assert.deepEqual(await call('getGitCommits', dir, 'HEAD'), []);
  const commit = await call('getCommitDiff', dir, git('rev-parse', 'HEAD'));
  assert.ok(commit.files.some(file => file.filename === 'text.txt'));
  await call('saveTrust', dir, false);
  assert.equal(await call('getWorkingTreeStatus', dir), null);
});

function fixture(t, commit = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-git-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Bridge Test');
  git('config', 'user.email', 'bridge@example.invalid');
  git('config', 'core.autocrlf', 'false');
  if (commit) {
    fs.writeFileSync(path.join(dir, 'text.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    git('add', '.'); git('commit', '-m', 'initial');
  }
  return { dir, git, service: createGitStatus({ isTrusted: () => true }) };
}

test('local branches include packed and loose refs, sort by native localeCompare, and exclude remote refs', async t => {
  const { dir, git, service } = fixture(t);
  git('branch', 'zeta'); git('branch', 'feature/alpha'); git('pack-refs', '--all');
  git('branch', 'Beta'); git('update-ref', 'refs/remotes/origin/remote-only', 'HEAD');
  assert.deepEqual(await service.getLocalBranches(dir), ['main', 'zeta', 'feature/alpha', 'Beta'].sort((a,b) => a.localeCompare(b)));
  git('checkout', '--detach');
  assert.deepEqual(await service.getLocalBranches(dir), ['main', 'zeta', 'feature/alpha', 'Beta'].sort((a,b) => a.localeCompare(b)));
});

test('working tree reports actual staged rename, text counts, binary changes and Unicode untracked files', async t => {
  const { dir, git, service } = fixture(t);
  git('mv', 'text.txt', 'renamed name.txt');
  fs.writeFileSync(path.join(dir, 'renamed name.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'image.bin'), Buffer.from([0, 5, 6, 7]));
  fs.writeFileSync(path.join(dir, '新建 文件.txt'), 'not counted in numstat\n');
  const result = await service.getWorkingTreeStatus(dir);
  assert.deepEqual(result.files.find(x => x.path.includes(' -> ')), { status: 'RM', path: 'text.txt -> renamed name.txt' });
  assert.deepEqual(result.files.find(x => x.path === 'image.bin'), { status: ' M', path: 'image.bin' });
  assert.deepEqual(result.files.find(x => x.path === '新建 文件.txt'), { status: '??', path: '新建 文件.txt' });
  assert.equal(result.additions, 1); assert.equal(result.deletions, 0);
});

test('unborn HEAD keeps status but counts zero because native numstat failure is swallowed', async t => {
  const { dir, service } = fixture(t, false);
  fs.writeFileSync(path.join(dir, 'first.txt'), 'first\n');
  assert.deepEqual(await service.getLocalBranches(dir), []);
  assert.deepEqual(await service.getWorkingTreeStatus(dir), { files: [{ status: '??', path: 'first.txt' }], additions: 0, deletions: 0 });
});

test('clean tree, non-repository and missing cwd preserve native negative contracts', async t => {
  const { dir, service } = fixture(t);
  assert.deepEqual(await service.getWorkingTreeStatus(dir), { files: [], additions: 0, deletions: 0 });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-not-repo-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.equal(await service.getWorkingTreeStatus(outside), null);
  assert.deepEqual(await service.getLocalBranches(outside), []);
  assert.equal(await service.getWorkingTreeStatus(path.join(outside, 'missing')), null);
});

test('trust and workspace callbacks stop git execution before any repository reads', async () => {
  let calls = 0;
  const run = () => { calls++; throw Error('unexpected execution'); };
  const dir = path.resolve('.');
  const denied = createGitStatus({ run, isCwdAllowed: async () => false, isTrusted: () => true });
  assert.deepEqual(await denied.getLocalBranches(dir), []);
  assert.equal(await denied.getWorkingTreeStatus(dir), null);
  const untrusted = createGitStatus({ run });
  assert.equal(await untrusted.getWorkingTreeStatus(dir), null);
  assert.equal(calls, 0);
});

test('index-hidden assume-unchanged and skip-worktree paths are surfaced like native status helper', async t => {
  const { dir, git, service } = fixture(t);
  git('update-index', '--assume-unchanged', 'text.txt');
  git('update-index', '--skip-worktree', 'image.bin');
  const result = await service.getWorkingTreeStatus(dir);
  assert.deepEqual(result.files.sort((a,b) => a.path.localeCompare(b.path)), [
    { status: ' M', path: 'image.bin' }, { status: ' M', path: 'text.txt' },
  ]);
});

test('conflicted merge preserves the unmerged XY status instead of reporting clean', async t => {
  const { dir, git, service } = fixture(t);
  git('checkout', '-b', 'other'); fs.writeFileSync(path.join(dir, 'text.txt'), 'other\n');
  git('commit', '-am', 'other'); git('checkout', 'main');
  fs.writeFileSync(path.join(dir, 'text.txt'), 'main\n'); git('commit', '-am', 'main');
  assert.throws(() => git('merge', 'other'));
  const result = await service.getWorkingTreeStatus(dir);
  assert.deepEqual(result.files.find(x=>x.path === 'text.txt'), { status: 'UU', path: 'text.txt' });
});

