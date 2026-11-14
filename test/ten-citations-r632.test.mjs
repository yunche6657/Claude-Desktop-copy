// R632: the ten citations R631 set aside, read one by one. Nine are uses, one is a dependency-chain mention — so R631's split
// holds and the 41 stands.
//
// WHAT WAS CHECKED
//       approval-kernel-probe     invocation description   how it drives session-kernel + bridge
//       ccb-contract-diff         command line             `node tools/ccb-contract-diff.cjs`
//       official-contract         command line             with three real arguments
//       proof-packaged-history    audit row                what it searches, and that it is latent
//       proof-r397-build-repro    capability row           "4 mutation regressions + --verify"
//       suite-report              attempt and outcome      "batch three: process ended after batch 4"
//       tool-timeline             capability row           which versions introduced or removed a tool
//       unhandled-null            result table             its three results, named
//       update-changelog          command line             twice, including `--from 2.1.280`
//       resolved-8                dependency chain         "ccb-contract-diff → ccb-tool-map → resolved-8"
//
//   Nine say something a reader could act on; the tenth names the tool as a link in a chain, which is content but not a use.
//
// WHY THIS SETTLES R631
//   R631 said 41 of 51 evidence-only tools are mentioned only by generated indexes. Had these ten been bare mentions, the number
//   would be 51. Reading them shows the split is real: the record DOES cite instruments where it used them.
//
// WHAT IS NOT CLAIMED
//   Not that the 41 were used without being cited: they ran, but "ran" and "cited" are separate facts and only the second was
//   measured here.
//   Not that a command line proves the tool worked: it proves the round intended to run it. `suite-report` is the counter-example
//   in this very list — cited with a command, and it did not complete.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, CONCLUSION } from '../desktop/ten-citations.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every cited document still exists and still names its tool', () => {
  for (const c of CASES) {
    const p = path.join(ROOT, 'evidence', c.doc);
    assert.ok(fs.existsSync(p), `${c.doc} is gone`);
    const stem = c.tool.replace(/\.cjs$/, '');
    assert.ok(fs.readFileSync(p, 'utf8').includes(stem), `${c.doc} no longer names ${stem}`);
  }
});

test('the nine uses and one mention add up', () => {
  assert.equal(CASES.length, CONCLUSION.ten);
  assert.equal(CASES.filter((c) => c.use).length, CONCLUSION.uses);
  assert.equal(CASES.filter((c) => !c.use).length, CONCLUSION.mentionsWithContent);
  assert.equal(CONCLUSION.uses + CONCLUSION.mentionsWithContent, CONCLUSION.ten);
});

test('the one mention is the dependency chain, not a use', () => {
  const m = CASES.filter((c) => !c.use);
  assert.equal(m.length, 1);
  assert.equal(m[0].tool, 'resolved-8.cjs');
  assert.equal(m[0].kind, 'dependency-chain');
});

test('the four command-line citations really are command lines', () => {
  const cmd = CASES.filter((c) => c.kind === 'command-line');
  assert.ok(cmd.length >= 3, `only ${cmd.length} command-line citations`);
  for (const c of cmd) {
    const text = fs.readFileSync(path.join(ROOT, 'evidence', c.doc), 'utf8');
    const stem = c.tool.replace(/\.cjs$/, '');
    assert.ok(new RegExp('node\\s+tools/' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text),
      `${c.doc} has no \`node tools/${stem}\` line`);
  }
});

test('the suite-report counter-example is still an incomplete attempt', () => {
  const text = fs.readFileSync(path.join(ROOT, 'evidence', 'suite-truncation-r542.md'), 'utf8');
  assert.match(text, /写到第 4 批后进程结束|process ended after batch 4/, 'the incomplete outcome is gone');
});

test('the conclusion keeps the two facts separate', () => {
  assert.match(CONCLUSION.splitHolds, /the 41 stands/, 'the split is not restated');
  assert.match(CONCLUSION.gapIs, /not about the tools/, 'the gap is misattributed to the tools');
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'ten-citations.cjs'), 'utf8');
  assert.match(src, /Not that a command line proves the tool worked/, 'the command-line caveat is missing');
  assert.match(src, /counter-example/, 'the counter-example is not flagged');
});
