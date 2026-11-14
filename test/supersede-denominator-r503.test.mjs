// R503: the same correction mechanism applied to a one-round-old file, where the wrong number was in the
// group split rather than in the denominator.
//
// WHY A SECOND PASS WAS NEEDED
//   R502 annotated the seven R488–R494 files whose coverage figures rest on the 44-tool contract denominator.
//   It did not touch tool-absence-r500.md, and R501 had already shown that file's central claim was wrong: it
//   reported 7 tools as "listed-not-registered / unexplained", but four of those — TaskCreate, TaskGet,
//   TaskList, TaskUpdate — sit behind `isTodoV2Enabled()`, which R499 had traced and written up one round
//   BEFORE R500 was written.
//
//   The defect was specific and is worth naming: `src/tools.ts` writes the condition across three lines —
//       ...(isTodoV2Enabled()
//         ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
//         : []),
//   — and R500's matcher landed on the middle line, which does not begin with `...(`. It therefore classified
//   them as unconditionally registered. The fix (R501) walks backwards to the opening spread but must stop at
//   any line naming a different tool, or ListMcpResourcesTool gets attached to the `NODE_ENV === 'test'`
//   condition three lines above it — which is exactly what the first version did.
//
// THE CORRECTED SPLIT, NOW ASSERTED AGAINST THE TOOL ITSELF
//       9 not-in-build / 5 renamed / 4 flag-gated / 3 listed-not-registered / 2 feature-gated
//   The banner states it and the test reads it back out of tools/tool-absence.cjs's own output. A banner that
//   quotes numbers the tool no longer produces would be the same failure one level up.
//
// WHAT THIS ROUND ALSO PROVES ABOUT THE MECHANISM
//   R502's tool had a hardcoded "第 502 轮" in the banner heading. Applying it to a file annotated at R503 would
//   have labelled the banner with the wrong round, so the round is now per-file with a default. And the seven
//   R502 files were hash-checked before and after this round's run: unchanged. Annotation has to be surgical —
//   a mechanism that rewrites neighbouring files while adding one banner is not a correction mechanism.
//
// WHAT IS NOT CLAIMED
//   The three remaining unexplained tools (ListMcpResources, Mcp, ReadMcpResource) are still unexplained. R501
//   proposed `shouldDefer: true` and the data refuted it. This round annotates that fact; it does not resolve it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'supersede-denominator.cjs');
const ABSENCE = path.join(ROOT, 'tools', 'tool-absence.cjs');
const EVID = path.join(ROOT, 'evidence');

const R502_FILES = [
  'contract-denominator-r488.md',
  'contract-compare-r489.md',
  'contract-fields-r490.md',
  'contract-vs-impl-r491.md',
  'artifact-divergence-r492.md',
  'tool-relation-r493.md',
  'tool-relation-r494.md',
];

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

/** The banner marker for a file, read from the corrections registry (R513 moved the source of truth there). */
function markerFor(file) {
  const reg = JSON.parse(fs.readFileSync(path.join(EVID, 'corrections.json'), 'utf8'));
  const entry = reg.corrections.find((c) => c.file === file);
  assert.ok(entry, `${file} has no registry entry`);
  return `<!-- superseded-r${entry.round} -->`;
}

test('tool-absence-r500.md is now annotated and its body is intact', () => {
  const p = path.join(EVID, 'tool-absence-r500.md');
  assert.ok(fs.existsSync(p), 'the R500 evidence file is missing');
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.startsWith(markerFor('tool-absence-r500.md')),
    'R500 does not begin with the banner marker');
  // The original title must still be present below the banner, untouched.
  assert.match(text, /# 18 个"缺失"是九种不同陈述/, 'the original title is gone: the body was rewritten');
});

test('the banner says the group split was wrong, not merely outdated', () => {
  const text = fs.readFileSync(path.join(EVID, 'tool-absence-r500.md'), 'utf8');
  const head = text.slice(0, 2600);
  assert.match(head, /分组数字本身是错的/, 'the banner no longer says the split itself was wrong');
  assert.match(head, /isTodoV2Enabled/, 'the banner does not name the gate that was missed');
  assert.match(head, /跨行的条件展开/, 'the banner does not describe the actual defect');
  // Both the wrong and the corrected numbers must appear, or a reader cannot tell what changed.
  assert.match(head, /7 listed-not-registered/, 'the superseded number is not quoted');
  assert.match(head, /4 flag-gated/, 'the corrected number is not quoted');
});

test('the banner round is per-file, so R500 is labelled 503 and the rest 502', () => {
  // R513 moved the per-file round from a BANNER_ROUND table inside the tool to the corrections registry. The
  // property is unchanged and still worth asserting: R500 explains a different defect than the other seven and
  // was annotated a round later, so a single default round for all eight would mislabel it.
  const r500 = fs.readFileSync(path.join(EVID, 'tool-absence-r500.md'), 'utf8');
  assert.match(r500.slice(0, 400), /第 503 轮追加/, 'R500 is not labelled with the round that annotated it');

  for (const file of R502_FILES) {
    const text = fs.readFileSync(path.join(EVID, file), 'utf8');
    assert.match(text.slice(0, 400), /第 502 轮追加/,
      `${file}'s banner round changed; the per-file round is not being honoured`);
  }

  const reg = JSON.parse(fs.readFileSync(path.join(EVID, 'corrections.json'), 'utf8'));
  const byFile = new Map(reg.corrections.map((c) => [c.file, c.round]));
  assert.equal(byFile.get('tool-absence-r500.md'), 503, 'the registry gives R500 the wrong round');
  for (const file of R502_FILES) {
    assert.equal(byFile.get(file), 502, `the registry gives ${file} the wrong round`);
  }
});

test('annotating one file leaves the others byte-identical', () => {
  // Idempotence is necessary but not sufficient: the run must also be surgical. Capture, run, compare.
  // The write path moved to tools/corrections.cjs in R513, so surgery is verified through that tool.
  const before = new Map(R502_FILES.map((f) => [f, fs.readFileSync(path.join(EVID, f), 'utf8')]));
  const result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'corrections.cjs'), '--write'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  assert.equal(result.status, 0, 'corrections --write failed:\n' + (result.stderr || '').slice(0, 600));
  for (const file of R502_FILES) {
    const after = fs.readFileSync(path.join(EVID, file), 'utf8');
    assert.equal(after, before.get(file),
      `${file} changed while annotating a different file`);
  }
});

test('the corrected split in the banner matches what tool-absence now produces', () => {
  const out = spawnSync(process.execPath, [ABSENCE, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
  });
  assert.equal(out.status, 0, 'tool-absence failed:\n' + (out.stderr || '').slice(0, 600));
  const d = JSON.parse(out.stdout);
  const counts = d.rows.reduce((a, x) => { a[x.reason] = (a[x.reason] || 0) + 1; return a; }, {});

  // R500's banner quotes the split as it stood when the banner was written: 7 listed-not-registered, 4
  // flag-gated. R501 corrected it to 4 flag-gated and 3 unexplained; R504 and R506 then explained those last
  // three, so `listed-not-registered` is now zero. This test asserts the CURRENT truth rather than the number the
  // banner quotes, and says so, because a banner is a snapshot and a test written against a snapshot goes stale
  // silently.
  assert.equal(counts['not-in-build'], 9, 'the not-in-build count drifted from the banner');
  assert.equal(counts.renamed, 5, 'the renamed count drifted from the banner');
  assert.equal(counts['flag-gated'], 4, 'the flag-gated count drifted from the banner');
  assert.equal(counts['feature-gated'], 2, 'the feature-gated count drifted from the banner');
  assert.equal(counts['listed-not-registered'] || 0, 0,
    'an absence is unexplained again: R504/R506 closed those');

  // The three tools the R500 banner called unexplained are now filed by cause, and the split between causes is
  // the substance: two need an MCP server, one is a template name that no configuration can register.
  const mcpDependent = d.rows.filter((r) => ['ListMcpResources', 'ReadMcpResource'].includes(r.contractName));
  assert.deepEqual(mcpDependent.map((r) => r.reason).sort(), ['requires-mcp-server', 'requires-mcp-server'],
    'the resource pair is no longer filed as requiring an MCP server');
  const mcp = d.rows.find((r) => r.contractName === 'Mcp');
  assert.equal(mcp.reason, 'template-only-name',
    'Mcp is no longer filed as a template-only name');
});

test('the banner does not claim the open question was resolved', () => {
  const text = fs.readFileSync(path.join(EVID, 'tool-absence-r500.md'), 'utf8');
  const head = text.slice(0, 2600);
  assert.match(head, /至今原因未查明/,
    'the banner no longer admits that three tools remain unexplained');
});
