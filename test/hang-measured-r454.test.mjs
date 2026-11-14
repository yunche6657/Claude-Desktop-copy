// R454: the hang is REAL — measured, not inferred.
//
// R453 concluded from source that `git add -p` would block on an open stdin pipe for 30 minutes. That
// was an inference. This round reproduced the spawn configuration and measured it.
//
// THE FIRST EXPERIMENT WAS INVALID
//   v1 used Python's subprocess.communicate(), which CLOSES the stdin pipe before waiting. The child
//   saw EOF instantly, so `git add -p` "finished" in 0.08s and the experiment appeared to disprove
//   the inference. It had actually measured EOF behaviour, not blocking behaviour.
//
//   Fix: Popen(stdin=PIPE) then .wait(timeout) WITHOUT touching stdin, so the pipe stays open and
//   empty — exactly what Shell.ts's spawn does (stdio: ['pipe','pipe','pipe'], nothing written).
//
// A CONTROL PROVES THE SETUP
//   bash -c 'read x'   -> BLOCKED at 6s   (an open empty pipe does block a stdin read)
//   bash -c 'echo hi'  -> exited in 0.17s (a non-reader is unaffected)
//
//   Without that control, "git add -p blocked" would only mean "my harness blocks everything".
//
// MEASURED RESULTS (6-second cap)
//   git add -p                        BLOCKS
//   git add -i                        BLOCKS
//   git add -p  + GIT_EDITOR=true     BLOCKS   <- the editor stub does NOT help
//   git rebase -i + GIT_EDITOR=true   exits 0.17s
//
// THE SECOND LINE IS THE FINDING
//   GIT_EDITOR='true' (Shell.ts:358) makes `rebase -i` safe, because git falls back to $EDITOR for
//   the todo list. But `add -p` reads stdin DIRECTLY — no editor is involved, so the stub is
//   irrelevant. R453 said this; R454 shows it.
//
// WITH DEFAULT_TIMEOUT = 30 MINUTES
//   A model that runs `git add -p` stalls the session for 30 minutes. Nothing in the code rejects the
//   flag (R453), so the only protection is the prompt sentence asking the model not to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');

/**
 * A real bash binary. `bash` on PATH resolves to bash.CMD here, which Node's spawn cannot launch
 * without a shell — the control case failed with `blocked: null` until this used an absolute path.
 */
function findBash() {
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    '/bin/bash', '/usr/bin/bash']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const BASH = findBash();

/** Make a tiny git repo with one staged-then-modified file. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r454-'));
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\n');
  g(['add', 'a.txt']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\n');
  return dir;
}

/**
 * Spawn with an OPEN, EMPTY stdin pipe and wait with a cap — the configuration Shell.ts uses.
 * Deliberately does NOT use communicate(), which closes stdin and produces a false negative.
 */
function runWithOpenStdin(args, cwd, { timeoutMs = 4000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(args[0], args.slice(1), {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ blocked: true, ms: Date.now() - t0 });
    }, timeoutMs);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ blocked: false, code, ms: Date.now() - t0 });
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ blocked: null, ms: Date.now() - t0 });
    });
  });
}

test('control: an open empty stdin pipe blocks a stdin reader and not a non-reader', async (t) => {
  // Without this, a "blocked" result for git would only prove the harness blocks everything.
  if (!BASH) {
    t.skip('no bash binary found; the control cannot run');
    return;
  }
  const dir = makeRepo();
  const readResult = await runWithOpenStdin([BASH, '-c', 'read x; echo got:$x'], dir);
  assert.equal(readResult.blocked, true,
    'a pure stdin read did NOT block: stdin is not behaving as an open empty pipe, so no git '
    + 'conclusion below is valid. (blocked=null would mean the spawn itself failed.)');

  const echoResult = await runWithOpenStdin([BASH, '-c', 'echo hi'], dir);
  assert.equal(echoResult.blocked, false, 'a non-reading command blocked: the harness is wrong');
}, { timeout: 30000 });

test('git add -p blocks on an open empty stdin — measured', async () => {
  const dir = makeRepo();
  const r = await runWithOpenStdin(['git', 'add', '-p'], dir);
  assert.equal(r.blocked, true,
    'git add -p no longer blocks here: either git changed, or the spawn differs from Shell.ts\'s');
}, { timeout: 30000 });

test('GIT_EDITOR=true does NOT rescue git add -p — it reads stdin, not an editor', async () => {
  // The finding. R453 predicted this; here it is observed.
  const dir = makeRepo();
  const env = { ...process.env, GIT_EDITOR: 'true' };
  const r = await runWithOpenStdin(['git', 'add', '-p'], dir, { env });
  assert.equal(r.blocked, true,
    'GIT_EDITOR=true now prevents the block: if git changed so -p honours the editor, the risk is '
    + 'narrower than recorded and this note should be updated');
}, { timeout: 30000 });

test('GIT_EDITOR=true DOES rescue git rebase -i', async () => {
  // The other half: the same stub that fails for -p succeeds for rebase -i, because rebase opens the
  // todo in an editor rather than reading stdin.
  const dir = makeRepo();
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'change']);
  const env = { ...process.env, GIT_EDITOR: 'true' };
  const r = await runWithOpenStdin(['git', 'rebase', '-i', 'HEAD~1'], dir, { env });
  assert.equal(r.blocked, false,
    'git rebase -i now blocks even with GIT_EDITOR=true: the R453 claim that it is safe needs '
    + 're-deriving');
}, { timeout: 30000 });

test('the production timeout is 30 minutes, so a block lasts that long', () => {
  const shell = fs.readFileSync(path.join(SRC, 'src', 'utils', 'Shell.ts'), 'utf8');
  assert.match(shell, /const DEFAULT_TIMEOUT = 30 \* 60 \* 1000/,
    'the default timeout changed: recompute how long a blocked command stalls the session');
  // And nothing rejects the flag before spawn.
  const perms = fs.readFileSync(
    path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'BashTool', 'bashPermissions.ts'),
    'utf8');
  assert.ok(!perms.includes('--interactive'),
    'interactive flags are now rejected in the permission layer: the risk is closed, update R453/R454');
});
