// R515: five more addenda, and a check that an addendum must name the round it rests on.
//
// WHY FIVE AND NOT SEVEN
//   Eight files carry a denominator banner. R514 added one addendum (tool-absence). This round surveyed the rest
//   and added five — but the pass was driven by re-measuring, not by "add one to each", and two files got nothing:
//
//     contract-denominator-r488   its 39/26 figures still hold. The MCP trio's open cause belonged to R500's
//                                 banner, not this one. Nothing here is stale.
//     contract-fields-r490        the three renames hold; nothing measured since contradicts it.
//
//   Adding an addendum where nothing is stale would be noise, and noise is what makes a real correction easy to
//   miss. So the mechanism's value depends on the addenda being selective.
//
// THE FIVE, AND WHAT EACH RESTS ON
//     contract-compare-r489   r509 — `Task` is the registered name of the CORE tool Agent, so "14 runtime-only"
//                                    needs qualifying: at least one is a second name, not a 40th tool.
//     contract-vs-impl-r491   r504 — the residual "and 3 more" bucket is gone; the split is 9/5/4/2/2/1
//                                    (requires-mcp-server 2 + template-only-name 1).
//     artifact-divergence     r506 — the MCP trio is not one class: two are exists-but-gated, one is
//                                    cannot-exist-as-named. Collapsing them implies a server would surface all three.
//     tool-relation-r493      r494 — the split changed: same-tool 19→20, unclassified 2→3.
//     tool-relation-r494      r501 — its three `unclassified` were resolved, and three NEW ones took their place.
//                                    Same number, different set: reading the count alone suggests no progress.
//
// THE NEW CHECK, AND WHY IT MATTERS MOST HERE
//   An addendum's own `round` is when it was WRITTEN, not when the measurement was made — contract-vs-impl's was
//   written this round but rests on R504 and R506. So every addendum must name at least one round in its text, and
//   `--check` fails when one does not. Without that, a batch of addenda becomes a pile of unsourced assertions
//   that look authoritative precisely because they are formatted consistently.
//
//   The check is `/\bR\d{3}\b|第 \d{3} 轮/` — either citation style accepted, because the evidence files use both.
//
// WHAT IS NOT CLAIMED
//   Not that every banner is now current. contract-denominator and contract-fields were judged current and left
//   alone; that judgement could itself be wrong, and only reading them again would show it.
//   Not that the addenda are exhaustive summaries of the later rounds — they name the round and the mechanism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVID = path.join(ROOT, 'evidence');
const TOOL = path.join(ROOT, 'tools', 'corrections.cjs');
const REGISTRY = path.join(EVID, 'corrections.json');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

const registry = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));

test('six addenda are registered across six distinct files', () => {
  const reg = registry();
  assert.equal(reg.addenda.length, 6, `expected 6 addenda, got ${reg.addenda.length}`);
  const files = new Set(reg.addenda.map((a) => a.file));
  assert.equal(files.size, 6, 'two addenda share a file: the count hides a duplicate');
});

test('each addendum cites the round it rests on', () => {
  for (const a of registry().addenda) {
    assert.match(a.text, /\bR\d{3}\b|第 \d{3} 轮/,
      `${a.file}'s addendum cites no round: it is an unsourced assertion`);
  }
  // And the check must enforce it.
  const r = run(['--check']);
  assert.equal(r.status, 0, '--check fails:\n' + (r.stdout || '') + (r.stderr || ''));
  assert.match(r.stdout, /0 citing no round/, 'the report does not count unsourced addenda');
});

test('the addenda rest on different rounds, matching the evidence', () => {
  const byFile = new Map(registry().addenda.map((a) => [a.file, a]));
  assert.match(byFile.get('contract-compare-r489.md').text, /R509/);
  assert.match(byFile.get('contract-vs-impl-r491.md').text, /R504/);
  assert.match(byFile.get('artifact-divergence-r492.md').text, /R506/);
  assert.match(byFile.get('tool-relation-r493.md').text, /R494/);
  assert.match(byFile.get('tool-relation-r494.md').text, /R501/);
  assert.match(byFile.get('tool-absence-r500.md').text, /R504/);
});

test('two files were deliberately left alone', () => {
  // The selectivity is the point: an addendum on every file would make a real one indistinguishable from noise.
  const files = new Set(registry().addenda.map((a) => a.file));
  assert.equal(files.has('contract-denominator-r488.md'), false,
    'contract-denominator got an addendum although its figures still hold');
  assert.equal(files.has('contract-fields-r490.md'), false,
    'contract-fields got an addendum although its figures still hold');
});

test('every addendum sits inside its banner, above the title', () => {
  for (const a of registry().addenda) {
    const text = fs.readFileSync(path.join(EVID, a.file), 'utf8');
    const marker = `<!-- addendum-r${a.round} -->`;
    assert.ok(text.includes(marker), `${a.file} lacks ${marker}`);
    assert.ok(text.indexOf(marker) < text.indexOf('\n# '),
      `${a.file}: the addendum is below the title and reads as original evidence`);
  }
});

test('the bodies of the four re-annotated files are unchanged', () => {
  // Only the banner region was touched. The body must still start at the title and retain its original length
  // class; exact pre-migration lengths were verified separately against the backup.
  const EXPECTED = {
    'contract-compare-r489.md': 2170,
    'contract-vs-impl-r491.md': 2347,
    'artifact-divergence-r492.md': 2549,
    'tool-relation-r493.md': 2713,
    'tool-relation-r494.md': 2755,
  };
  for (const [file, len] of Object.entries(EXPECTED)) {
    const text = fs.readFileSync(path.join(EVID, file), 'utf8');
    const body = text.slice(text.indexOf('\n# ') + 1);
    assert.equal(body.length, len, `${file}'s body changed length`);
    assert.match(body, /^# /, `${file}'s body does not start at the title`);
  }
});

test('tool-relation-r494 says the number is the same but the set is not', () => {
  // This is the subtlest of the six: a count that did not move while every member changed.
  const a = registry().addenda.find((x) => x.file === 'tool-relation-r494.md');
  assert.match(a.text, /数量现在是 3，但集合不同了/, 'the addendum no longer distinguishes count from membership');
  assert.match(a.text, /同一个数字，不同的对象/, 'the addendum no longer warns that the count misleads');
});

test('the tool documents that an addendum round is not the measurement round', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  // Wraps as: "Its own `round` is when\n//     it was written, which is not necessarily when the measurement was made"
  assert.match(source, /not necessarily when the measurement was made/,
    'the tool no longer explains why citation is separate from the addendum round');
  assert.match(source, /is an unsourced assertion/, 'the rationale for the citation check is gone');
});
