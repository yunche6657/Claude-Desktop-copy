// R563: applying R562's criterion in bulk cut the "replica vs original" count from 9 to 4, and that is the finding.
//
// THE CRITERION R562 FOUND BY HAND
//   `['http','sse']` is not a duplicate: one side is the reconstruction, the other is the official code it is checked
//   against, sliced out of the bundle and run in a VM. Sharing a constant would make the check agree with itself.
//
// APPLYING IT TOOK TWO PASSES, AND THE FIRST PASS WAS WRONG TWICE
//   Pass 1 tested only "does the file's text mention an official path". It classified 9 groups as replica-vs-original
//   and several hits were in `test/read-progress-r562.test.mjs` — THE TEST WRITTEN THE PREVIOUS ROUND, which asserts that
//   the bundle path appears in another file. A test that asserts ABOUT a string is not a consumer of the material.
//   Fix: an explicit OBSERVERS set.
//
//   Pass 2 still found 9, because naming a path is not copying it. Checking what each site DOES:
//
//       tools/proof-sdk-mcp.cjs          mentions agent-core/claude-code/dist because it SPAWNS that CLI
//       proof-hidden-history-import-confirm  names a path in a comment
//       growthbook-mode-native-r375      reads the bundle but never executes it
//
//   The R562 shape is stronger — read official code, SLICE it, and EXECUTE the slice:
//
//       const src = fs.readFileSync('../ccd-ref/asar/.vite/build/index.chunk-….js', 'utf8');
//       const bj  = src.slice(src.indexOf('async function bj('), …);
//       return vm.runInNewContext(`(()=>{${bj};…})()`);
//
//   Both conditions are required: reading without executing runs the original as a black box, and executing without
//   reading official material is a self-made fixture with nothing to compare against. With both: 4 groups.
//
// THE FOUR, EACH VERIFIED
//       ['http','sse']                        XA inside a VM slice
//       ['connected','failed','needs-auth']   YA inside the same slice
//       ['chat','code','cowork']              fC:['cowork','code','chat'] as a sandbox binding
//       ['api-staging…','api.anthropic.com','api.claude.ai']  Yze:new Set([...]) in the VM context
//
// PROGRESS
//       before R563   read 13 / 28
//       after         read 15 / 28
//
// WHAT THIS MEANS FOR THE DENOMINATOR
//   4 of 28 groups are replica-vs-original — real, but not the dominant category R562 suspected it might be. The
//   largest bucket is `mixed(tool+test)` at 11, which is proof scripts and their tests carrying the same fixture setup
//   in two roles. So the flat count was not mostly comparison artefacts; most of it is genuinely repeated setup.
//
// WHAT IS NOT CLAIMED
//   Not that the 4 are exhaustively found: the rule needs a literal `readFileSync(<bundle path>)` plus a literal
//   `vm.runInNewContext` / `new Function` / `eval` in the SAME file, so a slice assembled through a helper would be
//   missed. Not that `mixed(tool+test)` at 11 needs no reading — those 11 are still unread in bulk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { READ, sig } from '../tools/read-ledger.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'group-provenance.cjs');

const runTool = (args = []) => spawnSync(process.execPath, [TOOL, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

let cached = null;
function report() {
  if (cached) return cached;
  const r = runTool(['--json']);
  assert.equal(r.status, 0, 'the provenance tool failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('the replica-vs-original set covers the four verified groups and the keep-awake list', () => {
  // R578 widened the reading rule: a bundle path built once and joined later now counts, which brought the 12-fact
  // keep-awake list into this class. It is BOTH a legitimate shared constant (R577) and a replica-versus-original case —
  // the test reads three chunks of the official bundle and runs slices of them.
  const d = report();
  const replica = d.rows.filter((r) => r.kind === 'replica-vs-original').map((r) => [...r.members].sort());
  const expected = [
    [...['api-staging.anthropic.com', 'api.anthropic.com', 'api.claude.ai']].sort(),
    [...['chat', 'code', 'cowork']].sort(),
    [...['connected', 'failed', 'needs-auth']].sort(),
    [...['http', 'sse']].sort(),
    [...['hasHeldInput', 'hasQuery', 'heldInputSurvives', 'lanyardConnected', 'liveCron', 'liveLoop',
      'losableBackground', 'remoteClient', 'turnRunning', 'unattended', 'violinBow', 'waitingOnUser']].sort(),
  ];
  // Compared as SIGNATURES, not as arrays: `[[...]].sort()` stringifies each element, so the order of two nested arrays
  // comes down to their commas and not to their contents — the first version of this assertion failed on a set that was
  // in fact correct.
  const key = (rows) => rows.map((r) => r.join('|')).sort();
  assert.deepEqual(key(replica), key(expected),
    `the replica set changed: ${JSON.stringify(replica)}`);
});

test('a file that only MENTIONS an official path is not an original reader', () => {
  const d = report();
  for (const g of d.rows) {
    for (const site of g.originalReaders) {
      const [file] = site.split(':');
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.match(text, /vm\.runInNewContext|new Function\(|\beval\(/,
        `${file} is classified as an original reader but never executes anything`);
      assert.match(text, /readFileSync\([^)]*(ccd-ref|\.asar|\.vite[\\/]build|ion-dist|pinned-ion)/,
        `${file} is classified as an original reader but does not read the bundle`);
    }
  }
});

test('the proof script that SPAWNS the official CLI is not counted', () => {
  // `proof-sdk-mcp.cjs` names agent-core/claude-code/dist because it runs that CLI, not because it copies it.
  const d = report();
  for (const g of d.rows) {
    assert.ok(!g.originalReaders.some((s) => s.startsWith('tools/proof-sdk-mcp.cjs')),
      'a proof script that runs the official CLI is classified as copying it');
  }
});

test('the observers are excluded by name, not by luck', () => {
  // The test written in R562 asserts the bundle path appears elsewhere; that must not make it a reader.
  const d = report();
  for (const g of d.rows) {
    for (const site of g.originalReaders) {
      assert.ok(!site.startsWith('test/read-progress-r562.test.mjs'),
        'the R562 test is classified as a consumer of the material it asserts about');
      assert.ok(!site.startsWith('tools/group-provenance.cjs'), 'the tool classifies itself');
    }
  }
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /const OBSERVERS = new Set\(\[/, 'the observer exclusion is gone');
});

test('every group is classified, none left out', () => {
  const d = report();
  assert.equal(d.rows.length, d.groups, 'some groups have no classification');
  const kinds = Object.keys(d.byKind);
  assert.ok(kinds.length >= 4, `only ${kinds.length} kinds: the classifier collapsed`);
  for (const r of d.rows) assert.ok(typeof r.kind === 'string' && r.kind.length > 0, 'a row has no kind');
});

test('the four verified groups are in the ledger', () => {
  for (const members of [['http', 'sse'], ['connected', 'failed', 'needs-auth'],
    ['chat', 'code', 'cowork'], ['api-staging.anthropic.com', 'api.anthropic.com', 'api.claude.ai']]) {
    const entry = READ.find((e) => sig(e.members) === sig(members));
    assert.ok(entry, `[${members.join(',')}] has no ledger entry`);
    assert.match(entry.verdict, /REPLICA vs ORIGINAL/, `[${members.join(',')}] is not marked as a replica pair`);
  }
});

test('the ledger reports the fraction after bulk classification', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'read-ledger.cjs'), '--json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0);
  const d = JSON.parse(r.stdout);
  assert.ok(d.read >= 15, `the ledger reports ${d.read} read, fewer than the 15 recorded here`);
  assert.equal(d.read + d.unread, d.liveGroups, 'the split does not sum');
});
