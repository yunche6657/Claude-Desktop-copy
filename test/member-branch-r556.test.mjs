// R556: a member-branch detector, and the third `version` check it turned up — which is not the same rule.
//
// PART ONE — THE QUESTION R555 LEFT OPEN
//   R555's presence-test detector covered 13 of 161 sites; the other 148 iterate a list without filtering it. The
//   remaining way such a site can differ is to branch on a member NAME inside the loop. tools/member-branch-divergence.cjs
//   looks for that: a comparison, switch, prefix test or membership test on the loop variable, or a member used as a
//   literal beyond its appearance in the list itself.
//
//   Its first version matched `[k]` anywhere in the body and reported every loop that stores into an object keyed by the
//   loop variable — `env[k] = path.join(dir, k)` in three proof scripts — as "branch on k". 17 groups, most false. A
//   subscript is indexed access, not a decision; the test was narrowed to comparisons and tests.
//
//   After the fix: 16 groups, of which 4 involve production files. Every one read, and none is a defect: the test-side
//   branches are individual `call('LocalSessions', …)` assertions, and the production ones are the two rules below.
//
// PART TWO — THE THIRD `version` CHECK IS A DIFFERENT QUESTION
//   `desktop/session-kernel.cjs:586` contains `!['string', 'number'].includes(typeof snapshot.version)` — the first line
//   of the rule that R555 unified into desktop/snapshot-shape.cjs. It does NOT carry the other three clauses, and the
//   gap is measurable:
//
//       input                       kernel   shared
//       ''                          accepts  rejects
//       1.5                         accepts  rejects
//       NaN                         accepts  rejects
//       Infinity                    accepts  rejects
//       unsafe integer              accepts  rejects
//       isCurrent missing           accepts  rejects
//       isCurrent not callable      accepts  rejects
//                                 -> 7 of 13 inputs disagree
//
//   It looks like one rule at two strictness levels. It is not: `snapshot.version` is never READ in session-kernel.cjs
//   — it appears at that line and nowhere else — so the clause there asks "does this snapshot look like the kind I
//   understand", while the shared rule guards a value a resumed import persists and later compares. Tightening the
//   kernel check would reject snapshots for no benefit, because the extra clauses protect a value it never uses.
//
//   So this round recorded the divergence in both files instead of unifying it. Recording matters: an unrecorded
//   7-of-13 disagreement is exactly what a later round "fixes" into a real bug.
//
// WHAT IS NOT CLAIMED
//   Not that branches on member names are defects — one file may legitimately care about one namespace, and the
//   test-side hits are exactly that.
//   Not that the kernel check is WRONG. It is weaker, and the weakness is justified by how the value is used; if
//   session-kernel.cjs ever starts reading `snapshot.version`, the stricter rule becomes the right one.
//   Not that the detector found every branch form: a computed key (`obj[prefix + svc]`) or a branch three frames down
//   in a helper would not be seen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionProblem } from '../desktop/snapshot-shape.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'member-branch-divergence.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
});

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('a bare subscript is not a branch on the member', () => {
  // The false positive that made the first run report 17 groups: `env[k] = …` is indexed access.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(!/\\\\\[\\\\s\*\\\$\\{v\}/.test(src), 'the bare-subscript pattern is back');
  const d = report();
  const envGroup = d.rows.find((r) => r.values.some((v) => v === 'APPDATA' || v === 'HOME'));
  if (envGroup) {
    const kBranch = envGroup.branching.filter((b) => b.members.some((m) => m.includes('branch on k')));
    assert.deepEqual(kBranch.map((b) => b.file), [],
      'a proof script is still reported as branching on `k`, which is only a subscript');
  }
});

test('the detector reports divergences and says they are not defects by themselves', () => {
  const d = report();
  assert.ok(d.listsExamined > 10, `only ${d.listsExamined} lists examined`);
  assert.ok(d.rows.length > 0, 'no divergences at all, which cannot be right for 31 lists');
  for (const r of d.rows) {
    assert.ok(r.branching.length > 0 && r.clean.length > 0,
      'a reported row has no plain file, so it is not a divergence');
  }
  const out = run([]).stdout;
  assert.match(out, /Not a defect by itself/, 'the output no longer says a branch may be legitimate');
});

test('the kernel version check is weaker than the shared rule, by a measured margin', () => {
  const kernelAccepts = (s) => ['string', 'number'].includes(typeof s.version);
  const cases = [
    { version: 7, isCurrent: () => true },
    { version: '', isCurrent: () => true },
    { version: 1.5, isCurrent: () => true },
    { version: NaN, isCurrent: () => true },
    { version: Infinity, isCurrent: () => true },
    { version: Number.MAX_SAFE_INTEGER + 2, isCurrent: () => true },
    { version: 1 },
    { version: 1, isCurrent: 'yes' },
  ];
  const disagreements = cases.filter((c) => kernelAccepts(c) !== (versionProblem(c) === null));
  assert.equal(disagreements.length, 7,
    `the gap is now ${disagreements.length}, not 7 — re-measure before relying on the recorded figure`);
  // And every disagreement is a case the kernel ACCEPTS and the shared rule rejects.
  for (const c of disagreements) {
    assert.equal(kernelAccepts(c), true, 'a disagreement runs the other way, which would be a new finding');
  }
});

test('both places record that the two checks answer different questions', () => {
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  assert.match(kernel, /A SHAPE CHECK, NOT THE STRICTER RULE/, 'the kernel clause is unexplained');
  assert.match(kernel, /appears here and nowhere else/, 'the reason the weakness is harmless is not stated');

  const shape = fs.readFileSync(path.join(ROOT, 'desktop', 'snapshot-shape.cjs'), 'utf8');
  assert.match(shape, /A THIRD PLACE CHECKS/, 'the shared module does not mention the third check');
  assert.match(shape, /never READ in session-kernel\.cjs/, 'the distinction is not stated at the shared module');
});

test('snapshot.version really is unread in session-kernel', () => {
  // The whole justification for leaving the kernel check weak. If this changes, the recorded reasoning is stale.
  //
  // COUNTED IN CODE, NOT IN COMMENTS — the first version counted raw occurrences and got 2, because the explanation
  // this round added to that very line also names `snapshot.version`. A count over raw text measures the documentation
  // as if it were usage, which is the same error as scanning prose for a pattern.
  const lines = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8').split('\n');
  const codeUses = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    if (t.startsWith('//')) continue;
    const code = lines[i].replace(/\/\/.*$/, '');       // trailing comment
    if (/snapshot\.version/.test(code)) codeUses.push(i + 1);
  }
  assert.equal(codeUses.length, 1,
    `snapshot.version is used in code at lines ${codeUses.join(', ')}: if it is now read, tighten that check`);
  // The one use is the type check itself, not a read of the value.
  const line = lines[codeUses[0] - 1];
  assert.match(line, /\['string', 'number'\]\.includes\(typeof snapshot\.version\)/,
    `the single use at line ${codeUses[0]} is not the shape check: ${line.trim().slice(0, 80)}`);
});

test('the kernel file still has CRLF line endings', () => {
  // An inserted comment can silently convert a file; the session kernel is CRLF throughout.
  const text = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
  assert.equal(bareLf, 0, `${bareLf} bare LF lines: the file's CRLF endings were damaged`);
});
