// R578: `group-provenance`'s key required two facts in the SAME EXPRESSION. A path built once and joined later defeated it.
//
// THE PATTERN THE KEY ASKED FOR
//   R562 found that `['http','sse']` in `mcp-session-auth.cjs` and in a test are not a duplicate: one is the reconstruction,
//   the other is official code sliced out of the bundle and run in a VM. R563 turned that into a detector requiring BOTH
//   reading the bundle AND executing a slice — the right two conditions.
//
// WHAT IT MISSED
//   The reading condition was spelled `readFileSync(<path containing ccd-ref>)`. A test that names the directory once and
//   joins a chunk filename onto it satisfies both conditions but neither spelling:
//
//       cli-mcp-host-sources-r378.test.mjs:13   const base = path.resolve('../ccd-ref/asar/.vite/build');
//       :14                                    const lza = fs.readFileSync(path.join(base, 'index.chunk-lzaSYO3Q.js'), 'utf8');
//       :23                                    vm.runInNewContext(`(()=>{ … ${lza.slice(…) } … })()`)
//
//   That file reads THREE chunks and runs slices of all of them. It was invisible.
//
// MEASURED
//       executing test files                          69
//       recognised by the narrow rule                 36
//       recognised by the broad rule                  52
//       MISSED                                        16
//
//   Sixteen files doing exactly what the detector exists to find, because the path was assembled instead of inlined. This
//   is the third instance of the same failure mode in this project — R574's field-name key, R575's receiver key, and this
//   one all asked for two facts in one container when the code keeps them in two.
//
// THE FIX AND ITS EFFECT
//   A bundle read is now recognised either directly (`readFileSync(…ccd-ref…)`) or by a DIRECTORY DECLARATION plus any
//   `readFileSync` in the same file. `replica-vs-original` went from 4 groups to 5, and the group that appeared is the
//   12-fact keep-awake list R577 read — which is both a legitimate shared constant AND a replica-versus-original case, and
//   had only been recorded as the former.
//
// WHAT IS NOT CLAIMED
//   Not that 52 is now complete: a test could import a helper module that does the reading, in which case neither spelling
//   appears in the test file at all. That shape would need the import graph, and it is recorded as the next gap rather than
//   guessed at here.
//   Not that the 16 missed files were all replicas: the wide rule asserts only that reading and executing coexist, which is
//   the criterion — but the two could still be unrelated within one file. Reading them is what would settle it, and the
//   group-level output only reports groups, not files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'group-provenance.cjs');
const TEST_DIR = path.join(ROOT, 'test');

const EXEC = /vm\.runInNewContext|new Function\(|\beval\(/;
const NARROW = /readFileSync\([^)]*(ccd-ref|\.asar|\.vite[\/\\]build|ion-dist|pinned-ion)/;
const DECLARED = /['"][^'"]*(?:ccd-ref|asar[\/\\]\.vite|\.vite[\/\\]build|ion-dist|agent-core[\/\\]claude-code[\/\\]dist)[^'"]*['"]/;

test('the joined-path form is recognised by the widened rule', () => {
  const file = path.join(TEST_DIR, 'cli-mcp-host-sources-r378.test.mjs');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(EXEC.test(text), 'the file no longer executes a slice');
  assert.ok(DECLARED.test(text), 'the file no longer declares the bundle directory');
  assert.ok(!NARROW.test(text),
    'the file now uses the inline form, so this test no longer demonstrates the split');
  // The widened rule recognises it. NOTE: the tool only reports files that appear in a REPEATED LIST group, and this file
  // carries no repeated list — so asserting that the TOOL names it would be asserting the wrong thing. What has to hold is
  // that the rule reads it as official material.
  assert.ok(DECLARED.test(text) && /readFileSync\(/.test(text),
    'the widened rule does not cover the joined form');
});

test('the two spellings together cover more files than the inline one alone', () => {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs'));
  let exec = 0;
  let narrow = 0;
  let broad = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    if (!EXEC.test(text)) continue;
    exec += 1;
    if (NARROW.test(text)) narrow += 1;
    if (NARROW.test(text) || (DECLARED.test(text) && /readFileSync\(/.test(text))) broad += 1;
  }
  assert.ok(exec > 50, `only ${exec} executing test files`);
  assert.ok(broad > narrow, `broad ${broad} is not greater than narrow ${narrow}: the split form is not covered`);
  assert.ok(exec - narrow >= 10, `only ${exec - narrow} files are outside the narrow rule`);
});

test('the replica count grew and includes the keep-awake list', () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  const d = JSON.parse(r.stdout);
  const replica = d.rows.filter((g) => g.kind === 'replica-vs-original');
  assert.ok(replica.length >= 5, `only ${replica.length} replica groups: the joined form is not counted`);
  assert.ok(replica.some((g) => g.members.includes('violinBow')),
    'the keep-awake list is not classified as replica-vs-original');
});

test('the tool records why the narrow rule failed', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /TWO WAYS TO READ THE BUNDLE/, 'the two spellings are not documented');
  // The sentence wraps across lines, so it is matched with whitespace tolerance rather than as one line.
  assert.match(src, /16 of 69\s+[\s\S]{0,40}?missed/, 'the measurement is not recorded');
  assert.match(src, /const base = path\.resolve|path\.join\(base/, 'the failing shape is not shown');
});

test('the remaining gap is stated rather than closed by guesswork', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /import a helper module|import graph/,
    'the helper-module gap is not recorded');
});
