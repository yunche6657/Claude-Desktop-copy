// Tool descriptions are part of the product, not documentation.
//
// Measured over rounds 174-176: asked to count test/*.test.mjs with no tool named, the model
// reached for `ls -1 | wc -l` (refused: pipe), then `find` (a different program on Windows,
// silent exit 2), and retried both indefinitely — each attempt costing an approval prompt.
// Told to use Glob it answered correctly in one call.
//
// This round the descriptions were rewritten to say which tool to use and what the others
// cannot do. Measured effect, first try, nothing named in the prompt:
//
//   prompt: 'How many *.test.mjs files are in the test directory?'
//   result: 0 approval cards, answer 169
//   ground truth: 169
//
// So these assertions guard the guidance text, which is now load-bearing behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));

const tools = () => Object.fromEntries(
  defineTools({ workspaceRoot: ROOT, allowedRoots: [ROOT], execRoots: [ROOT] }).map((t) => [t.name, t]),
);

test('Glob says it is the tool for finding and counting files', () => {
  // Without this line the model has no reason to prefer Glob over the shell habit.
  const glob = tools().Glob;
  assert.match(glob.description, /COUNT/i, 'Glob does not advertise counting');
  assert.match(glob.description, /one path per line/i, 'the counting basis is not explained');
});

test('Glob points away from ls/find/wc and gives the reason', () => {
  const glob = tools().Glob;
  assert.match(glob.description, /ls|find|wc/i, 'the alternatives are not mentioned');
  assert.match(glob.description, /approval|Windows/i, 'no reason is given for preferring Glob');
});

test('Bash states its limitations up front', () => {
  // The caller otherwise discovers them one approval prompt at a time.
  const bash = tools().Bash;
  assert.match(bash.description, /no shell/i, 'the absence of a shell is not stated');
  assert.match(bash.description, /pipe|\|/, 'pipes are not called out');
  assert.match(bash.description, /allowlist/i, 'the allowlist is not mentioned');
});

test('List and Glob describe different jobs instead of overlapping', () => {
  const t = tools();
  assert.match(t.List.description, /Glob/i, 'List does not say when to use Glob instead');
  assert.match(t.List.description, /directly inside|one directory/i, 'List does not scope itself');
});

test('every tool description is non-trivial', () => {
  // A one-line description is how the guidance silently disappears in a later edit.
  for (const [name, tool] of Object.entries(tools())) {
    assert.ok(tool.description.length >= 60, name + ' has a stub description: ' + tool.description);
  }
});
