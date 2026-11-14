// tools/mutate.cjs proves that another test can fail. Its own behaviour is checked here in the
// parts that can be checked without running a nested test process.
//
// SCOPE NOTE (found the hard way): the tool was verified end to end by hand this round —
//   behavioural mutation -> exit 0, "RESULT: red"
//   comment-only mutation -> exit 1, "RESULT: GREEN"
//   missing anchor -> exit 2, refused, file untouched
// and the source file was confirmed byte-identical afterwards.
//
// What is NOT reproduced here is that end-to-end run. When this file spawns `node --test`
// from inside `node --test`, the child's summary output is unstable and the tool reported
// GREEN for a mutation that turns red when run directly — two rounds of debugging, and the
// conclusion is that a nested test runner inside a test runner is not a dependable fixture.
// Rather than ship an assertion that passes for the wrong reason, the spawning cases are
// left to the manual check and only the pure parts are asserted below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'mutate.cjs');

test('the mutation tool exists and documents its exit codes', () => {
  assert.ok(fs.existsSync(TOOL), 'tools/mutate.cjs is missing');
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /0 = the suite went red/);
  assert.match(source, /1 = the suite stayed green/);
  assert.match(source, /2 = the tool could not do its job/);
});

test('the tool refuses a missing anchor instead of reporting a survivor', () => {
  // Without this a typo in --find would look like "the test does not check it".
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /anchor not found in /);
  assert.match(source, /process\.exit\(2\)/);
});

test('the tool reports how many occurrences it mutated', () => {
  // Mutating one of several identical statements proves less than it looks like.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /occurrences mutated: /);
});

test('the tool verifies the restore by digest, not by assumption', () => {
  // First version asserted /originalDigest/ anywhere in the file. Renaming only the COMPARISON
  // (line 144) left it green, because the declaration on line 83 still matched. Assert the
  // comparison and the failure path separately.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /if \(restored !== originalDigest\) \{/, 'the restore is not compared against the original digest');
  assert.match(source, /RESTORE FAILED/, 'a failed restore does not report itself');
  assert.match(source, /process\.exit\(2\)/, 'a failed restore does not abort the run');
});
test('the tool captures the child output through a file, not a pipe', () => {
  // A piped child loses its summary when the tool itself runs under a test reporter; that
  // made a real finding read as GREEN. The file sink is the fix and must not regress.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /os\.tmpdir\(\), `mutate-/, 'the temporary log sink is gone');
  assert.match(source, /stdio: \['ignore', fd, fd\]/, 'the child is not writing to the file sink');
});

test('the tool restores the file even when the run throws', () => {
  // The restore lives in a finally block for exactly this reason.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /\} finally \{/);
  assert.match(source, /fs\.writeFileSync\(target, original\)/);
});
test('the tool can discover the tests that reference a module', () => {
  // Writing --tests by hand is how a real gap was missed: a batch run named two files that do
  // not cover Edit's ambiguity refusal and reported GREEN, while three OTHER files do cover it.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /function testsForModule\(file\)/, 'the discovery helper is gone');
  assert.match(source, /testsForModule\(args\.file\)/, 'discovery is not used when --tests is omitted');
});

test('the tool refuses to run when no test references the module', () => {
  // Silently running zero tests would always look GREEN, which is the worst possible answer.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /no tests reference /);
  assert.match(source, /pass --tests explicitly/);
});

test('the discovery helper matches on what tests reference, not on their names', () => {
  // cli-transcript.cjs is exercised by cli-transcript-chain.test.mjs, but concept/ naming is
  // not guaranteed; the check must read the file body.
  const source = fs.readFileSync(TOOL, 'utf8');
  const at = source.indexOf('function testsForModule(file) {');
  const body = source.slice(at, at + 900);
  assert.match(body, /readFileSync/, 'discovery does not read the test bodies');
  assert.match(body, /body\.includes/, 'discovery does not match on content');
});