// R491: the contract declares fields; the implementation either accepts them or it does not. Only a
// systematic pass can say which, and the extractor had to be fixed three times before it could be trusted.
//
// WHY THIS ROUND
//   R489 and R490 compared two contract files to each other — a statement about the official side.
//   Round 491 asks the question that actually bears on the reconstruction: does CCB's zod schema accept
//   what the contract declares? Spot-checking had confirmed one field (FileReadTool declares `allow_large`,
//   and its comment even cites "Official field (sdk-tools.d.ts FileReadInput)"), but one field in one tool
//   is not a measurement.
//
// THE THREE FAILED EXTRACTORS
//   v1  `^\s{4,}(\w+)\s*:\s*z\.` — matched 4-space-indented `name: z.string()`.
//       Reported 12 ArtifactTool fields absent. Spot-checking five reported-missing fields
//       (todos, run_in_background, multiline, replace_all, status) found EVERY ONE present in the source.
//       The regex was the defect.
//
//   v2  added `semanticBoolean(`/`semanticNumber(` wrappers at any indent, expecting that to be the gap.
//       It was worse: zero-coverage rose from 11 to 15 tools, including tools just reported fully covered.
//       A looser regex collected names from nested objects, type declarations and destructuring.
//
//   v3  abandons wrapper-matching entirely. The reason v1 and v2 failed is that this codebase formats
//       schemas several ways. EnterWorktreeTool writes
//           z
//             .strictObject({
//               name: z
//                 .string()
//       so the `name: z` line ends the expression, the indent is 8, and anything keyed on `z.` misses it.
//       The stable signal is position: a property name at line start followed by `:` or `?:`, in a file
//       that constructs a zod object. Prose ("- Setting status to deleted") has no such shape.
//
//   All three produced confident, plausible output. That is the recurring hazard in this project: a
//   detector that does not describe its subject, whose numbers are then read as findings. The response is
//   the self-check below — hand-verified facts about three specific tools, including the split-`z` case —
//   which aborts the report rather than emitting a comparison from a broken extractor.
//
// THE RESULT
//   Of 44 shared tools: 26 declare every official field, 3 are partial, 10 have no CCB directory, 5 have no
//   contract interface. The 10 with no directory match the 8 "missing" tools R488 verified by scanning
//   50,032 files, plus two more absent from the CLI contract's own union.
//
//   The notable partial case is Artifact: the contract declares 20 fields (action, favicon, icon, scope,
//   page_token, asset_id, capabilities, contract …) and CCB's ArtifactTool declares 3 — file_path, hash,
//   ttl — of which only file_path appears in the contract. That is the "same name, different tool" hazard
//   R443 warned about, now measured rather than suspected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'contract-vs-impl.cjs');
const CLI = path.join(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
const CCB = path.join(ROOT, '..', '.tmp', 'ccb-src', 'packages', 'builtin-tools', 'src', 'tools');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true,
});

const haveBoth = fs.existsSync(CLI) && fs.existsSync(CCB);

test('the comparison runs and produces a distribution', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, 'the tool failed:\n' + (result.stderr || '').slice(0, 900));
  const r = JSON.parse(result.stdout);
  assert.ok(!r.error, 'the tool refused to report: ' + r.error);
  assert.equal(r.results.length, 44, 'the shared tool count changed');

  const by = r.results.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
  assert.equal(by['all-present'], 26, 'the fully-covered count changed: ' + JSON.stringify(by));
  assert.equal(by['no-ccb-directory'], 10, 'the missing-directory count changed');
  assert.equal(by['partly-absent'], 3, 'the partial count changed');
});

test('the extractor is gated by a self-check on hand-verified tools', { skip: !haveBoth }, () => {
  // The gate is what makes the report trustworthy, given three failed extractors.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /function selfCheck/, 'the self-check is gone');
  assert.match(source, /EXTRACTOR SELF-CHECK FAILED/, 'the abort message is gone');
  assert.match(source, /Refusing to report a comparison/, 'the tool no longer refuses to report');

  // It must check the split-`z` formatting case, which is what v1 and v2 both missed.
  assert.match(source, /EnterWorktreeTool/, 'the split-z fixture is no longer checked');
  assert.match(source, /FileReadTool.*allow_large|allow_large.*FileReadTool/s,
    'the FileRead fixture is no longer checked');
});

test('the reported-missing fields really exist in the source', { skip: !haveBoth }, () => {
  // The v1 regression, pinned: these five were reported absent and all five were present.
  const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
  const cases = [
    ['GrepTool', 'multiline'],
    ['FileEditTool', 'replace_all'],
  ];
  for (const [dir, field] of cases) {
    const d = path.join(CCB, dir);
    if (!fs.existsSync(d)) continue;
    const text = fs.readdirSync(d)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => read(d, f)).join('\n');
    assert.ok(text.includes(field), `${dir} no longer mentions ${field}: the test premise changed`);
  }
});

test('Artifact is partial: the same name, a different tool', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  const art = r.results.find((x) => x.tool === 'Artifact');
  assert.ok(art, 'Artifact disappeared from the analysis');
  assert.equal(art.status, 'partly-absent', 'Artifact is no longer partial');

  // The contract declares 20 fields; CCB declares a handful, of which file_path is shared.
  assert.ok(art.officialFields.length >= 15,
    `Artifact's official field count dropped to ${art.officialFields.length}`);
  assert.ok(art.present.includes('file_path'), 'file_path is no longer the shared field');
  // Fields the contract has that CCB does not.
  for (const f of ['favicon', 'page_token', 'asset_id']) {
    assert.ok(art.missing.includes(f), `${f} is no longer reported missing from ArtifactTool`);
  }
  // And CCB has fields the contract does not, which is why this is a different tool rather than a subset.
  for (const f of ['hash', 'ttl']) {
    assert.ok(art.implementedFields.includes(f),
      `ArtifactTool no longer declares ${f}: then it may be a subset after all`);
    assert.ok(!art.officialFields.includes(f), `${f} is now in the contract too: re-derive the conclusion`);
  }
});

test('the ten tools with no directory are the ones already proven absent', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  const noDir = r.results.filter((x) => x.status === 'no-ccb-directory').map((x) => x.tool).sort();
  // These overlap with the eight R488 verified absent across 50,032 files.
  for (const name of ['ClaudeDesign', 'OfferChromeSetup', 'ReadMcpResourceDir',
    'ReportFindings', 'ScheduleWakeup', 'Projects']) {
    assert.ok(noDir.includes(name),
      `${name} is no longer reported as having no directory — R488 established it is genuinely absent`);
  }
});

test('the tool states what it does not establish', () => {
  // A field named in a source file is not proof the runtime accepts it. The tool must understate.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /unproven|does NOT claim|not proven|understate/i,
    'the tool no longer flags the difference between "declared" and "accepted"');
  assert.match(source, /text heuristic/i,
    'the tool no longer admits its extraction is a text heuristic');
});
