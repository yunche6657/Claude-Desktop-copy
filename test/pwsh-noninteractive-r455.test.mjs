// R455: measured both ways — -NonInteractive does NOT protect git, and my first pwsh result was wrong.
//
// TWO FALSE NEGATIVES, ONE AFTER THE OTHER
//   1. Python harness, run 1: "git add -p under pwsh -NonInteractive exits 0.33s" -> seemed to prove
//      the flag works. Cause: the repo had no unstaged change, so git had nothing to prompt about.
//      An immediate exit is indistinguishable from a rescued hang unless you check WHY it exited.
//   2. Node test, then run 2 with an absolute git path: exits 0.3s and PRINTS the prompt
//      "(1/1) Stage this hunk [y,n,q,a,d,e,p,P,?]" — again an exit, again nothing staged.
//      Same cause: the process ended without consuming input.
//
// THE TEST THAT CANNOT LIE
//   Feeding an answer and checking whether it was CONSUMED. If git stages the hunk after being fed
//   "y\n", then git is definitely reading stdin — and the empty-stdin run that blocked is definitely
//   a real hang, not a quirk.
//
//     bare `git add -p`, empty stdin   -> BLOCKS 5.01s, staged=[]
//     bare `git add -p`, fed "y\n"     -> exits 0.09s, staged=[a.txt]
//     under pwsh -NonInteractive, empty-> BLOCKS 5.04s, staged=[]
//     under pwsh -NonInteractive, fed  -> exits 0.32s, staged=[a.txt]
//
// SO THE ASYMMETRY IS SMALLER THAN IT LOOKED
//   -NonInteractive stops PowerShell's OWN prompts (`Read-Host`), which R455's control pair confirmed:
//     `Read-Host` without the flag blocks, with the flag it exits in 0.44s.
//   It does NOT stop a CHILD PROCESS that reads stdin. git is a child process. It reads the pipe and
//   waits, exactly as it does under bash.
//
//   powershellProvider.ts:12 does pass the flag, so PowerShell prompt failures are handled. The git
//   hang is unaffected by it — the two problems only looked like one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const PWSH = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']
  .find((p) => fs.existsSync(p));

function freshRepo(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r455-' + tag + '-'));
  const g = (args) => spawnSync('git', args, { cwd: d, encoding: 'utf8' });
  g(['init', '-q']);
  fs.writeFileSync(path.join(d, 'a.txt'), 'line1\n');
  g(['add', 'a.txt']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  fs.writeFileSync(path.join(d, 'a.txt'), 'line1\nline2\n');
  return d;
}

function staged(d) {
  return spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: d, encoding: 'utf8' })
    .stdout.trim();
}

/**
 * run with stdin open and empty, OR feed bytes and close. The feed variant is what makes the result
 * trustworthy: it proves the child actually consumes stdin rather than exiting for another reason.
 */
function run(args, cwd, { feed = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(args[0], args.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    const finish = (blocked) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ blocked, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(true);
    }, timeoutMs);
    if (feed !== null) child.stdin.end(feed);
    child.on('exit', () => finish(false));
    child.on('error', () => finish(null));
  });
}

test('bare git add -p: blocks on empty stdin, stages when fed — it really reads stdin', async () => {
  const d1 = freshRepo('a');
  const blocked = await run(['git', 'add', '-p'], d1);
  assert.equal(blocked.blocked, true,
    'git add -p no longer blocks: either git changed, or the repo state makes it a no-op');
  assert.equal(staged(d1), '', 'something was staged without input');

  const d2 = freshRepo('b');
  const fed = await run(['git', 'add', '-p'], d2, { feed: 'y\n' });
  assert.equal(fed.blocked, false, 'git did not finish when fed an answer');
  assert.equal(staged(d2), 'a.txt',
    'git did not stage the hunk after being fed "y" — so it is not reading stdin, and the blocking '
    + 'result above would mean something else');
}, { timeout: 40000 });

test('pwsh -NonInteractive does NOT stop a child process from reading stdin', async (t) => {
  if (!PWSH) {
    t.skip('no pwsh found');
    return;
  }
  const gitExe = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).status === 0
    ? 'git' : null;
  // Use plain `git` and let pwsh resolve it, matching buildPowerShellArgs' shape.
  const args = [PWSH, '-NoProfile', '-NonInteractive', '-Command', 'git add -p'];

  const d1 = freshRepo('c');
  const blocked = await run(args, d1);
  assert.equal(blocked.blocked, true,
    'git add -p under pwsh -NonInteractive no longer blocks: if pwsh changed to close stdin for '
    + 'children, that WOULD be a real protection and this finding should be revised');

  const d2 = freshRepo('escaped');
  const fed = await run(args, d2, { feed: 'y\n' });
  assert.equal(staged(d2), 'a.txt',
    'pwsh did not pass the fed answer through to git — the harness is not exercising the real path');
}, { timeout: 60000 });

test('-NonInteractive DOES stop PowerShell’s own prompts — the control pair', async (t) => {
  if (!PWSH) {
    t.skip('no pwsh found');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r455p-'));

  const bare = await run([PWSH, '-Command', "Read-Host 'x'"], dir);
  assert.equal(bare.blocked, true,
    'Read-Host did not block without the flag: the comparison proves nothing');

  const guarded = await run(
    [PWSH, '-NoProfile', '-NonInteractive', '-Command', "Read-Host 'x'"], dir);
  assert.equal(guarded.blocked, false,
    'Read-Host still blocked WITH -NonInteractive: then the flag does nothing at all');
}, { timeout: 40000 });

test('the flag is present in the provider, so PowerShell prompts are still handled', () => {
  // Even though it does not help with git, the flag is doing its job for pwsh's own prompts. Removing
  // it would be a regression for that separate problem.
  const provider = read(SRC, 'src', 'utils', 'shell', 'powershellProvider.ts');
  assert.match(provider, /'-NoProfile', '-NonInteractive', '-Command'/,
    'the flag set changed: PowerShell prompts would now hang');
});
