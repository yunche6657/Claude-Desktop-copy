// R487: six scripts depended on a %TEMP% build that has been deleted. Two were genuinely dead; the
// coverage figure quoted by earlier rounds came from them.
//
// HOW THIS SURFACED
//   The round began by trying tools/official-coverage.cjs — the tool that reports how much of the upstream
//   surface this reconstruction covers. It died on the first line that mattered:
//       ENOENT: scandir '…\AppData\Local\Temp\cc-best-ref\node_modules\@claude-code-best\builtin-tools\src\tools'
//   tools/ has 212 scripts, no smoke test, and none wired into package.json, so nothing had noticed.
//
// THE DETECTOR FAILED FOUR TIMES BEFORE IT WAS RIGHT, EACH TIME BY DESCRIBING THE WRONG THING
//   1. Pattern `%TEMP%` matched ordinary shell usage (`echo x>%TEMP%\_w.txt` in probe-integrity.cjs and
//      probe-token.cjs) and the detector's own source. Three false positives, and the six scripts that
//      really broke were not reported at all — they build the path with
//      `path.join(process.env.TEMP, 'cc-best-ref', …)`, so there is no literal to match.
//   2. Pattern `cc-best-ref|claude-code-best` matched setup-agent-core.cjs, which names the GitHub REPO it
//      fetches from — a network dependency that is entirely correct — and again matched the detector.
//   3. Narrowed to `path.join(process.env.TEMP…'cc-best-ref')`, the detector still matched its own doc
//      comment, which quotes the shape as an example.
//   4. Even then the status was wrong: six scripts were labelled BROKEN from the pattern, but RUNNING them
//      showed only two fail. ccb-contract-diff, ccb-probe and ccb-permission-probe honour CCB_ROOT or only
//      touch the missing path in a deeper mode.
//   The lesson is the one this project keeps relearning: a static pattern is a hint about why, never a
//   verdict. The final tool takes its status from execution and uses the pattern only to explain.
//
// THE FIX
//   The two dead scripts read upstream builtin-tools SOURCE. That source is available in the repository's
//   reference checkout, so resolution now tries, in order:
//       CCB_TOOLS_SRC  ->  <repo>/../.tmp/ccb-src/node_modules/…  ->  %TEMP%/cc-best-ref/…
//   and, when none exists, prints the paths it tried instead of throwing ENOENT from inside a readdir.
//   Same treatment for ccb-probe's kernel: it already honoured CCB_BUN / CCB_ROOT / CCB_ENTRY, so pointing
//   those at agent-core makes its preflight pass — it then fails for the honest reason (no credentials),
//   which matches R481's finding that the CLI is simply not logged in.
//
// WHAT THIS RESTORES
//   ccb-tool-map now prints officialCount 44 / equivalent 33 / coverageStrict 75%, and
//   ccb-tool-inventory prints 60 tools. Those numbers exist again; before this round they were quoted from
//   a script that could not run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = path.join(ROOT, 'tools', 'tool-inventory.cjs');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const runNode = (script, env = {}, timeout = 60000) => spawnSync(process.execPath, [script], {
  cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, ...env },
});

test('no script in tools/ still depends on the deleted %TEMP% build', () => {
  const result = runNode(INVENTORY);
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.status, 0,
    'the inventory reports a tool that cannot run:\n' + out.slice(-1500));
  assert.ok(!/genuinely cannot run/.test(out),
    'a script still cannot run: ' + out.slice(-1200));
});

test('the tool inventory takes its verdict from execution, not from a pattern', () => {
  const source = read(INVENTORY);
  // The static finding must be a suspicion, and running the script must decide.
  assert.match(source, /function actuallyFails/, 'the execution probe is gone');
  assert.match(source, /status: suspicious \? 'suspect'/, 'the status is no longer pattern-derived-but-unconfirmed');
  assert.match(source, /verdict\.fails/, 'the verdict is no longer used');
  // And it must say so, because "looks broken but runs" was a real distinction here.
  assert.match(source, /LOOK broken but run/,
    'the report no longer distinguishes a suspicious pattern from actual failure');
});

test('the detector excludes itself rather than contorting its pattern', () => {
  // It matched its own doc comment; naming itself is the honest fix.
  const source = read(INVENTORY);
  assert.match(source, /SELF_EXEMPT = new Set\(\['tool-inventory\.cjs'\]\)/,
    'the self-exemption is gone: the detector will match its own example again');
  assert.match(source, /SELF_EXEMPT\.has\(path\.basename\(file\)\)/,
    'the exemption is declared but not applied');
});

test('ccb-tool-map resolves the upstream source and reports coverage again', () => {
  const result = runNode(path.join(ROOT, 'tools', 'ccb-tool-map.cjs'));
  const out = result.stdout || '';
  assert.equal(result.status, 0, 'ccb-tool-map failed:\n' + (result.stderr || out).slice(0, 900));
  assert.match(out, /"officialCount":\s*44/, 'officialCount changed: re-derive the coverage figure');
  assert.match(out, /"coverageStrict"/, 'the coverage figure is no longer reported');

  // Resolution order must be present in the source, with the environment variable first.
  const source = read(ROOT, 'tools', 'ccb-tool-map.cjs');
  assert.match(source, /CCB_TOOLS_SRC/, 'the explicit override is gone');
  assert.match(source, /function resolveToolsSource/, 'the resolver is gone');
  // And a missing source must report what it tried rather than throwing ENOENT.
  assert.match(source, /upstream builtin-tools source not found\. Tried:/,
    'a missing source no longer names the paths it tried');
});

test('ccb-tool-inventory resolves the upstream source too', () => {
  const result = runNode(path.join(ROOT, 'tools', 'ccb-tool-inventory.cjs'));
  assert.equal(result.status, 0, 'ccb-tool-inventory failed:\n' + (result.stderr || '').slice(0, 900));
  const out = result.stdout || '';
  assert.match(out, /"count":\s*\d+/, 'the tool count is missing');
  const source = read(ROOT, 'tools', 'ccb-tool-inventory.cjs');
  assert.match(source, /resolveToolsSource/, 'the resolver is gone');
  assert.match(source, /Set CCB_TOOLS_SRC/, 'the failure message no longer says how to fix it');
});

test('a missing source is reported, not thrown, when the override points nowhere', () => {
  // Point the override at a directory that cannot exist and confirm the message names it.
  const result = runNode(path.join(ROOT, 'tools', 'ccb-tool-inventory.cjs'),
    { CCB_TOOLS_SRC: 'Z:\\definitely-not-a-real-path\\tools' });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  // Either it found the in-repo checkout instead (fine, resolution order) or it explained the miss.
  if (result.status !== 0) {
    assert.match(out, /Tried:|Set CCB_TOOLS_SRC/,
      'a failed resolution did not explain itself: ' + out.slice(0, 400));
    assert.ok(!/at Object\.readdirSync/.test(out) || /Tried:/.test(out),
      'an unhandled readdir ENOENT escaped');
  }
});

test('ccb-probe now fails for missing credentials, not for a missing runtime', () => {
  // The distinction matters: R481 established the CLI is not logged in, and that is the honest blocker.
  const result = runNode(path.join(ROOT, 'tools', 'ccb-probe.cjs'), {
    CCB_BUN: path.join(ROOT, 'agent-core', 'bun', 'bun.exe'),
    CCB_ENTRY: path.join(ROOT, 'agent-core', 'claude-code', 'dist', 'cli-bun.js'),
    CCB_ROOT: path.join(ROOT, 'agent-core', 'claude-code'),
  });
  const out = result.stdout || '';
  assert.ok(!/bun not found/.test(out),
    'ccb-probe still reports a missing bun although CCB_BUN points at the in-repo runtime');
  assert.ok(!/kernel entry not found/.test(out),
    'ccb-probe still reports a missing kernel entry');
});
