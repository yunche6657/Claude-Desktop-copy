// R425: a REAL ripgrep timeout, not a static claim.
//
// R424 connected ripGrep's timeout signal to GrepTool. Its six assertions were all static: the
// callback exists, the flag is set, it is threaded into three branches, the field is optional.
// None proved the callback ever fires — and a field that never becomes true is exactly the
// failure mode R424 set out to avoid.
//
// WHAT ACTUALLY HAPPENED WHEN FORCED
//   A synthetic tree of 40,000 files, a search matching every one, 1s timeout:
//
//     baseline (20s default) : resolved, 40001 lines, onTimeout never called
//     forced   (1s timeout)  : resolved, 27847 lines, onTimeout called at 1044ms
//
//   12,154 files were dropped and, before R424, that call returned 27,847 lines with nothing
//   marking them incomplete.
//
// WHY THIS TEST IS OPT-IN
//   Building 40k files takes ~15s and the scan itself ~2s. Running that on every suite invocation
//   is disproportionate. The test is skipped unless RG_TIMEOUT_PROOF=1, which keeps the suite fast
//   while leaving the proof reproducible:
//
//       $env:RG_TIMEOUT_PROOF='1'; npm test -- test/grep-timedout-live-r425.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUN = path.join(ROOT, 'agent-core', 'bun', 'bun.exe');
const DIST = path.join(ROOT, 'agent-core', 'claude-code', 'dist');
const RG = path.join(DIST, 'vendor', 'ripgrep', 'x64-win32', 'rg.exe');

const OPT_IN = process.env.RG_TIMEOUT_PROOF === '1';

/** The chunk that re-exports ripGrep. Content hashes are unstable, so it is discovered. */
function ripGrepChunk() {
  for (const name of fs.readdirSync(DIST)) {
    if (!name.endsWith('.js')) continue;
    const p = path.join(DIST, name);
    if (fs.statSync(p).size > 20_000_000) continue;
    const t = fs.readFileSync(p, 'utf8');
    if (/export\s*\{[^}]*\bripGrep\b/.test(t)) return name;
  }
  return null;
}

test('the pieces a live timeout proof needs are present', () => {
  // Cheap and always on: if the binary or the export disappears, the opt-in proof below would
  // silently skip instead of failing, and nobody would notice.
  assert.ok(fs.existsSync(BUN), 'bundled bun is missing: ' + BUN);
  assert.ok(fs.existsSync(RG), 'vendored rg.exe is missing from dist: ' + RG);
  assert.ok(ripGrepChunk(), 'no chunk re-exports ripGrep: the dist layout changed');
});

test('a real 1s timeout fires onTimeout with partial results', { skip: !OPT_IN && 'set RG_TIMEOUT_PROOF=1' }, () => {
  // ---------------------------------------------------------------- build the tree
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-timeout-'));
  try {
    for (let i = 0; i < 40000; i += 1) {
      const d = path.join(work, 'd' + String(i % 200).padStart(3, '0'));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'f' + String(i).padStart(5, '0') + '.txt'),
        'NEEDLE_TOKEN payload line for timeout test\n');
    }

    const chunk = ripGrepChunk();
    assert.ok(chunk, 'ripGrep export vanished');
    const probe = path.join(DIST, 'probe-r425.mjs');
    fs.writeFileSync(probe, [
      "import { ripGrep } from './" + chunk + "'",
      'const target = process.argv[2]',
      'let fired = null',
      'const t0 = Date.now()',
      'try {',
      "  const lines = await ripGrep(['NEEDLE_TOKEN', '--files-with-matches'], target,",
      '    new AbortController().signal,',
      "    (partial) => { fired = { ...partial, atMs: Date.now() - t0 } })",
      "  console.log(JSON.stringify({ outcome: 'resolved', lineCount: lines.length, fired }))",
      '} catch (err) {',
      "  console.log(JSON.stringify({ outcome: 'rejected', name: err?.name,",
      "    message: String(err?.message).slice(0, 140), fired }))",
      '}',
    ].join('\n'));

    const run = (env) => {
      const e = { ...process.env };
      delete e.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS;
      Object.assign(e, env);
      const r = spawnSync(BUN, [probe, work], {
        cwd: DIST, encoding: 'utf8', timeout: 300000, env: e,
      });
      const out = (r.stdout || '').trim();
      assert.ok(out, 'probe produced no output: ' + (r.stderr || '').slice(-300));
      return JSON.parse(out);
    };

    const baseline = run({});
    const forced = run({ CLAUDE_CODE_GLOB_TIMEOUT_SECONDS: '1' });

    fs.rmSync(probe, { force: true });

    // ---------------------------------------------------------------- the claims
    // Guard first: the v2 attempt of this proof had ripgrep never launch at all (ENOENT on
    // rg.exe), which looks exactly like a "rejected" timeout if you do not check.
    assert.ok(!String(forced.message || '').includes('ENOENT'),
      'ripgrep never launched; this says nothing about the timeout logic');

    assert.equal(baseline.outcome, 'resolved', 'the baseline scan should complete');
    assert.equal(baseline.fired, null,
      'onTimeout fired on a search that finished in time: the flag would be noise');
    assert.ok(baseline.lineCount > 30000,
      'the baseline matched too few files to be a meaningful timeout test: ' + baseline.lineCount);

    assert.equal(forced.outcome, 'resolved',
      'a partial timeout should resolve, not reject — the reject path is for zero results');
    assert.notEqual(forced.fired, null,
      'onTimeout did NOT fire on a real timeout: R424 never actually worked');

    // The numbers that make the point: the forced run saw strictly fewer files.
    assert.ok(forced.lineCount < baseline.lineCount,
      'the forced run was not truncated (' + forced.lineCount + ' vs ' + baseline.lineCount
      + '): the timeout did not bite, so nothing was proven');
    assert.equal(forced.fired.lineCount, forced.lineCount,
      'the reported partial count disagrees with the returned lines');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
