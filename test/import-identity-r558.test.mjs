// R558: ranking the 31 repeated lists by CONCENTRATION turned up the first real shared rule in six rounds.
//
// WHY A NEW RANKING WAS NEEDED
//   `duplicated-lists` ranks by file count, which puts two unrelated things side by side:
//
//     a real shared constant     one meaning for every file that carries it — a union terminator, an env allowlist.
//                                If it drifts, one file behaves differently.
//     a fixture-name collision   two synthetic strings (`alpha`/`beta`) that many unrelated tests use to mean "two of
//                                something". Nothing is shared, so nothing can drift.
//
//   R553, R554 and R557 read nine of the thirty-one, chosen by that flat ranking. `tools/list-concentration.cjs` reorders
//   by how many distinct FILE FAMILIES (`<dir>/<basename prefix>`) carry the group, ascending. A shared rule lives in one
//   family; a fixture name spreads.
//
//     most concentrated                       most spread
//       [APPDATA, HOME, …]        1 family      [LocalAgentModeSessions, LocalSessions]   15 families
//       [accountId, orgId, …]     1 family
//       [ANTHROPIC_API_KEY, …]    1 family
//
// WHAT IT FOUND
//   `['accountId','orgId','generation']` in three files of one family: `desktop/history-import-{fixture-host,flow,
//   transaction}.cjs`. All three guard with
//
//       !['accountId','orgId','generation'].every(k => typeof identity[k] === 'string' && identity[k])
//
//   — byte-identical in `flow` and `transaction`, with `fixture-host` adding its own `!path.isAbsolute(root) ||` in
//   front — and all three derive the comparison key as
//
//       JSON.stringify([identity.accountId, identity.orgId, identity.generation])
//
//   THE KEY IS THE PART THAT MATTERS. It is what two imports are compared BY. Had one file ordered the array
//   `[orgId, accountId, generation]`, imports from one account would be treated as a different account and the guard
//   would still pass. Three hand-written copies of a composite key is exactly where that happens silently.
//
//   Both now come from `desktop/import-identity.cjs`. Verified: the guard agrees with the original on 11 of 11 inputs
//   (including `''`, `'0'`, a numeric generation, a null generation, a missing field, a unicode identity), and the key
//   is byte-identical for every usable identity.
//
// A SHADOWING TRAP HIT ON THE WAY
//   `history-import-flow.cjs` and `history-import-fixture-host.cjs` each already declare a local `identityKey()` — one
//   awaits `getIdentity()`, the other closes over `identity`. Importing a function of the same name shadows nothing but
//   reads as an unused import. Both imports are aliased to `keyOfIdentity`, and both call sites say why.
//
// WHAT IS NOT CLAIMED
//   Not that concentration implies correctness: a concentrated fixture name is still a fixture, and a real constant used
//   by two unrelated tools would look spread. The ranking reorders reading time; it does not decide.
//   Not that the remaining 22 groups were read — the top six by concentration were. What changed is that the ordering now
//   puts candidates first instead of samples.
//   Not that `generation` must be a non-empty string: that is a product question the shared module deliberately does not
//   decide, and the guard preserves whatever the three copies already required.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IDENTITY_FIELDS, isIdentity, identityKey } from '../desktop/import-identity.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'list-concentration.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
});

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the concentration tool failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('the identity guard matches all three original copies', () => {
  const original = (identity) => !!identity
    && ['accountId', 'orgId', 'generation'].every((k) => typeof identity[k] === 'string' && identity[k]);
  const cases = [
    { accountId: 'a', orgId: 'o', generation: 'g' },
    { accountId: '', orgId: 'o', generation: 'g' },
    { accountId: 'a', orgId: '', generation: 'g' },
    { accountId: 'a', orgId: 'o', generation: '' },
    { accountId: 'a', orgId: 'o', generation: 1 },
    { accountId: 'a', orgId: 'o', generation: null },
    { accountId: 'a', orgId: 'o' },
    { accountId: 'a' },
    undefined,
    null,
    { accountId: '0', orgId: '0', generation: '0' },
    { accountId: '账户', orgId: '组织', generation: '代' },
  ];
  for (const c of cases) {
    assert.equal(isIdentity(c), original(c), `disagreement for ${JSON.stringify(c)}`);
  }
});

test('the identity key is byte-identical to the hand-written form', () => {
  const original = (i) => JSON.stringify([i.accountId, i.orgId, i.generation]);
  for (const c of [
    { accountId: 'a', orgId: 'o', generation: 'g' },
    { accountId: '0', orgId: '0', generation: '0' },
    { accountId: '账户', orgId: '组织', generation: '代' },
  ]) {
    assert.equal(identityKey(c), original(c), 'the key bytes differ, which would make equal identities unequal');
  }
  // Field order is the point: a different order is a different key.
  assert.deepEqual(IDENTITY_FIELDS, ['accountId', 'orgId', 'generation']);
});

test('all three files import the rule and none spells it out', () => {
  for (const rel of ['desktop/history-import-flow.cjs', 'desktop/history-import-transaction.cjs',
    'desktop/history-import-fixture-host.cjs']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /require\('\.\/import-identity\.cjs'\)/, `${rel} does not import the identity rule`);
    assert.ok(!/\['accountId',\s*'orgId',\s*'generation'\]\.every/.test(src),
      `${rel} still spells out the guard`);
    assert.ok(!/JSON\.stringify\(\[identity\.accountId/.test(src),
      `${rel} still hand-writes the comparison key`);
  }
});

test('the shadowing is handled by aliasing, and the reason is recorded', () => {
  // Both files declare a local `identityKey`; importing one of the same name would read as unused.
  for (const rel of ['desktop/history-import-flow.cjs', 'desktop/history-import-fixture-host.cjs']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /identityKey:\s*keyOfIdentity/, `${rel} does not alias the import`);
    assert.match(src, /Aliased because|aliased because|import is aliased because/i,
      `${rel} does not say why the import is aliased`);
  }
});

test('the concentration ranking puts single-family groups first', () => {
  const d = report();
  assert.ok(d.rows.length > 10, `only ${d.rows.length} groups ranked`);
  const counts = d.rows.map((r) => r.familyCount);
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(counts[i] >= counts[i - 1], `the ranking is not ascending in family count at index ${i}`);
  }
  assert.equal(counts[0], 1, `the most concentrated group spans ${counts[0]} families, expected 1`);
  assert.ok(counts[counts.length - 1] > 5, 'the most spread group spans few families: the spread measure collapsed');
});

test('the group that produced this round has been unified away', () => {
  // BEFORE R558: `['accountId','orgId','generation']` appeared in three files of one family and was ranked first by
  // concentration. AFTER: the only remaining sites are the shared module that now owns the list and the test that
  // exercises it — no caller spells it out.
  //
  // The concentration ranking therefore no longer contains that group, and asserting that it DOES would assert the fix
  // did not work. What has to hold is the absence.
  const d = report();
  const g = d.rows.find((r) => r.values.includes('accountId') && r.values.includes('orgId'));
  if (g) {
    for (const fam of g.families) {
      assert.ok(!/^desktop\/history-import/.test(fam),
        `a history-import file still carries the identity list: ${fam}`);
    }
  }
  // And the rule itself lives in exactly one production file.
  const owners = [];
  for (const name of fs.readdirSync(path.join(ROOT, 'desktop'))) {
    if (!name.endsWith('.cjs')) continue;
    const src = fs.readFileSync(path.join(ROOT, 'desktop', name), 'utf8');
    if (/\['accountId',\s*'orgId',\s*'generation'\]/.test(src)) owners.push(name);
  }
  assert.deepEqual(owners, ['import-identity.cjs'],
    `the identity list is declared in ${owners.join(', ')} — expected only import-identity.cjs`);
});

test('the tool says the ranking is not a verdict', () => {
  const out = run([]).stdout;
  assert.match(out, /Not a verdict/, 'the output no longer says the ranking is not a judgement');
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /a concentrated fixture name is still a fixture/i,
    'the limit of the discriminator is not stated');
});
