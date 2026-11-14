// File tool and permission-mode tests.
//
// The file tools decide what may be touched on disk; the permission policy
// decides whether the user is asked first. Both are asserted against real files
// in a temporary root, including the refusal paths, because a tool that fails
// open is worse than one that fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const { readFile, previewWrite, writeFile, replaceInFile, resolveInsideRoots, ToolError } =
  await import('../desktop/file-tools.cjs');
const { MODES, ACTIONS, decide, isAllowedWithoutPrompt, assertMode } = await import('../desktop/permissions.cjs');

function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'ft-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('paths outside the approved roots are refused', () => withRoot(async root => {
  const outside = mkdtempSync(path.join(tmpdir(), 'ft-out-'));
  try {
    assert.throws(() => resolveInsideRoots(path.join(outside, 'x.txt'), [root]), /outside the approved roots/);
    assert.throws(() => resolveInsideRoots('anything.txt', []), /no workspace root/);
    assert.throws(() => resolveInsideRoots('anything.txt', null), /no workspace root/);
    assert.equal(resolveInsideRoots(path.join(root, 'a.txt'), [root]), path.resolve(root, 'a.txt'));
  } finally { rmSync(outside, { recursive: true, force: true }); }
}));

test('read returns content and line count, and refuses non-files', () => withRoot(async root => {
  const file = path.join(root, 'a.txt');
  writeFileSync(file, 'one\ntwo\nthree\n');
  const result = readFile(file, { allowedRoots: [root] });
  assert.equal(result.content, 'one\ntwo\nthree\n');
  assert.equal(result.lines, 3);

  assert.throws(() => readFile(path.join(root, 'missing.txt'), { allowedRoots: [root] }), /does not exist/);
  assert.throws(() => readFile(root, { allowedRoots: [root] }), /not a regular file/);
}));

test('previewWrite never touches the file', () => withRoot(async root => {
  const file = path.join(root, 'a.txt');
  writeFileSync(file, 'before\n');
  const preview = previewWrite(file, 'after\n', { allowedRoots: [root] });
  assert.equal(preview.existed, true);
  assert.equal(preview.diff.added, 1);
  assert.equal(preview.diff.removed, 1);
  assert.equal(readFileSync(file, 'utf8'), 'before\n', 'preview must not write');
}));

test('write applies content and reports a no-op when nothing changed', () => withRoot(async root => {
  const file = path.join(root, 'new.txt');
  const created = writeFile(file, 'hello\n', { allowedRoots: [root] });
  assert.equal(created.written, true);
  assert.equal(readFileSync(file, 'utf8'), 'hello\n');

  const again = writeFile(file, 'hello\n', { allowedRoots: [root] });
  assert.equal(again.written, false);
  assert.equal(again.reason, 'no-change');
}));

test('write creates missing parent directories', () => withRoot(async root => {
  const nested = path.join(root, 'a', 'b', 'c.txt');
  const result = writeFile(nested, 'deep\n', { allowedRoots: [root] });
  assert.equal(result.written, true);
  assert.equal(readFileSync(nested, 'utf8'), 'deep\n');
}));

test('replace requires the match to be unique', () => withRoot(async root => {
  const file = path.join(root, 'a.txt');
  writeFileSync(file, 'const a = 1;\nconst b = 1;\n');

  assert.throws(() => replaceInFile(file, 'const', 'let', { allowedRoots: [root] }), /occurs 2 times/);
  assert.throws(() => replaceInFile(file, 'nowhere', 'x', { allowedRoots: [root] }), /not found/);
  assert.equal(readFileSync(file, 'utf8'), 'const a = 1;\nconst b = 1;\n', 'a refused replace must not write');

  const ok = replaceInFile(file, 'const a = 1;', 'let a = 1;', { allowedRoots: [root] });
  assert.equal(ok.written, true);
  assert.equal(readFileSync(file, 'utf8'), 'let a = 1;\nconst b = 1;\n');
}));

test('a ToolError carries a stable code', () => withRoot(async root => {
  try {
    readFile(path.join(root, 'nope.txt'), { allowedRoots: [root] });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, 'not-found');
  }
}));

test('ask mode never prompts for reads but always prompts before changes', () => {
  assert.equal(decide(MODES.ASK, ACTIONS.READ).prompt, false,
    'prompting for reads would make every tool call unusable');
  assert.equal(decide(MODES.ASK, ACTIONS.EDIT).prompt, true);
  assert.equal(decide(MODES.ASK, ACTIONS.EXEC).prompt, true);
});

test('acceptEdits applies edits but still prompts for commands', () => {
  assert.equal(decide(MODES.ACCEPT_EDITS, ACTIONS.READ).prompt, false);
  assert.equal(decide(MODES.ACCEPT_EDITS, ACTIONS.EDIT).prompt, false);
  assert.equal(decide(MODES.ACCEPT_EDITS, ACTIONS.EXEC).prompt, true);
});

test('bypassPermissions prompts for nothing', () => {
  for (const action of [ACTIONS.READ, ACTIONS.EDIT, ACTIONS.EXEC]) {
    assert.equal(decide(MODES.BYPASS, action).prompt, false, action);
  }
});

test('plan mode reads freely and never mutates silently', () => {
  assert.equal(decide(MODES.PLAN, ACTIONS.READ).prompt, false);
  assert.equal(decide(MODES.PLAN, ACTIONS.EDIT).prompt, true);
  assert.equal(decide(MODES.PLAN, ACTIONS.EXEC).prompt, true);
});

test('bypassPermissions is downgraded for a bridge session', () => {
  const result = decide(MODES.BYPASS, ACTIONS.EDIT, { isBridge: true });
  assert.equal(result.effective, MODES.ACCEPT_EDITS);
  assert.equal(result.downgraded, true);
  // The downgraded mode still applies edits without a prompt, but a command
  // would now be prompted, which is the whole point of the downgrade.
  assert.equal(result.prompt, false);
  assert.equal(decide(MODES.BYPASS, ACTIONS.EXEC, { isBridge: true }).prompt, true);
});

test('an unknown mode is refused rather than assumed permissive', () => {
  assert.throws(() => assertMode('yolo'), /Unknown permission mode/);
  assert.throws(() => decide('yolo', ACTIONS.READ), /Unknown permission mode/);
  assert.equal(isAllowedWithoutPrompt(MODES.ACCEPT_EDITS, ACTIONS.EDIT), true);
});
