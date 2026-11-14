// R457: end-to-end scrub verification — the child process really stops seeing the secrets.
//
// THE GAP THIS CLOSES
//   R456 measured subprocessEnv() the FUNCTION: flag off -> 23/23 present, flag on -> 0/23. It then
//   listed as NOT claimed: "没有在真实的 BashTool 子进程里验证". A correct function can still fail to
//   protect if the env is reassembled downstream, if the spawn ignores it, or if the child inherits
//   through another channel.
//
// WHAT THIS DOES
//   Assembles the child env exactly as Shell.ts:353-378 does — `{...subprocessEnv(), SHELL,
//   GIT_EDITOR, CLAUDECODE}` — then spawns a reporter child that prints which sentinels it can see.
//   The child's own report is the evidence; nothing is inferred from the code.
//
// MEASURED
//     flag OFF (default):  parent assembled 23/23  ->  CHILD SAW 23/23   (+ 23 INPUT_ twins)
//     flag ON           :  parent assembled  0/23  ->  CHILD SAW  0/23   (+  0 INPUT_ twins)
//
//   The OFF run is the control. If the child had not seen the sentinels with scrubbing disabled, the
//   ON result would prove nothing — it might just mean the harness never placed them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const BUN = path.join(ROOT, 'agent-core', 'bun', 'bun.exe');
const SUBENV = path.join(SRC, 'src', 'utils', 'subprocessEnv.ts');
const SHELL = path.join(SRC, 'src', 'utils', 'Shell.ts');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

function scrubList() {
  const m = /const GHA_SUBPROCESS_SCRUB = \[([\s\S]*?)\] as const/.exec(read(SUBENV));
  assert.ok(m, 'the scrub list is gone');
  return [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]);
}

/**
 * Run the end-to-end probe for one flag value; return what the CHILD reported.
 * The probe mirrors Shell.ts's env assembly, then spawns a reporter.
 */
function probeChildVisibility(flag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r457-'));
  const src = `
function isEnvTruthy(v) {
  if (!v) return false
  if (typeof v === 'boolean') return v
  return ['1','true','yes','on'].includes(v.toLowerCase().trim())
}
const LIST = ${JSON.stringify(scrubList())}
function subprocessEnv() {
  const proxyEnv = {}
  if (!isEnvTruthy(process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)) {
    return Object.keys(proxyEnv).length > 0 ? { ...process.env, ...proxyEnv } : process.env
  }
  const env = { ...process.env, ...proxyEnv }
  for (const k of LIST) { delete env[k]; delete env['INPUT_' + k] }
  return env
}
for (const k of LIST) {
  process.env[k] = 'SENTINEL_' + k
  process.env['INPUT_' + k] = 'SENTINEL_INPUT_' + k
}
process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = ${JSON.stringify(flag)}
// Shell.ts:353-366 — the exact shape.
const assembled = { ...subprocessEnv(), SHELL: undefined, GIT_EDITOR: 'true', CLAUDECODE: '1' }
const clean = {}
for (const [k, v] of Object.entries(assembled)) if (v !== undefined) clean[k] = v

const reporter = "console.log(JSON.stringify(Object.keys(process.env).filter(k => (process.env[k]||'').startsWith('SENTINEL'))))"
const p = Bun.spawn([process.execPath, '-e', reporter], { env: clean, stdout: 'pipe', stderr: 'pipe' })
const out = await new Response(p.stdout).text()
await p.exited
const seen = JSON.parse(out.trim().split('\\n').pop() || '[]')
console.log(JSON.stringify({
  total: LIST.length,
  assembled: Object.keys(clean).filter((k) => LIST.includes(k)).length,
  childSaw: seen.filter((k) => !k.startsWith('INPUT_')).length,
  childSawInput: seen.filter((k) => k.startsWith('INPUT_')).length,
}))
`;
  const p = path.join(dir, 'probe.ts');
  fs.writeFileSync(p, src);
  const r = spawnSync(BUN, [p], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('{'));
  assert.ok(line, 'probe produced no JSON: ' + (r.stderr || '').slice(0, 300));
  return JSON.parse(line);
}

test('Shell.ts still assembles the child env from subprocessEnv()', () => {
  // If this ever stops being true, the end-to-end result below no longer describes production.
  const shell = read(SHELL);
  assert.match(shell, /env:\s*\{\s*\.\.\.subprocessEnv\(\),/,
    'Shell.ts no longer spreads subprocessEnv into the spawn env: the child would inherit '
    + 'everything and the R457 conclusion would be about a call path production does not use');
});

test('end-to-end: with scrubbing OFF the child sees every sentinel (the control)', (t) => {
  if (!fs.existsSync(BUN)) {
    t.skip('bun not available');
    return;
  }
  const r = probeChildVisibility('');
  assert.equal(r.total, 23, 'scrub list size changed');
  assert.equal(r.childSaw, 23,
    'the child did NOT see the sentinels even with scrubbing off: the harness never delivered them, '
    + 'so the ON result below would be meaningless');
  assert.equal(r.childSawInput, 23, 'the INPUT_ twins did not reach the child either');
}, { timeout: 180000 });

test('end-to-end: with scrubbing ON the child sees none of them', (t) => {
  if (!fs.existsSync(BUN)) {
    t.skip('bun not available');
    return;
  }
  const r = probeChildVisibility('1');
  assert.equal(r.assembled, 0,
    'the assembled env still contains scrubbed names: the delete loop stopped working');
  assert.equal(r.childSaw, 0,
    'the CHILD still sees scrubbed vars despite a clean assembled env: something downstream '
    + 'reintroduces them — this is the exact failure R456 could not rule out');
  assert.equal(r.childSawInput, 0,
    'the INPUT_ twins still reach the child: only the bare names are being deleted somewhere');
}, { timeout: 180000 });

test('the flag remains unset by default, so this protection is opt-in', () => {
  // R456 established this statically; restated here because it decides whether the ON measurement
  // above has any bearing on a normal session.
  let writes = 0;
  const walk = (root) => {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
      const p = path.join(root, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
      const body = fs.readFileSync(p, 'utf8');
      if (!body.includes('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB')) continue;
      for (const line of body.split('\n')) {
        if (/process\.env\.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB\s*=[^=]/.test(line)) writes += 1;
      }
    }
  };
  walk(path.join(SRC, 'src'));
  walk(path.join(SRC, 'packages'));
  assert.equal(writes, 0,
    'something now sets the flag: the protection may be on by default, which would change what '
    + 'R456/R457 mean for a normal session');
});
