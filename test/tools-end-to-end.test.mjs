// The seven agent tools, verified against real files and real processes.
//
// Measured this round (each was previously only covered by the agent loop's own tests,
// which use a stub model and therefore never exercise a tool end to end):
//
//   Write -> Read -> Edit round trip changes exactly the matched text
//   List    dir sub / file a.txt / file b.md
//   Glob    **/*.txt -> sub/c.txt, a.txt       *.md -> b.md
//   Bash    node -v -> v24.19.0 [exit 0]
//           git rev-parse in an empty dir -> [stderr] fatal: not a git repository [exit 128]
//           'node -v; rm -rf /' -> refused: shell operators
//
// Two of these were briefly misread as product bugs because the probe called the wrong
// entry point: tool.handler() instead of the executor (round 154), and an `args` array
// where the schema takes one command string (round 155). Both tools were correct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-verify-'));
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: dir, allowedRoots: [dir], execRoots: [dir] }).map((t) => [t.name, t]),
  );
  return { dir, byName, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('all seven tools are registered', () => {
  const w = workspace();
  try {
    assert.deepEqual(Object.keys(w.byName).sort(), ['Bash', 'Edit', 'Glob', 'List', 'Read', 'Skill', 'Write']);
  } finally { w.cleanup(); }
});

test('Write then Edit changes exactly the matched text and nothing else', async () => {
  const w = workspace();
  try {
    const f = path.join(w.dir, 'a.txt');
    await w.byName.Write.handler({ path: f, content: 'line1\nline2\nline3\n' });
    await w.byName.Edit.handler({ path: f, old_string: 'line2', new_string: 'LINE-TWO' });
    assert.equal(fs.readFileSync(f, 'utf8'), 'line1\nLINE-TWO\nline3\n', 'the edit changed more than the match');
  } finally { w.cleanup(); }
});

test('Glob distinguishes a recursive pattern from a shallow one', async () => {
  const w = workspace();
  try {
    fs.mkdirSync(path.join(w.dir, 'sub'));
    fs.writeFileSync(path.join(w.dir, 'a.txt'), 'A');
    fs.writeFileSync(path.join(w.dir, 'sub', 'c.txt'), 'C');
    fs.writeFileSync(path.join(w.dir, 'b.md'), 'B');
    const deep = String((await w.byName.Glob.handler({ pattern: '**/*.txt' })).content).split('\n').filter(Boolean).sort();
    const shallow = String((await w.byName.Glob.handler({ pattern: '*.md' })).content).split('\n').filter(Boolean);
    assert.deepEqual(deep, ['a.txt', 'sub/c.txt'], 'the recursive pattern missed or added a file');
    assert.deepEqual(shallow, ['b.md']);
  } finally { w.cleanup(); }
});

test('Bash reports the real exit code and stderr', async () => {
  const w = workspace();
  try {
    const ok = await w.byName.Bash.handler({ command: 'node -v' });
    assert.equal(ok.isError, false);
    assert.match(String(ok.content), /^v\d+\./, 'node -v produced no version');
    assert.match(String(ok.content), /\[exit 0\]/);

    // A non-zero exit must surface as an error with the code visible, not as silence.
    const failed = await w.byName.Bash.handler({ command: 'git rev-parse --is-inside-work-tree' });
    assert.equal(failed.isError, true, 'a failing command must be flagged');
    assert.match(String(failed.content), /\[exit (?!0\])\d+/, 'the exit code must be reported');
    assert.match(String(failed.content), /\[stderr\]/, 'stderr must be marked');
  } finally { w.cleanup(); }
});

test('Bash refuses shell metacharacters', async () => {
  // The allowlist is only meaningful if the argv cannot become a shell program.
  const w = workspace();
  try {
    await assert.rejects(
      () => w.byName.Bash.handler({ command: 'node -v; rm -rf /' }),
      /shell operators/,
    );
  } finally { w.cleanup(); }
});

test('a tool that escapes the workspace is refused', async () => {
  const w = workspace();
  try {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\x.txt' : '/etc/x.txt';
    await assert.rejects(() => w.byName.Write.handler({ path: outside, content: 'x' }), /outside the approved roots/);
  } finally { w.cleanup(); }
});
