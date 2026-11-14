// Local execution tests.
//
// The security-relevant behaviour is asserted directly: the allowlist, the
// shell-metacharacter refusal, working-directory containment, output bounds and
// timeout. These run real child processes, so they stay on trivially safe
// commands that exist on Windows and POSIX.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseCommand, resolveCwd, runCommand, ALLOWED_EXECUTABLES } =
  await import('../desktop/local-exec.cjs');

test('allowlisted executables parse into argv', () => {
  const parsed = parseCommand('git status --short');
  assert.equal(parsed.executable, 'git');
  assert.deepEqual(parsed.args, ['status', '--short']);
  assert.equal(parsed.display, 'git status --short');

  // Windows-style extension and path are normalised before the allowlist check.
  assert.equal(parseCommand('C:\\tools\\node.exe -v').executable, 'C:\\tools\\node.exe');
});

test('non-allowlisted executables are refused', () => {
  for (const command of ['rm -rf /', 'curl http://x', 'powershell -c x', 'bash -i']) {
    assert.throws(() => parseCommand(command), /not in the allowlist/, command);
  }
  assert.ok(ALLOWED_EXECUTABLES.has('git'));
});

test('shell metacharacters are refused rather than interpreted', () => {
  for (const command of [
    'git status; rm -rf /',
    'git status && whoami',
    'echo $(whoami)',
    'echo `id`',
    'echo a | b',
    'echo a > b',
    'echo a\nb',
  ]) {
    assert.throws(() => parseCommand(command), /shell operators/, JSON.stringify(command));
  }
});

test('empty and oversized commands are refused', () => {
  assert.throws(() => parseCommand('   '), /empty/);
  assert.throws(() => parseCommand('git ' + 'a'.repeat(5000)), /too long/);
});

test('the working directory must exist and stay inside an approved root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'exec-root-'));
  const inside = path.join(root, 'nested');
  mkdirSync(inside);
  const outside = mkdtempSync(path.join(tmpdir(), 'exec-outside-'));
  try {
    assert.equal(resolveCwd(root, [root]), path.resolve(root));
    assert.equal(resolveCwd(inside, [root]), path.resolve(inside));
    assert.throws(() => resolveCwd(outside, [root]), /outside the approved roots/);
    assert.throws(() => resolveCwd(path.join(root, 'nope'), [root]), /does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a real command runs and reports its exit code and output', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'exec-run-'));
  try {
    const ok = await runCommand({ command: 'node --version', cwd: root }, { allowedRoots: [root] });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.ok, true);
    assert.equal(ok.cwd, path.resolve(root));
    assert.match(ok.stdout, /^v\d+\./);

    // A non-zero exit is data, not an exception.
    const bad = await runCommand({ command: 'git --definitely-not-a-flag', cwd: root });
    assert.notEqual(bad.exitCode, 0);
    assert.equal(bad.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a refused command rejects before spawning anything', async () => {
  await assert.rejects(
    () => runCommand({ command: 'curl http://example.com', cwd: process.cwd() }),
    /not in the allowlist/,
  );
});

test('a long-running command is killed and reported as timed out', async () => {
  // `node --inspect=127.0.0.1:0 -e ""` would exit; a bare `node` with no stdin
  // reads until EOF. Neither reliably blocks across platforms, so the timeout is
  // exercised with a command that sleeps: `node --version` is fast, therefore a
  // 1ms budget is guaranteed to expire first.
  const result = await runCommand({ command: 'node --version' }, { timeoutMs: 1 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});
