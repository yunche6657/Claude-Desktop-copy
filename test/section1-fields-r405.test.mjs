// R405: §1 field gaps closed — EnterWorktree.path, FileRead.allow_large, WebFetch.offset.
//
// WHY THIS ROUND IS DIFFERENT FROM R401/R402/R404
//   Those three blocked because the official semantics needed a mechanism CCB lacks (review-card
//   UI, MCP directory protocol, a /loop subsystem). These three need no new mechanism: they are
//   parameters on tools that already do the work. That is why they were picked.
//
// WHAT MAKES EACH ONE MORE THAN "ADD A FIELD"
//   A field that is declared but ignored is worse than a missing field: the schema claims support
//   the implementation does not have. So each assertion below checks the BEHAVIOUR, not just
//   the declaration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST, findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');

const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

function toolFactory(toolIdentifier, chunkText) {
  const at = chunkText.indexOf(toolIdentifier + ' = buildTool(');
  assert.ok(at > 0, 'tool not found in chunk: ' + toolIdentifier);
  const seg = chunkText.slice(at, at + 12000);
  const getter = /get inputSchema\(\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\(\)/.exec(seg);
  assert.ok(getter, 'no inputSchema getter for ' + toolIdentifier);
  return getter[1];
}

function schemaFields(chunkText, factoryName) {
  const at = chunkText.indexOf('var ' + factoryName + ' = lazySchema(');
  assert.ok(at > 0, 'schema factory not found: ' + factoryName);
  const seg = chunkText.slice(at, at + 6000);
  const open = seg.indexOf('{');
  let depth = 0;
  let end = -1;
  for (let k = open; k < seg.length; k += 1) {
    if (seg[k] === '{') depth += 1;
    else if (seg[k] === '}') { depth -= 1; if (depth === 0) { end = k; break; } }
  }
  const body = seg.slice(open, end + 1);
  const keys = [];
  let d = 0;
  for (const line of body.split('\n')) {
    if (d === 1) {
      const m = /^\s*([\w$]+)\??:/.exec(line);
      if (m) keys.push(m[1]);
    }
    d += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  return keys;
}

// ------------------------------------------------------------------ EnterWorktree.path
test('EnterWorktree declares path and rejects passing both fields', () => {
  const chunk = findChunk('EnterWorktreeTool = buildTool(').text;
  const fields = schemaFields(chunk, toolFactory('EnterWorktreeTool', chunk));
  assert.deepEqual(fields.sort(), ['name', 'path'],
    'EnterWorktree does not declare both name and path');

  const src = read('packages', 'builtin-tools', 'src', 'tools', 'EnterWorktreeTool', 'EnterWorktreeTool.ts');
  assert.match(src, /\.refine\(input => !\(input\.name && input\.path\)/,
    'the mutual-exclusion rule is gone: both fields would be accepted together');
  // Official: `path` must appear in `git worktree list`.
  assert.match(src, /getWorktreePaths\(/,
    'the tool no longer validates `path` against git worktree list');
});

test('EnterWorktree.path SWITCHES instead of creating, and does not create a worktree', () => {
  // The distinction matters: `name` calls createWorktreeForSession; `path` must return before it.
  const src = read('packages', 'builtin-tools', 'src', 'tools', 'EnterWorktreeTool', 'EnterWorktreeTool.ts');
  const pathBranch = src.indexOf('if (input.path) {');
  const createCall = src.indexOf('await createWorktreeForSession(');
  assert.ok(pathBranch > 0, 'there is no `path` branch');
  assert.ok(createCall > pathBranch,
    'the path branch runs after createWorktreeForSession, so it would create a worktree too');

  // An unknown path must fail loudly with the existing list, not silently do nothing.
  assert.match(src, /No worktree at "\$\{target\}"\. Existing worktrees:/,
    'an unknown path is no longer reported with the available worktrees');
});

// ------------------------------------------------------------------ FileRead.allow_large
test('FileRead declares allow_large and actually widens the size ceiling', () => {
  const chunk = findChunk('FileReadTool = buildTool(').text;
  const fields = schemaFields(chunk, toolFactory('FileReadTool', chunk));
  assert.ok(fields.includes('allow_large'), 'FileRead does not declare allow_large');

  const src = read('packages', 'builtin-tools', 'src', 'tools', 'FileReadTool', 'FileReadTool.ts');
  // A declared-but-unused flag is the failure mode this catches.
  assert.match(src, /allow_large = false/, 'allow_large is not destructured in call()');
  assert.match(src, /allow_large && isTextual \? baseMaxSizeBytes \* LARGE_READ_MULTIPLIER/,
    'allow_large does not change the size ceiling: it would be accepted and ignored');
  assert.match(src, /const LARGE_READ_MULTIPLIER = \d+/,
    'the multiplier is not a bounded constant');
});

test('allow_large applies to text only, leaving image/PDF limits alone', () => {
  // Official wording is "read a TEXT file, or a line range of one". Images and PDFs have their own
  // paths and must not be silently given a bigger byte budget.
  const src = read('packages', 'builtin-tools', 'src', 'tools', 'FileReadTool', 'FileReadTool.ts');
  assert.match(src, /isTextual/,
    'the text-only guard is gone, so allow_large would also widen binary reads');
  for (const ext of ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp']) {
    assert.ok(src.includes("'" + ext + "'"),
      'the non-text extension list no longer mentions ' + ext);
  }
});

// ------------------------------------------------------------------ WebFetch.offset
test('WebFetch declares offset and reports where it resumed', () => {
  const chunk = findChunk('WebFetchTool = buildTool(').text;
  const fields = schemaFields(chunk, toolFactory('WebFetchTool', chunk));
  assert.deepEqual(fields.sort(), ['offset', 'prompt', 'url'],
    'WebFetch input does not declare offset');

  const src = read('packages', 'builtin-tools', 'src', 'tools', 'WebFetchTool', 'WebFetchTool.ts');
  // Reporting the span is what lets a caller chain a second call; without it `offset` is a
  // write-only parameter.
  assert.match(src, /contentOffset/, 'WebFetch does not report contentOffset');
  assert.match(src, /contentLength/, 'WebFetch does not report contentLength');
});

test('offset is honoured on BOTH backends, not just one', () => {
  // The default backend is 'tavily'. Slicing only in the direct-HTTP branch would make the flag
  // silently do nothing for most users — the exact "declared but ignored" failure mode.
  const src = read('packages', 'builtin-tools', 'src', 'tools', 'WebFetchTool', 'WebFetchTool.ts');
  const slices = [...src.matchAll(/\.slice\((\w*[Oo]ffset)\)/g)].map((m) => m[1]);
  assert.ok(slices.length >= 2,
    'only one backend slices by offset (found ' + slices.length + '), so the other ignores it');
  assert.ok(src.includes('tavilySliced'),
    'the tavily branch has no sliced content');
  assert.match(src, /contentOffset: tavilyOffset/,
    'the tavily return does not report its own offset');
});

test('every WebFetch return path reports the span, so the output type stays honest', () => {
  const src = read('packages', 'builtin-tools', 'src', 'tools', 'WebFetchTool', 'WebFetchTool.ts');
  const returns = [...src.matchAll(/const output: Output = \{([\s\S]{0,600}?)\n\s{4,8}\}/g)];
  assert.ok(returns.length >= 4,
    'expected at least 4 return paths (redirect x2, tavily, direct HTTP), got ' + returns.length);
  // Accept the shorthand form (`contentOffset,` when the local has the same name) as well as
  // `contentOffset: ...`; both satisfy the declared type. Requiring the colon rejected valid code.
  for (const [, body] of returns) {
    assert.match(body, /contentOffset\s*[,:]/,
      'a return path omits contentOffset, so the declared output type would be violated');
    assert.match(body, /contentLength\s*[,:]/,
      'a return path omits contentLength');
  }
});

// ------------------------------------------------------------------ bundle
test('all three fields reached the adopted bundle', () => {
  const markers = [
    'Path to an existing worktree to switch into',
    'over the usual size limits',
    'Character position in the page text to start reading from',
  ];
  for (const marker of markers) {
    assert.doesNotThrow(() => findChunk(marker),
      'marker missing from the bundle: ' + JSON.stringify(marker));
  }
});
