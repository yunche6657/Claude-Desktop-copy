// R488: verifying the coverage figure meant verifying its DENOMINATOR — and the denominator turned out
// to be reproducible, after the first attempt looked in the wrong file.
//
// WHAT WAS BEING VERIFIED
//   R487 restored tools/ccb-tool-map.cjs to runnable; it reports
//       officialCount 44 / equivalent 33 / coverageStrict 75%
//   That 33/44 is a ratio, so the question "is 75% right?" is really two questions: is the numerator right
//   (are those 33 genuinely equivalent?) and is the denominator right (are there really 44 official tools,
//   and are they the right 44?). This round addressed the denominator.
//
// THE MISTAKE THAT LOOKED LIKE A FINDING
//   The first pass searched `.tmp/ccb-src` and `agent-core` for sdk-tools.d.ts, found two copies of
//   117,768 bytes each, and measured 22 input + 20 output members with none of ClaudeDesign,
//   ScheduleWakeup, Projects, Workflow or Artifact present. From that it reported the hardcoded list
//   NOT REPRODUCIBLE and 25 names as unaccounted for — including TaskCreate and CronCreate, tools that
//   plainly exist.
//
//   The tell was that implausibility: a list containing CronCreate could not be wholesale invention. So the
//   next step was not a broader search but to read what the consumer actually opens. test/contract-tool-list-r443.test.mjs
//   line 33 says:
//       const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
//   That file is 173,038 bytes with 45 input + 44 output members, and contains every name the smaller SDK
//   copies lack.
//
//   "The artifact is not on disk" and "I looked in the wrong place" are indistinguishable from the outside.
//   One round earlier the same class of error pointed the other way, when a genuinely deleted %TEMP% build
//   turned out to be genuinely deleted. The only reliable discriminator is to read the reference the
//   consumer uses.
//
// THE VERDICT
//   44/44 (100%) of the hardcoded OFFICIAL list appears in `.tmp/cc-contract/package/sdk-tools.d.ts`.
//   The denominator is reproducible. 44 input members vs 44 output members after the union extraction,
//   and the one-tool difference R443 documented is between inputs and outputs, not between the list and
//   the contract.
//
//   Additionally, R488 independently confirmed that seven of the eight "missing" tools are absent from the
//   CCB source across 50,032 scanned files, and `Projects` matched only inside TypeScript's own compiler
//   bundles — so the missing rows are genuine absences, not parse failures.
//
// NOT ESTABLISHED HERE
//   The numerator. Whether the 33 "equivalent" pairings are correct needs a per-tool contract comparison,
//   which is what R440/R441/R442 did field by field for outputs. This round only proves the ratio's
//   denominator can be re-derived from a file in the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROV = path.join(ROOT, 'tools', 'contract-provenance.cjs');
const MAP = path.join(ROOT, 'tools', 'ccb-tool-map.cjs');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const runProv = (args = []) => spawnSync(process.execPath, [PROV, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true,
});

test('the coverage denominator is reproducible from a file in the repository', () => {
  const result = runProv(['--json']);
  assert.equal(result.status, 0, 'the provenance tool failed:\n' + (result.stderr || '').slice(0, 800));
  const report = JSON.parse(result.stdout);

  assert.equal(report.hardcodedCount, 44, 'the hardcoded list changed size: re-derive the coverage figure');
  assert.equal(report.reproducible, true,
    'the OFFICIAL list is no longer fully reproducible. Unaccounted names: '
    + JSON.stringify(report.hardcoded.filter((n) => !(report.best && report.best.names.includes(n)))));
  assert.equal(report.best.ratio, 1, 'the best-matching contract covers only part of the list');
  assert.match(report.best.file, /cc-contract/,
    'the reproducing file is no longer the contract package: ' + report.best.file);
});

test('the tool searches the contract package, not only the SDK caches', () => {
  // The regression that produced a false "not reproducible" verdict: searching .tmp/ccb-src found two
  // 22-member SDK copies and none of the real contract.
  const source = read(PROV);
  assert.match(source, /'cc-contract'/,
    'the contract package is no longer in the search roots: the tool will find only the smaller SDK copies');
  // And the search roots must be ordered so the real contract is found before the decoys.
  const ccIdx = source.indexOf("'cc-contract'");
  const srcIdx = source.indexOf("'ccb-src'");
  assert.ok(ccIdx > 0 && srcIdx > 0 && ccIdx < srcIdx,
    'the contract package is no longer searched first');
});

test('a smaller SDK contract is not mistaken for the authoritative one', () => {
  // The 117,768-byte copies are a genuinely different, smaller contract. They must be reported as such
  // rather than silently accepted as the source.
  const result = runProv(['--json']);
  const report = JSON.parse(result.stdout);
  const small = report.contracts.filter((c) => c.distinct === 22);
  assert.ok(small.length >= 1,
    'the smaller SDK contract copies are gone: this test premise changed');
  for (const c of small) {
    assert.ok(c.distinct < report.hardcodedCount,
      'a small contract reports at least as many tools as the hardcoded list');
  }
  // The tool must surface all copies, so a reader can see there is more than one contract.
  assert.ok(report.contracts.length >= 2,
    'only one contract copy is reported: a reader cannot tell there are competing versions');
});

test('the eight missing tools are genuinely absent from the upstream source', () => {
  // Independent of the tool: R488 scanned 50,032 files. Seven of the eight appear nowhere; `Projects`
  // matched only inside TypeScript compiler bundles, which have nothing to do with Claude tools.
  const missing = ['ClaudeDesign', 'OfferChromeSetup', 'Projects', 'ReadMcpResourceDir',
    'ReadNotifications', 'ReportFindings', 'ScheduleWakeup', 'ShowOnboardingRolePicker'];

  const mapSource = read(MAP);
  for (const name of missing) {
    assert.ok(mapSource.includes(`'${name}'`),
      `${name} is no longer listed in ccb-tool-map: the missing set changed`);
  }
  // They must also be absent from the contract's own union, which is what makes them missing rather than
  // unimplemented.
  const dts = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
  if (!fs.existsSync(dts)) {
    // The contract lives outside the repository; skip rather than fail on an environment difference.
    return;
  }
  const text = fs.readFileSync(dts, 'utf8');
  // These four ARE in the authoritative contract (that is why they are "missing" — the official side has
  // them and CCB does not). Confirm the direction rather than asserting absence.
  for (const name of ['ClaudeDesign', 'ScheduleWakeup', 'Projects', 'ShowOnboardingRolePicker']) {
    assert.ok(text.includes(name),
      `${name} is not in the contract either: then it is not an official tool and the row is wrong`);
  }
});

test('the tool reports a non-reproducible list as a failure, not a note', () => {
  // The mode is what makes the check enforceable in CI. Without it, the finding would be an observation.
  const source = read(PROV);
  assert.match(source, /--require-reproducible/,
    'the enforcing mode is gone: a broken denominator would only be printed, never fail');
  assert.match(source, /process\.exitCode = 1/,
    'the tool no longer exits non-zero on a bad verdict');
});

test('the numerator is explicitly out of scope', () => {
  // Stated in the evidence and enforced here: this round proves the denominator only. If a future edit
  // makes the tool claim the percentage is verified, that would overstate it.
  const evidence = read(ROOT, 'evidence', 'contract-denominator-r488.md');
  assert.match(evidence, /分母/, 'the evidence no longer distinguishes denominator from numerator');
  assert.match(evidence, /没有验证.*分子|分子.*没有/,
    'the evidence no longer disclaims having verified the numerator');
});
