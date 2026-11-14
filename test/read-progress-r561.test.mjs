// R561: working the ledger queue — three groups read, and all three are legitimately three different things.
//
// THE QUEUE R560 BUILT
//   `tools/read-ledger.cjs` turned "which groups are unread" into an ordered list instead of a judgement call made fresh
//   each round. This round worked the first three:
//
//     ['alpha','beta']   2 families / 5 files / 21 sites
//     ['failed','needs-auth']  2 families / 4 files /  6 sites
//     ['name','path']    2 families / 4 files /  6 sites
//
// AND THE THREE ARE THREE DIFFERENT KINDS OF THING
//   This is the finding. A flat "repeated list" count treats them as one category, and they need three different
//   answers:
//
//   `['alpha','beta']` — FIXTURE NAMES. All 21 sites are the inline literal, none extracts it, none lists a third name,
//   and all 21 are in the same order. The pair means "two MCP servers" in each standalone script. Extracting it would
//   invent a dependency between five scripts that nothing else links.
//
//   `['failed','needs-auth']` — A VALUE SET, not a list. Every site is
//   `['needs-auth','failed'].includes(observedState)` inside a wait loop: a membership test on an observed value. Order
//   is irrelevant and the code never iterates it. Four sites, one idiom, nothing to unify.
//
//   `['name','path']` — AN EXPECTED VALUE. Six sites, every one an `assert.deepEqual(fields.sort(), ['name','path'])`
//   on `EnterWorktree`'s schema. Sharing the literal would move an expected value away from the assertion that owns it,
//   and a real field change SHOULD fail all of them.
//
//   So the three answers are "leave it", "leave it", and "leave it" — arriving at the same place by three different
//   routes, which is the point. A single verdict like "fixture collision" would have been wrong for two of them.
//
// PROGRESS, MEASURED
//       before this round   read 7 / 28
//       after               read 10 / 28
//
//   The fraction is the thing R560 made visible; this round moved it.
//
// WHAT IS NOT CLAIMED
//   Not that the remaining 18 are similar — they have not been read.
//   Not that "leave it" is the right answer for every future group: R558 found a real defect (`accountId`/`orgId`/
//   `generation`) by THIS SAME PROCEDURE, so the method does produce fixes; most groups simply do not need one.
//   Not that the three groups could never become shared rules. If a fourth script wanted the same two fixture servers
//   across a shared harness, the pair would become a constant — the judgement is about today's structure.
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
  for (const members of [['alpha', 'beta'], ['failed', 'needs-auth'], ['name', 'path']]) {
    const entry = READ.find((e) => sig(e.members) === sig(members));
    assert.ok(entry, `[${members.join(',')}] has no ledger entry`);
    assert.equal(entry.round, 561, `[${members.join(',')}] records round ${entry.round}, not 561`);
  }
});

test('the three verdicts are distinct, because the three groups are different kinds', () => {
  const kinds = ['alpha', 'failed', 'name'].map((k) => {
    const e = READ.find((x) => x.members.includes(k));
    return e ? e.verdict.split('—')[0].trim() : null;
  });
  assert.equal(new Set(kinds).size, 3,
    `the three verdicts collapsed into ${kinds.join(' / ')}, which hides that they are different cases`);
  // The three kinds, named: a fixture, a value set the code tests against, and an assertion's expected value.
  assert.deepEqual(kinds, ['FIXTURE NAMES', 'VALUE SET', 'EXPECTED VALUE'],
    `the three kinds are ${kinds.join(' / ')}, not the three distinct cases this round found`);
});

test('alpha/beta is one shape everywhere, so a shared constant would buy nothing', () => {
  const files = [
    'tools/proof-mcp-relay-runtime-r378.cjs', 'tools/proof-sdk-mcp.cjs',
    'tools/proof-sdk-resource-r378.cjs', 'tools/proof-sdk-stdio-r378.cjs', 'tools/sdk-mcp-probe.cjs',
  ];
  const shapes = new Map();
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\[([^[\]]{2,200})\]/g)) {
        if (!/'alpha'|"alpha"/.test(m[1])) continue;
        if (!/^[\s'",a-z]+$/.test(m[1])) continue;
        const vals = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => (x[1] !== undefined ? x[1] : x[2]));
        if (vals.length < 2) continue;
        const k = vals.join(',');
        if (!shapes.has(k)) shapes.set(k, []);
        shapes.get(k).push(`${file}:${i + 1}`);
      }
    });
  }
  assert.deepEqual([...shapes.keys()], ['alpha,beta'],
    `more than one shape exists, so the sites already disagree: ${[...shapes.keys()].join(' | ')}`);
});

test('the failed/needs-auth sites are membership tests, not iterations', () => {
  const files = [
    ['tools/proof-hidden-real-ccb-oauth.cjs', 31],
    ['tools/proof-hidden-real-ccb-plugin-oauth.cjs', 31],
    ['test/session-mcp-oauth-real-r378.test.mjs', 36],
    ['test/session-mcp-plugin-oauth-real-r378.test.mjs', 36],
  ];
  for (const [file, line] of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')[line - 1] || '';
    assert.match(text, /\['needs-auth','failed'\]\.includes\(/,
      `${file}:${line} is not the membership-test idiom`);
    assert.ok(!/for\s*\(const\s+\w+\s+of\s*\['needs-auth'/.test(text),
      `${file}:${line} iterates the set, so it would be a list after all`);
  }
});

test('the name/path sites are assertion expectations', () => {
  const files = [
    ['test/field-census-r419.test.mjs', 130],
    ['test/field-gap-r394.test.mjs', 107],
    ['test/field-matrix-r395.test.mjs', 93],
    ['test/section1-fields-r405.test.mjs', 61],
  ];
  for (const [file, line] of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')[line - 1] || '';
    assert.match(text, /assert\.(deepEqual|deepStrictEqual)\(/,
      `${file}:${line} is not an assertion, so it is not an expected value`);
    assert.match(text, /'name'/, `${file}:${line} does not carry the expected literal`);
  }
});

test('the ledger reports the fraction this round moved', () => {
  const r = runNode(['--json']);
  assert.equal(r.status, 0, 'the ledger failed');
  const d = JSON.parse(r.stdout);
  assert.ok(d.read >= 10, `the ledger reports ${d.read} read, fewer than the 10 recorded here`);
  assert.equal(d.read + d.unread, d.liveGroups, 'the split does not sum to the live groups');
  assert.ok(d.unread > 0, 'nothing is left unread, which the evidence does not support');
});
