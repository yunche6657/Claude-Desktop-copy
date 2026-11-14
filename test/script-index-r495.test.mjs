// R495: tools/ now has an index — 219 scripts, 14 invokable, 157 that nothing mentions.
//
// WHY THIS ROUND IS THE CLOSE-OUT
//   R487 found 212 scripts, no smoke test, none wired, and five that could not run at all. R487–R494 added
//   nine more and wired seven. R485 built a topic index over the PROSE (evidence and handoffs) but nothing
//   indexes the TOOLS, so a reader who wants to check a claim cannot find the script that produced it. The
//   session has written 140+ evidence files describing findings whose reproduction lives in those scripts.
//
//   This is not busywork: the first run showed 146 of 219 scripts are mentioned by nothing at all, and the
//   nine largest clusters (`proof` 49, `find` 31, `read` 12, `ccb` 10, `probe` 9, `update` 7, `resolve` 5,
//   `bridge` 4, `official` 4) contain zero invokable entries. Those are single-round probes that produced a
//   conclusion and were never reachable again by intent.
//
// HOW SCRIPTS ARE CLASSIFIED — by evidence, not by name
//   wired       the file appears in a package.json script; the only ones a user can invoke by intent
//   referenced  a test or an evidence file mentions the file name
//   standalone  nothing mentions it
//
//   Grouping strips a trailing `-r<N>` round suffix and takes the text before the first `-`. That is the
//   naming convention this repo actually follows, and the generated report shows the grouping so a misfile
//   is visible.
//
// THE SELF-REFERENCE THAT BROKE THE FIRST TWO RUNS
//   Run 1: 60 referenced / 146 standalone. Run 2, after the tool had written evidence/SCRIPT-INDEX.md:
//   205 referenced / 0 standalone. The index names all 219 scripts, so its own output was being scanned as
//   "someone mentions this script". Every script became referenced because the report said so.
//
//   This is the third instance of the same failure in this session — R486's recall harness counted its own
//   write-up as ground truth, and R493's detector matched its own doc comment. The fix is the same shape:
//   name the artifacts the tool writes and exclude them from the corpus. After that, two consecutive runs
//   agree at 48 / 157, which is the property to assert.
//
// WHAT THIS DOES NOT SAY
//   `standalone` is not a judgement that a script is useless. A probe that produced one round's evidence and
//   was never wired may be exactly right — the point is that a reader cannot find it, not that it was wrong
//   to write it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'script-index.cjs');
const OUT = path.join(ROOT, 'evidence', 'SCRIPT-INDEX.md');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

test('the index is generated and every script is accounted for', () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, 'the tool failed:\n' + (result.stderr || '').slice(0, 800));
  const d = JSON.parse(result.stdout);

  const onDisk = fs.readdirSync(path.join(ROOT, 'tools')).filter((n) => /\.(cjs|mjs)$/.test(n));
  assert.equal(d.total, onDisk.length, 'the indexed count does not match the directory');
  assert.equal(d.rows.length, onDisk.length);
  // Every row carries a status from the declared set.
  for (const r of d.rows) {
    assert.ok(['wired', 'referenced', 'standalone'].includes(r.status),
      `${r.name} has an unexpected status ${r.status}`);
  }
});

test('the classification is stable across two consecutive runs', () => {
  // The self-reference bug: run 1 created the output file, run 2 then counted it as a mention of every
  // script. Two runs must agree, or the numbers measure the tool's own writes.
  const first = JSON.parse(run(['--json']).stdout);
  const second = JSON.parse(run(['--json']).stdout);
  assert.equal(first.counts.referenced, second.counts.referenced,
    'the referenced count changed between runs: the output file is being scanned as evidence');
  assert.equal(first.counts.standalone, second.counts.standalone,
    'the standalone count changed between runs');
  // And standalone must not be zero — that was the exact symptom of the self-reference.
  assert.ok(first.counts.standalone > 0,
    'no script is standalone: the index is almost certainly reading its own output');
});

test('the tool excludes its own written artifacts from the corpus', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /SELF_OUTPUTS/, 'the self-output exclusion is gone');
  assert.match(source, /SCRIPT-INDEX\.md/, 'the tool no longer names its own output');
  assert.match(source, /if \(SELF_OUTPUTS\.has\(f\)\) continue/,
    'the exclusion is declared but not applied in the loop');
});

test('wired scripts match package.json exactly', () => {
  const d = JSON.parse(run(['--json']).stdout);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const expected = new Set();
  for (const command of Object.values(pkg.scripts || {})) {
    for (const m of String(command).matchAll(/tools[/\\]([\w.-]+\.(?:cjs|mjs))/g)) expected.add(m[1]);
  }
  const actual = new Set(d.rows.filter((r) => r.status === 'wired').map((r) => r.name));
  assert.deepEqual([...actual].sort(), [...expected].sort(),
    'the wired set diverges from package.json');
  // A script referenced by two npm entries must appear once, with both names.
  const pkgInstaller = d.rows.find((r) => r.name === 'package-installer.cjs');
  assert.ok(pkgInstaller, 'package-installer.cjs is missing');
  assert.ok(pkgInstaller.npmScripts.includes('package')
    && pkgInstaller.npmScripts.includes('package:check'),
    'the dual npm wiring of package-installer is not recorded: ' + JSON.stringify(pkgInstaller.npmScripts));
});

test('the scripts added in this session are all indexed and wired', () => {
  const d = JSON.parse(run(['--json']).stdout);
  const byName = new Map(d.rows.map((r) => [r.name, r]));
  for (const name of [
    'audit-evidence.cjs', 'topic-index.cjs', 'index-recall.cjs', 'tool-inventory.cjs',
    'contract-provenance.cjs', 'contract-compare.cjs', 'contract-fields.cjs',
    'contract-vs-impl.cjs', 'artifact-divergence.cjs', 'tool-relation.cjs',
    'package-installer.cjs', 'script-index.cjs',
  ]) {
    const row = byName.get(name);
    assert.ok(row, `${name} is not indexed`);
    assert.equal(row.status, 'wired', `${name} is not invokable through package.json`);
  }
});

test('the report is written and declares its own method', () => {
  assert.ok(fs.existsSync(OUT), 'evidence/SCRIPT-INDEX.md is missing');
  const text = fs.readFileSync(OUT, 'utf8');
  assert.match(text, /由 `tools\/script-index\.cjs` 生成/, 'the report does not say it is generated');
  assert.match(text, /wired/, 'the report no longer explains the wired status');
  assert.match(text, /standalone/, 'the report no longer explains the standalone status');
  assert.match(text, /分类靠证据，不靠名字/, 'the report no longer states the classification basis');
});

test('groups with no invokable member are reported, not hidden', () => {
  // The nine largest clusters contain zero wired scripts. That is the actionable finding.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /none wired/, 'the unwired-cluster report is gone');
  assert.match(source, /m\.length >= 4/, 'the size threshold for the cluster report changed');
});
