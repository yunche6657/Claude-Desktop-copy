// R526: which of the 145 tools/*.cjs actually work? Answered by running them, and the first answer was wrong.
//
// THE QUESTION
//   package.json references 30 of 145 scripts. Nothing said whether the other 115 were usable helpers, one-off probes
//   kept for the record, or broken leftovers. Reading could not tell: 51 scripts have neither a `require.main` guard
//   nor argv handling, which is equally consistent with "a library" and "dead".
//
// THE FIRST ANSWER, AND WHY IT WAS WRONG
//   Classifying by exit code alone put 61 scripts in `broken`. Reading what they printed showed the bucket was a
//   mixture of five different things:
//       collect-changelog.cjs   `usage: node collect-changelog.cjs <workdir> <outfile> <version...>`
//       field-audit.cjs         `usage: node field-audit.cjs <Service> <method>`
//       ccb-probe.cjs           printed JSON then exited 1 — it ran and reported
//       probe-integrity.cjs     printed `INTEGRITY {...}` — a diagnostic whose exit code is the finding
//       cdp-approval-probe.cjs  `ECONNREFUSED 127.0.0.1:9340` — needs a live browser
//   Only a handful were uncaught exceptions, and even those split: `throw Error('absolute CONSENT_PROOF_OUT and
//   CONSENT_PROOF_ASAR required')` is a script asking for an environment variable, not a defect. Reporting 61 broken
//   tools would have been a claim nobody could act on, and would have invited deletion of working evidence generators.
//
// FIVE ITERATIONS, EACH PROMPTED BY READING THE OUTPUTS RATHER THAN THE COUNTS
//   exit-code only                      broken 61
//   + usage text detection              broken 44, needs-arguments 4, reports-findings 13, needs-service 1
//   + assertion arm (before the         broken 22, asserts 23   — a Node assertion stack matched the
//     uncaught-exception arm)                                     uncaught-exception pattern first
//   + env/argument requirements         broken 12, needs-arguments 14
//   + `throw Error('… required')`       broken 6,  needs-arguments 20
//
// THE SIX THAT REMAIN, EXAMINED
//   ccb-record-permission-frames.cjs  a REAL DEFECT: `r.stdout.find(...)` where stdout is a string, so the call
//                                     throws TypeError. Not a missing argument.
//   probe-integrity.cjs               a REAL DEFECT: reads `.quit` off undefined after printing its INTEGRITY marker.
//   extract-asar.cjs                  expects a file under `C:\Program Files\WindowsApps\…` that this machine lacks.
//   proof-r393-tool-table.cjs         ENOENT on its input bundle.
//   proof-r394-field-gap.cjs          ENOENT on its input bundle.
//   userdata.cjs                      reads a path that is undefined with no message.
//
//   Two defects, four missing inputs. That is a number someone can act on.
//
// WHAT THIS DOES NOT ESTABLISH
//   Not that the scored-as-runnable scripts are correct — only that they run and exit 0 on their default path. Not
//   that a script's `--help` text matches its options. Not that the six are worth fixing: two are one-off proofs whose
//   inputs may legitimately be gone. And the classification is by message pattern, so a script whose error text
//   happens to contain "required" is filed as needing an argument whether or not it does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'script-runnability.cjs');

// The first pass executes every script and takes ~8 minutes. These tests read the cache that pass produced; --json
// with the cache warm is fast. A missing cache means the assertion below fails loudly rather than silently passing.
const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 600000, windowsHide: true,
});

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the runner failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('every script is classified, and the tool file itself is included', () => {
  const d = report();
  const onDisk = fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => f.endsWith('.cjs'));
  assert.equal(d.total, onDisk.length,
    `classified ${d.total} scripts but ${onDisk.length} exist on disk`);
  assert.ok(d.byClass['runs-exits-0'] > 20, 'suspiciously few scripts run cleanly');
});

test('the broken bucket is small, and each member is a real defect or a missing input', () => {
  const d = report();
  const broken = d.byClass.broken || 0;
  // The number is allowed to change; an unexplained jump means the classifier regressed.
  assert.ok(broken <= 12,
    `${broken} scripts are classified broken. The first version reported 61 and most of those were merely asking for`
    + ' arguments or a service. Re-read the outputs before accepting this number');

  const rows = JSON.parse(run(['--class', 'broken', '--json']).stdout).results;
  for (const r of rows) {
    assert.match(r.evidence, /uncaught exception|missing module|a file it expects is absent|killed by/,
      `${r.file} is filed as broken for an unexplained reason: ${r.evidence}`);
  }
});

test('the classes that a naive classifier collapses are all present', () => {
  const d = report();
  // Each of these was carved out of `broken` by reading output, so each must still be exercised by real scripts.
  for (const [cls, why] of [
    ['needs-arguments', 'scripts that print usage or require env vars'],
    ['asserts', 'proof/probe scripts whose assertion is the verdict'],
    ['reports-findings', 'diagnostics whose exit code is the finding'],
    ['help-exits-0', 'scripts that document themselves'],
    ['launcher', 'scripts that would start Electron and leak children'],
  ]) {
    assert.ok((d.byClass[cls] || 0) > 0,
      `no script is classified ${cls} (${why}): that arm is untested against real code`);
  }
});

test('the reference count is reported, not assumed', () => {
  const d = report();
  const referenced = JSON.parse(run(['--json']).stdout).results.filter((r) => r.referenced).length;
  assert.ok(referenced > 10 && referenced < d.total,
    `package.json references ${referenced} of ${d.total}: expected a minority`);
});

test('the tool records its own first answer and the correction', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /THE FIRST VERSION PUT 61 SCRIPTS IN `broken`/,
    'the wrong first count is no longer recorded');
  assert.match(source, /This check MUST precede the uncaught-exception arm/,
    'the ordering constraint that cost a whole iteration is not documented');
  assert.match(source, /would invite someone to delete working evidence generators/,
    'the consequence of the wrong bucket is gone');
});

test('scripts that install or launch are skipped, not executed', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  const skipBlock = source.slice(source.indexOf('const SKIP'), source.indexOf('];', source.indexOf('const SKIP')));
  for (const name of ['package-installer.cjs', 'run-tests.cjs', 'setup-agent-core.cjs']) {
    assert.ok(skipBlock.includes(name), `${name} is no longer in the skip list`);
  }
  const d = report();
  assert.equal(d.byClass.skipped, 3, 'the skip list no longer covers exactly the three excluded scripts');
  // R526's first pass left TWENTY orphan electron.exe processes, discovered only because an unrelated test asserts
  // that none is running. Launchers are now refused before execution; asserting the class is populated keeps the
  // guard from being removed without anything noticing.
  assert.ok((d.byClass.launcher || 0) > 5,
    'the launcher guard no longer excludes anything: it may have been removed');
});
