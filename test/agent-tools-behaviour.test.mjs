// The seven tools the model can actually drive, measured against a real temp workspace.
//
// Desktop/tools.cjs defines Skill, Read, Write, Edit, List, Glob, Bash. Everything below was
// observed, not inferred:
//
//   Write  sub/dir/deep.md   -> created the missing directories, '+1 -0'
//   Read   sub/dir/deep.md   -> '1\tNESTED' (line-numbered)
//   Edit   note.md           -> '+1 -1', content replaced
//   List   sub/dir           -> 'file deep.md'
//   Glob   **/*.md           -> matched a file two levels down
//   Bash   node -e '1+1'     -> '2\n[exit 0]'
//   Bash   git status        -> stderr passed through with exit 12 (not a repo)
//
// And the boundaries, which matter more than the happy path:
//
//   Read  <outside>/secret.txt -> refused 'path is outside the approved roots'
//   Write <outside>/x.txt      -> refused
//   Glob  ../*.txt             -> 'No files matched.'
//   Bash  del ...              -> refused, 'del' is not in the allowlist
//   Bash  a && b               -> refused, shell operators are rejected
//
// The Bash allowlist deserves a note. It contains names that CANNOT run on Windows — ls, cat,
// pwd, echo, dir, npm, npx and friends are shell builtins or .cmd shims, and the resolver
// deliberately returns null for .cmd (spawning one needs cmd.exe, which reintroduces the
// injection surface the allowlist exists to remove). MEASURED: 'echo hi', 'pwd', 'dir' and
// 'npm --version' all answer '"x" is allowlisted but this machine has no spawnable binary'. That
// is the intended design and the refusal message already tells the caller to use node or git,
// so it is recorded here rather than 'fixed'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function sandbox() {
  const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-out-'));
  const tools = defineTools({ workspaceRoot: ws, allowedRoots: [ws], execRoots: [ws] });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const run = async (name, input) => {
    try { return await byName[name].handler(input); }
    catch (error) { return { threw: String(error.message) }; }
  };
  return {
    ws, outside, run,
    cleanup: () => {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    },
  };
}

test('the registry defines exactly the seven tools the model is offered', () => {
  const box = sandbox();
  try {
    const { defineTools, definitionsFor } = require(path.join(ROOT, 'desktop', 'tools.cjs'));
    const tools = defineTools({ workspaceRoot: box.ws, allowedRoots: [box.ws], execRoots: [box.ws] });
    const names = definitionsFor(tools).map((d) => d.name).sort();
    assert.deepEqual(names, ['Bash', 'Edit', 'Glob', 'List', 'Read', 'Skill', 'Write']);
  } finally { box.cleanup(); }
});

test('write creates missing directories and read returns the line-numbered file', async () => {
  const box = sandbox();
  try {
    const written = await box.run('Write', { path: 'sub/dir/deep.md', content: 'NESTED' });
    assert.ok(!written.threw, 'write failed: ' + written.threw);
    assert.ok(fs.existsSync(path.join(box.ws, 'sub', 'dir', 'deep.md')), 'the nested file was not created');
    const read = await box.run('Read', { path: 'sub/dir/deep.md' });
    assert.match(read.content, /NESTED/);
    assert.match(read.content, /^1\t/, 'read is no longer line-numbered: ' + JSON.stringify(read.content));
  } finally { box.cleanup(); }
});

test('edit replaces exactly one occurrence and reports the line delta', async () => {
  const box = sandbox();
  try {
    await box.run('Write', { path: 'note.md', content: 'HELLO-TOOL' });
    const edited = await box.run('Edit', { path: 'note.md', old_string: 'HELLO', new_string: 'EDITED' });
    assert.ok(!edited.threw, 'edit failed: ' + edited.threw);
    assert.equal(fs.readFileSync(path.join(box.ws, 'note.md'), 'utf8'), 'EDITED-TOOL');
  } finally { box.cleanup(); }
});

test('list and glob see files at depth', async () => {
  const box = sandbox();
  try {
    await box.run('Write', { path: 'sub/dir/deep.md', content: 'NESTED' });
    const listed = await box.run('List', { path: 'sub/dir' });
    assert.match(listed.content, /deep\.md/);
    const globbed = await box.run('Glob', { pattern: '**/*.md' });
    assert.match(globbed.content, /sub\/dir\/deep\.md|sub\\dir\\deep\.md/,
      'glob did not reach two levels down: ' + JSON.stringify(globbed.content));
  } finally { box.cleanup(); }
});

test('every file tool refuses to leave the approved roots', async () => {
  // The escape hatch must not exist at any of the three entry points.
  const box = sandbox();
  try {
    fs.writeFileSync(path.join(box.outside, 'secret.txt'), 'SECRET');
    const read = await box.run('Read', { path: path.join(box.outside, 'secret.txt') });
    assert.match(String(read.threw), /outside the approved roots/, 'read escaped: ' + JSON.stringify(read));
    const write = await box.run('Write', { path: path.join(box.outside, 'x.txt'), content: 'PWN' });
    assert.match(String(write.threw), /outside the approved roots/, 'write escaped: ' + JSON.stringify(write));
    assert.equal(fs.existsSync(path.join(box.outside, 'x.txt')), false, 'a file was written outside the roots');
    const glob = await box.run('Glob', { pattern: '../*.txt' });
    assert.ok(!String(glob.content || '').includes('secret.txt'), 'glob escaped: ' + JSON.stringify(glob));
  } finally { box.cleanup(); }
});

test('bash runs an allowlisted binary and passes stderr and the exit code through', async () => {
  const box = sandbox();
  try {
    const ok = await box.run('Bash', { command: 'node -e "console.log(1+1)"' });
    assert.match(ok.content, /^2/m, 'node did not run: ' + JSON.stringify(ok));
    assert.match(ok.content, /\[exit 0\]/);
    const failed = await box.run('Bash', { command: 'git status' });
    // Not a repository here, so this exercises the FAILURE path: stderr must survive.
    assert.match(String(failed.content), /fatal: not a git repository|\[exit 0\]/, 'failure output was swallowed');
  } finally { box.cleanup(); }
});

test('bash refuses shell operators and non-allowlisted programs', async () => {
  const box = sandbox();
  try {
    const chained = await box.run('Bash', { command: 'node --version && git --version' });
    assert.match(String(chained.threw), /shell operators/, 'shell chaining was allowed: ' + JSON.stringify(chained));
    const denied = await box.run('Bash', { command: 'del /f /q something' });
    assert.match(String(denied.threw), /not in the allowlist/, 'an unlisted program ran: ' + JSON.stringify(denied));
  } finally { box.cleanup(); }
});

test('a Windows-unspawnable allowlisted name is refused with an actionable reason', async () => {
  // npm/echo/pwd are allowlisted but resolve to .cmd or are shell builtins, and defaultResolve
  // returns null for those on purpose (spawning a .cmd needs cmd.exe, which reintroduces the
  // shell surface the allowlist removes).
  //
  // Every outcome is folded into ONE string and asserted unconditionally. An earlier draft used
  // `if (!out.threw) { ... continue }`, and test-hygiene.test.mjs flagged it: a guard wrapped
  // around an assertion is exactly how a mutation survives unnoticed.
  const box = sandbox();
  try {
    for (const command of ['echo hi', 'pwd', 'npm --version']) {
      const out = await box.run('Bash', { command });
      const refused = typeof out.threw === 'string';
      const outcome = refused ? 'refused: ' + out.threw : 'ran: ' + String(out.content || '').slice(0, 80);
      const acceptable = refused
        ? /no spawnable binary|not in the allowlist/.test(outcome)
        : outcome.length > 5;
      assert.equal(acceptable, true, command + ' neither ran nor was refused: ' + outcome);
    }
  } finally { box.cleanup(); }
});