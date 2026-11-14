// R562: three more groups off the ledger queue, and the most useful outcome was being WRONG about one of them.
//
// R561 PREDICTED, AND THE PREDICTION WAS WRONG
//   R561 closed by guessing that `['appdata','home','localappdata','work']` would turn out to be
//   `path.join(base, key.toLowerCase())` applied to the uppercase environment list — "one intent, two spellings".
//
//   There is no `toLowerCase()` at any of the seven sites. They are DIRECTORY names under a fixture root:
//
//       for (const dir of ['work','home','appdata','localappdata']) fs.mkdirSync(path.join(root, dir), {recursive:true})
//
//   `work` has no uppercase counterpart; TEMP/TMP/TMPDIR/USERPROFILE have no lowercase one. The two groups share three
//   words because directory names and environment names coincide, not because one was derived from the other.
//
//   The guess is recorded in the ledger as a guess that failed, because a ledger that only records conclusions lets the
//   next round re-derive the same wrong prediction.
//
// THREE KINDS AGAIN, AND TWO OF THEM NEW
//   `['appdata','home','localappdata','work']` — DIRECTORY NAMES. Six sites use `work,home,appdata,localappdata`, one
//   (`proof-ccb-unread-r383.cjs:20`) uses `home,work,...`. That order difference cannot matter: every path is a direct
//   child of one base and every call passes `{recursive:true}`, so no directory depends on another existing first.
//
//   `['http','sse']` and `['connected','failed','needs-auth']` — REPLICA vs ORIGINAL. These are the first groups in the
//   ledger whose two copies exist IN ORDER TO BE COMPARED:
//
//       desktop/mcp-session-auth.cjs:9-10     const statuses = new Set([…]); const transports = new Set([…]);
//       test/mcp-plugin-session-auth-r378:24  YA=new Set(['needs-auth','failed','connected']), XA=new Set(['http','sse'])
//
//   The test line is SLICED OUT OF THE OFFICIAL BUNDLE (`../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js`) and run
//   in a VM — minified names `YA`/`XA` and all. One is the reconstruction, the other is the artefact the reconstruction
//   is checked against. Sharing a constant would make the test agree with itself, which is the one thing a comparison
//   test must not do.
//
// PROGRESS
//       before R562   read 10 / 28
//       after         read 13 / 28
//
// WHAT IS NOT CLAIMED
//   Not that the remaining 15 are similar. Not that "replica vs original" is a small category — it may account for many
//   of the remaining groups, and if so the ledger's denominator overstates how much genuine duplication exists.
//   Not that the order difference in the directory list is provably inert for every platform: `mkdirSync` with
//   `recursive:true` is order-independent for sibling paths on the filesystems this project targets, and the paths here
//   are siblings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { READ, sig } from '../tools/read-ledger.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'tools', 'read-ledger.cjs');

const runNode = (args = []) => spawnSync(process.execPath, [LEDGER, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

test('the three groups read this round are in the ledger', () => {
  for (const members of [['appdata', 'home', 'localappdata', 'work'],
    ['connected', 'failed', 'needs-auth'], ['http', 'sse']]) {
    const entry = READ.find((e) => sig(e.members) === sig(members));
    assert.ok(entry, `[${members.join(',')}] has no ledger entry`);
    assert.equal(entry.round, 562, `[${members.join(',')}] records round ${entry.round}`);
  }
});

test('the failed prediction is recorded as a prediction, not quietly dropped', () => {
  const entry = READ.find((e) => e.members.includes('work') && e.members.includes('appdata'));
  assert.ok(entry, 'the directory-names entry is gone');
  assert.match(entry.note, /R561 predicted/i, 'the prediction is not named');
  assert.match(entry.note, /WRONG/i, 'the prediction is not marked wrong');
  assert.match(entry.note, /no `toLowerCase\(\)`/i, 'the reason it was wrong is not stated');
});

test('the directory list has no toLowerCase anywhere', () => {
  // The claim the entry makes. Verified against the files rather than trusted.
  const sites = [
    ['tools/proof-ccb-model-switch-r380.cjs', 46],
    ['tools/proof-ccb-unread-r383.cjs', 20],
    ['test/ccb-midturn-protocol-r378.test.mjs', 16],
    ['test/ccb-midturn-protocol-r378.test.mjs', 58],
    ['test/ccb-midturn-protocol-r378.test.mjs', 80],
    ['test/ccb-midturn-protocol-r378.test.mjs', 102],
    ['test/ccb-midturn-protocol-r378.test.mjs', 128],
  ];
  for (const [file, line] of sites) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')[line - 1] || '';
    assert.ok(!/toLowerCase/.test(text), `${file}:${line} does use toLowerCase, so the entry is wrong`);
    assert.match(text, /mkdirSync\(/, `${file}:${line} is not a mkdir site`);
    assert.match(text, /recursive\s*:\s*true/, `${file}:${line} does not pass recursive, so order COULD matter`);
  }
});

test('the replica pair is a bundle slice, not a hand-written copy', () => {
  const entry = READ.find((e) => sig(e.members) === sig(['http', 'sse']));
  assert.ok(entry, 'the transports entry is gone');
  assert.match(entry.verdict, /REPLICA vs ORIGINAL/, 'the verdict no longer names the relationship');
  // And the test really does slice from the official bundle.
  const src = fs.readFileSync(path.join(ROOT, 'test', 'mcp-plugin-session-auth-r378.test.mjs'), 'utf8');
  assert.match(src, /ccd-ref\/asar\/\.vite\/build/, 'the test no longer reads the official bundle');
  assert.match(src, /new Set\(\['needs-auth','failed','connected'\]\)/, 'the statuses slice is gone');
  assert.match(src, /new Set\(\['http','sse'\]\)/, 'the transports slice is gone');
  // And the production module keeps its Sets private.
  const prod = fs.readFileSync(path.join(ROOT, 'desktop', 'mcp-session-auth.cjs'), 'utf8');
  assert.ok(!/module\.exports\s*=\s*\{[^}]*statuses/.test(prod), 'the production Set is now exported, so consumers could share it');
});

test('the two adjacent groups share one finding', () => {
  const a = READ.find((e) => sig(e.members) === sig(['http', 'sse']));
  const b = READ.find((e) => sig(e.members) === sig(['connected', 'failed', 'needs-auth']));
  assert.match(a.note, /mcp-session-auth\.cjs:10/, 'the transports entry does not name its line');
  assert.match(b.note, /mcp-session-auth\.cjs:9/, 'the statuses entry does not name its line');
  assert.match(b.note, /Both groups come from one pair of adjacent lines|same two lines/i,
    'the entries do not say they are the same pair of lines');
});

test('the ledger keeps reporting the split after three more reads', () => {
  const r = runNode(['--json']);
  assert.equal(r.status, 0, 'the ledger failed');
  const d = JSON.parse(r.stdout);
  assert.ok(d.read >= 13, `the ledger reports ${d.read} read, fewer than the 13 recorded here`);
  assert.equal(d.read + d.unread, d.liveGroups, 'the split does not sum to the live groups');
});
