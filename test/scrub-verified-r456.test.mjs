// R456: GHA_SUBPROCESS_SCRUB measured — it works when on, and it is off by default.
//
// MEASURED, NOT READ
//   The probe reproduced subprocessEnv()'s exact logic, set all 23 scrub vars to sentinels, and called
//   it twice:
//
//     flag OFF (default):  23/23 leaked, and the return value IS process.env (same object)
//     flag ON           :   0/23 leaked, and the return value is a fresh object
//
//   So `delete env[k]` is correct. The list has 23 entries (R452 said 25 — corrected here).
//
// THE FLAG IS NEVER SET IN THIS TREE
//   Two mentions of CLAUDE_CODE_SUBPROCESS_ENV_SCRUB exist, both reads. The comment says
//   "claude-code-action sets this automatically when allowed_non_write_users is configured" — an
//   external GitHub Action, not this code. So in a normal local session the scrub is OFF and every
//   child inherits ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, etc.
//
//   That is by design (the threat model is prompt injection in CI, not local use), but the consequence
//   is worth stating plainly: the 23 names are a CI hardening measure, not a general secret boundary.
//
// ALIASING WHEN OFF
//   `return Object.keys(proxyEnv).length > 0 ? {...process.env, ...proxyEnv} : process.env`
//   With no proxy env — the normal case — the caller gets process.env ITSELF. A caller that mutates
//   the returned object mutates the parent environment. No current caller is known to do so, but the
//   function does not promise a copy.
//
// ONE REAL BYPASS
//   src/utils/computerUse/win32/bridgeClient.ts spawns a Python bridge with
//       env: { ...process.env, PYTHONIOENCODING: 'utf-8', ... }
//   bypassing subprocessEnv entirely. Lazy-loaded from platforms/win32.ts via require() in a try/catch,
//   so it is reached only on Windows computer-use paths. It inherits all 23 vars regardless of the flag.
//
// THE MCP PATH IS CORRECT
//   client.ts:959 builds `env: { ...subprocessEnv(), ...stdioRef.env }`, and the SDK's default
//   (getDefaultEnvironment) is a sudo-style allowlist, not full inheritance. So MCP stdio is covered.
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

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

function scrubList() {
  const t = read(SUBENV);
  const m = /const GHA_SUBPROCESS_SCRUB = \[([\s\S]*?)\] as const/.exec(t);
  assert.ok(m, 'the scrub list is gone');
  return [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]);
}

test('the scrub list has 23 entries and includes the Anthropic credentials', () => {
  const list = scrubList();
  assert.equal(list.length, 23,
    'the scrub list size changed: R452 recorded 25 by miscount, R456 measured 23');
  for (const must of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.ok(list.includes(must), must + ' is no longer scrubbed');
  }
});

test('scrubbing works when enabled and does nothing when disabled — measured', (t) => {
  if (!fs.existsSync(BUN)) {
    t.skip('bun not available');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r456-'));
  // isEnvTruthy copied verbatim from src/utils/envUtils.ts:32-37 (importing it would pull lodash).
  const probe = `
function isEnvTruthy(envVar) {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const v = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(v)
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
  process.env[k] = 'S_' + k
  process.env['INPUT_' + k] = 'SI_' + k
}
process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = process.argv[2] ?? ''
const out = subprocessEnv()
const leaked = LIST.filter((k) => out[k] === 'S_' + k)
console.log(JSON.stringify({
  leaked: leaked.length,
  sameObject: out === process.env,
}))
`;
  const probePath = path.join(dir, 'probe.ts');
  fs.writeFileSync(probePath, probe);

  const run = (flag) => {
    const r = spawnSync(BUN, [probePath, flag], { cwd: dir, encoding: 'utf8' });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('{'));
    assert.ok(line, 'probe produced no output: ' + (r.stderr || '').slice(0, 200));
    return JSON.parse(line);
  };

  const off = run('');
  assert.equal(off.leaked, 23, 'with the flag off, all 23 should still be present');
  assert.equal(off.sameObject, true,
    'with the flag off and no proxy env, subprocessEnv should return process.env itself');

  const on = run('1');
  assert.equal(on.leaked, 0, 'with the flag on, nothing should leak');
  assert.equal(on.sameObject, false, 'with the flag on, a fresh object should be returned');
}, { timeout: 60000 });

test('nothing in this tree SETS the flag — it is off by default', () => {
  const hits = [];
  const walk = (root) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const p = path.join(root, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      const body = fs.readFileSync(p, 'utf8');
      if (!body.includes('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB')) continue;
      for (const line of body.split('\n')) {
        if (!line.includes('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB')) continue;
        const writes = /process\.env\.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB\s*=[^=]/.test(line);
        hits.push({ file: path.relative(SRC, p), writes });
      }
    }
  };
  walk(path.join(SRC, 'src'));
  walk(path.join(SRC, 'packages'));

  assert.ok(hits.length > 0, 'the flag is not mentioned at all any more');
  assert.equal(hits.filter((h) => h.writes).length, 0,
    'something now SETS the flag: the default may no longer be off, so R456\'s conclusion changes');
});

test('MCP stdio passes a scrubbed env — this path is correct', () => {
  // Worth asserting because subprocessEnv's doc comment claims MCP coverage; here it is verified.
  const client = read(SRC, 'src', 'services', 'mcp', 'client.ts');
  assert.match(client, /\.\.\.subprocessEnv\(\)/,
    'MCP no longer merges subprocessEnv into the transport env: servers would inherit everything');
  const construction = /new StdioClientTransport\(\{[\s\S]{0,400}?env:\s*\{[\s\S]{0,120}?\.\.\.subprocessEnv\(\)/.exec(client);
  assert.ok(construction,
    'the transport is no longer constructed with the scrubbed env');
});

test('one spawn site bypasses subprocessEnv — recorded, not fixed', () => {
  // Not a defect to repair here: it is upstream's Windows computer-use bridge, and changing it would
  // alter behaviour this reconstruction does not own. Recording it keeps the coverage claim honest.
  const bp = path.join(SRC, 'src', 'utils', 'computerUse', 'win32', 'bridgeClient.ts');
  assert.ok(fs.existsSync(bp), 'the bridge client is gone: re-derive the bypass list');
  const body = read(bp);
  assert.match(body, /env:\s*\{\s*\.\.\.process\.env/,
    'the bridge no longer spreads process.env: this bypass may now go through subprocessEnv');
  assert.ok(!body.includes('subprocessEnv'),
    'the bridge now imports subprocessEnv: the bypass is closed, update this note');
});
