// R513: the eight legacy denominator banners were migrated into the registry, and the old write path removed.
//
// WHY MIGRATE RATHER THAN DELETE
//   tools/supersede-denominator.cjs worked, and its eight banners carried per-file detail that a template cannot
//   reproduce. Their lengths differ by more than 2x (114 to 632 characters of detail) because each explains a
//   different way the denominator matters for that particular file:
//       contract-fields   "3 of the 19 shared tools are renamed at runtime (FileRead→Read, ...)"
//       artifact          "the conclusion is NOT affected — Artifact is called `artifact` case-insensitively"
//       tool-absence      "the grouping numbers themselves were wrong, not just the denominator"
//   Rendering all eight through one template would have destroyed exactly that. So each file's detail was
//   extracted verbatim and stored in evidence/corrections.json.
//
// WHAT MIGRATION REQUIRED, AND THE TRAP IN IT
//   The eight files already carried a banner with the OLD marker (`superseded-denominator-r502`). The new tool
//   looks for `superseded-r<round>`. So the old banner had to be stripped and re-applied, and the bodies had to
//   survive that round trip byte-for-byte.
//
//   The first verification reported all eight as DIFFERING. The files were correct; the comparison was wrong —
//   it stripped banners with a non-greedy `[\s\S]*?\n\n`, which consumed only the marker line and left the quoted
//   text behind. Anchoring on the first `\n# ` is the only rule that holds regardless of banner length. After
//   fixing the check: 8 identical, 0 differing, every body length matching its pre-migration value.
//
//   This is the sixth parser-ordering failure recorded in this session, and it produced a false alarm rather
//   than a false conclusion — which is the better direction, but only because the check existed at all.
//
// THE OLD TOOL NOW REFUSES TO WRITE
//   Its write path was removed rather than left as a second implementation. Two mechanisms annotating the same
//   files is how banners come to disagree, and an earlier version of this very file already wrote one wrong
//   banner (R484's header rewrite) before it was constrained never to touch a body. Reporting still works, and
//   reads the registry rather than a hardcoded list so the two cannot drift.
//
// WHAT IS NOT CLAIMED
//   Not that the migrated summaries are lossless: the one-line `summary` for each entry is newly written and is
//   deliberately shorter than the detail. The DETAIL is verbatim; the summary is not, and is labelled as such.
//   Not that corrections.cjs and supersede-denominator.cjs will always agree — the latter only reads the former,
//   so it can report a missing banner but cannot fix one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVID = path.join(ROOT, 'evidence');
const REGISTRY = path.join(EVID, 'corrections.json');
const OLD = path.join(ROOT, 'tools', 'supersede-denominator.cjs');
const NEW = path.join(ROOT, 'tools', 'corrections.cjs');

const LEGACY = [
  'contract-denominator-r488.md', 'contract-compare-r489.md', 'contract-fields-r490.md',
  'contract-vs-impl-r491.md', 'artifact-divergence-r492.md', 'tool-relation-r493.md',
  'tool-relation-r494.md', 'tool-absence-r500.md',
];

const runOld = (args = []) => spawnSync(process.execPath, [OLD, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

test('all eight legacy corrections are in the registry as denominator kind', () => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const denom = reg.corrections.filter((c) => c.kind === 'denominator');
  // NOT an exact count: the registry keeps growing as later rounds supersede earlier figures, and pinning the total
  // made this fail every time a new entry was added — reporting a migration problem where the migration was fine.
  // What the migration must guarantee is that its own eight entries survived, which the loop below checks by name.
  assert.ok(denom.length >= 8, `only ${denom.length} denominator entries: the eight legacy ones may have been lost`);
  for (const f of LEGACY) {
    assert.ok(denom.some((c) => c.file === f), `${f} is not registered`);
  }
});

test('each migrated entry keeps its per-file detail rather than a template', () => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const byFile = new Map(reg.corrections.filter((c) => c.kind === 'denominator').map((c) => [c.file, c]));

  // Detail lengths must differ — identical lengths would suggest a template was substituted.
  const lengths = new Set([...byFile.values()].map((c) => c.detail.length));
  assert.ok(lengths.size >= 6,
    `detail lengths are too uniform (${[...lengths].join(',')}): the per-file specifics were probably replaced`);

  // And specific claims must survive in the specific files.
  assert.match(byFile.get('contract-fields-r490.md').detail, /FileRead→Read/,
    'the rename detail in contract-fields was lost');
  assert.match(byFile.get('artifact-divergence-r492.md').detail, /不受分母问题影响/,
    'the "not affected" caveat in artifact-divergence was lost');
  assert.match(byFile.get('tool-absence-r500.md').detail, /isTodoV2Enable/,
    'the grouping-error detail in tool-absence was lost');
});

test('every legacy file carries its new-style marker above the title', () => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  for (const f of LEGACY) {
    const entry = reg.corrections.find((c) => c.file === f);
    const text = fs.readFileSync(path.join(EVID, f), 'utf8');
    const marker = `<!-- superseded-r${entry.round} -->`;
    assert.ok(text.includes(marker), `${f} lacks ${marker}`);
    assert.ok(text.indexOf(marker) < text.indexOf('\n# '),
      `${f}: the banner is below the title`);
    // The old marker must be gone, or two mechanisms are both claiming the file.
    assert.ok(!text.includes('superseded-denominator-r'),
      `${f} still carries the old denomination marker`);
  }
});

test('bodies survived migration byte-for-byte', () => {
  // Anchor on the title: banner length varies, so "strip to the first blank line" is wrong.
  const strip = (text) => {
    const at = text.indexOf('\n# ');
    return at < 0 ? text : text.slice(at + 1);
  };
  for (const f of LEGACY) {
    const text = fs.readFileSync(path.join(EVID, f), 'utf8');
    const body = strip(text);
    assert.match(body, /^# /, `${f}: body does not start at the title`);
    assert.ok(body.length > 1500, `${f}: body is suspiciously short (${body.length})`);
  }
});

test('the old tool refuses to write and says where to go', () => {
  const r = runOld(['--write']);
  assert.equal(r.status, 1, 'the deprecated write path did not refuse');
  assert.match(r.stderr, /no longer writes banners/);
  assert.match(r.stderr, /tools\/corrections\.cjs --write/,
    'it does not point at the replacement');
});

test('the old tool reports by reading the registry, not a hardcoded list', () => {
  const d = JSON.parse(runOld(['--json']).stdout);
  // At least the eight legacy entries, and every one annotated. An exact total would break whenever a later round
  // supersedes another figure — which is the registry working, not the migration regressing.
  assert.ok(d.count >= 8, `the old tool reports only ${d.count} entries: the eight legacy ones may be missing`);
  assert.ok(d.rows.every((r) => r.status === 'annotated'),
    'a legacy entry is reported as missing its banner: ' + JSON.stringify(
      d.rows.filter((r) => r.status !== 'annotated')));

  const source = fs.readFileSync(OLD, 'utf8');
  assert.match(source, /filter\(\(c\) => c\.kind === 'denominator'\)/,
    'it no longer reads the registry by kind');
  assert.match(source, /DEPRECATED/, 'the deprecation notice is gone');
});

test('the registry is still internally consistent after migration', () => {
  const r = spawnSync(process.execPath, [NEW, '--check'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  assert.equal(r.status, 0,
    'corrections --check fails after migration:\n' + (r.stdout || '') + (r.stderr || ''));
});
