// R559: the three proof-script lists differ only in ORDER, and the order cannot matter — recorded, not repaired.
//
// WHY ORDER AND NOT CONTENT
//   R558 ranked repeated lists by family concentration. After the identity rule was unified, the three most
//   concentrated remaining groups all lived in `tools/proof`. Proof scripts are the record of what a past round ran, so
//   editing one rewrites that record. The only thing worth measuring without editing is whether the copies AGREE — and
//   the only way they can disagree while the set is equal is order.
//
// WHAT WAS MEASURED
//   Three scripts carry the same ten environment names:
//
//       tools/proof-profile-relaunch.cjs:28      delete env[key]
//       tools/proof-resource-lifecycle.cjs:25    delete env[k]
//       tools/proof-window-quit.cjs:9            delete env[k]
//
//   Identical member count (10), identical set, and one order difference:
//
//       #7 CLAUDE_CCB_GATEWAY_ADAPTER   vs CLAUDE_REPLICA_DERIVED_DEFAULTS
//       #8 CLAUDE_CCB_GATEWAY_SYSTEM_PREFIX  vs CLAUDE_CCB_GATEWAY_ADAPTER
//       #9 CLAUDE_REPLICA_DERIVED_DEFAULTS   vs CLAUDE_CCB_GATEWAY_SYSTEM_PREFIX
//
//   The body is `delete env[k]` in all three. Every member is removed, so the resulting environment is the same set
//   regardless of iteration order. THE DIFFERENCE HAS NO BEHAVIOURAL CONSEQUENCE.
//
//   What it does show is that the three scripts were written separately from a shared intent rather than copied from one
//   source — three files, one idea, three orderings. That is a fact about provenance, and it is recorded as one.
//
// TWO DETECTOR DEFECTS FOUND BY DOING THIS
//   1. `tools/proof-list-order.cjs` counted ITSELF as a site: its own documentation names the lists, so `1x APPDATA,
//      HOME, …` appeared as a variant from line 9. A comment is not a site. The tool now excludes its own file.
//   2. The "does the surrounding code create directories" test asked whether `mkdir` appeared nearby and was satisfied
//      by an unrelated `mkdirSync` twelve lines later, labelling every group as order-critical. It now reads the loop
//      BODY: `delete env[key]` is order-independent, `fs.mkdirSync(dir)` is not.
//
// WHAT IS NOT CLAIMED
//   Not that order never matters. `for (const dir of [...]) fs.mkdirSync(dir)` would fail on a child created before its
//   parent, and that is exactly the shape the corrected test now detects. None of these three lists is that shape.
//   Not that the three scripts should be unified: rewriting a record to make it tidier destroys the evidence it exists
//   to hold.
//   Not that the remaining 22 unread groups hold nothing — this round measured the proof family only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'proof-list-order.cjs');

const SITES = [
  ['tools/proof-profile-relaunch.cjs', 28],
  ['tools/proof-resource-lifecycle.cjs', 25],
  ['tools/proof-window-quit.cjs', 9],
];

/** The members and the loop body at a site, using a balanced bracket walk rather than a regex. */
function parseSite(file, line) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')[line - 1];
  const open = text.indexOf('[');
  assert.ok(open >= 0, `${file}:${line} has no list`);
  let depth = 0;
  let quote = null;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '[') depth += 1;
    else if (c === ']') { depth -= 1; if (depth === 0) { close = i; break; } }
  }
  assert.ok(close > open, `${file}:${line} has an unterminated list`);
  const members = [...text.slice(open, close).matchAll(/'([^']*)'/g)].map((m) => m[1]);
  return { members, body: text.slice(close + 1).trim().replace(/;$/, '') };
}

test('the three proof scripts carry the same ten names', () => {
  const parsed = SITES.map(([f, l]) => ({ file: f, ...parseSite(f, l) }));
  for (const p of parsed) {
    assert.equal(p.members.length, 10, `${p.file} has ${p.members.length} members, expected 10`);
  }
  const first = [...parsed[0].members].sort().join(',');
  for (const p of parsed.slice(1)) {
    assert.equal([...p.members].sort().join(','), first, `${p.file} carries a different SET, not just a different order`);
  }
});

test('the loop body is a plain delete, so order cannot matter', () => {
  const parsed = SITES.map(([f, l]) => ({ file: f, ...parseSite(f, l) }));
  for (const p of parsed) {
    assert.match(p.body, /delete\s+env\[\w+\]/, `${p.file}'s loop body is not a delete: ${p.body}`);
  }
  // No mkdir in any body, which is what would make order load-bearing.
  for (const p of parsed) {
    assert.ok(!/mkdir|createDir/.test(p.body), `${p.file} creates directories from the list, so order WOULD matter`);
  }
});

test('the order difference is exactly the three gateway names', () => {
  const a = parseSite(SITES[0][0], SITES[0][1]).members;
  const c = parseSite(SITES[2][0], SITES[2][1]).members;
  const differing = [];
  for (let i = 0; i < Math.max(a.length, c.length); i += 1) if (a[i] !== c[i]) differing.push(i);
  assert.deepEqual(differing, [7, 8, 9],
    `the differing positions are ${differing.join(',')}, not the three gateway names`);
  // And the resource-lifecycle copy matches the first exactly.
  const b = parseSite(SITES[1][0], SITES[1][1]).members;
  assert.deepEqual(b, a, 'proof-resource-lifecycle no longer matches proof-profile-relaunch');
});

test('the tool does not count itself as a site', () => {
  // Its own documentation names the lists; the first run reported `1x APPDATA, HOME, …` from line 9.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /s\.file !== 'tools\/proof-list-order\.cjs'/,
    'the tool no longer excludes its own file');
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the tool failed');
  const d = JSON.parse(r.stdout);
  for (const row of d.rows) {
    for (const v of row.variants) {
      assert.ok(!v.files.some((f) => f.startsWith('tools/proof-list-order.cjs')),
        'the tool is still reporting its own comment as a site');
    }
  }
});

test('the order-critical test reads the loop body, not the neighbourhood', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /loopBody/, 'the loop body is no longer read');
  assert.match(src, /delete\\s\+\\w\+\\\[/, 'the delete exclusion is gone from the load-bearing test');
  // The doc wraps, so the phrase spans a newline: match across whitespace rather than for one literal line.
  assert.match(src, /unrelated\s+`mkdirSync`\s+twelve lines later|unrelated [`']?mkdirSync/,
    'the false positive that motivated the change is not recorded');
});

test('the tool states that it reports and does not repair', () => {
  const r = spawnSync(process.execPath, [TOOL], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Reported, not repaired/, 'the output no longer says the proof scripts are left alone');
});
