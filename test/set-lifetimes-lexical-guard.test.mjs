'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { declaredSets, addKey } = require('../tools/set-lifetimes.cjs');

test('a comment cannot invent a declaration, or hide a live set with fake clear', () => {
  const src = [
    '// const phantom = new Set(); phantom.has(1); phantom.add(1);',
    'const live = new Set();',
    'live.has("a"); live.add("a");',
    '// live.clear();',
    '/* live.delete("a"); */',
  ].join('\n');
  const sets = declaredSets(src);
  assert.deepEqual(sets.map((row) => row.name), ['live']);
  assert.deepEqual({ has: sets[0].has, add: sets[0].add, clear: sets[0].clear, delete: sets[0].delete },
    { has: 1, add: 1, clear: 0, delete: 0 });
});

test('string literals and template-literal prose do not become code', () => {
  const src = [
    'const real = new Set();',
    'const prose = "const imaginary = new Set(); imaginary.has(1); imaginary.add(1)";',
    'const tpl = `real.clear() and const pretend = new Set()`;',
    'real.has("x"); real.add("x");',
  ].join('\n');
  const sets = declaredSets(src);
  assert.deepEqual(sets.map((row) => row.name), ['real']);
  assert.equal(sets[0].clear, 0);
});

test('the reported key comes from the first executable add, not a comment', () => {
  const src = [
    'const current = new Set();',
    '// current.add("FAKE_KEY");',
    'current.has("a");',
    'current.add(`user:${id}`);',
  ].join('\n');
  assert.equal(addKey(src, 'current'), '`user:${id}`');
  assert.equal(addKey(src, 'unknown'), null);
});

test('multiple declarations in one statement are still visible', () => {
  const src = [
    'const first = new Set(), second = new Set();',
    'first.has(1); first.add(1);',
    'second.has(1); second.add(1);',
  ].join('\n');
  assert.deepEqual(declaredSets(src).map((row) => row.name), ['first', 'second']);
});

test('genuine deletions and clears still exclude their sets', () => {
  const src = [
    'const a = new Set(), b = new Set();',
    'a.has(1); a.add(1); a.clear();',
    'b.has(2); b.add(2); b.delete(2);',
  ].join('\n');
  const rows = declaredSets(src);
  assert.equal(rows.find((r) => r.name === 'a').clear, 1);
  assert.equal(rows.find((r) => r.name === 'b').delete, 1);
});

test('postfix increment followed by division does not hide a real clear', () => {
  const src = [
    'const s = new Set();',
    'let n = 1;',
    's.has(1); s.add(1);',
    'n++ / s.clear();',
  ].join('\n');
  const row = declaredSets(src).find((r) => r.name === 's');
  assert.equal(row.clear, 1, 'the division slash must not swallow the following call');
});

test('JavaScript line terminators end line comments before a real clear', () => {
  for (const terminator of ['\r', '\u2028', '\u2029']) {
    const src = [
      'const s = new Set();',
      's.has(1); s.add(1);',
      '// ignored comment' + terminator + 's.clear();',
    ].join('\n');
    const row = declaredSets(src).find((r) => r.name === 's');
    assert.equal(row.clear, 1, 'real clear hidden after U+' + terminator.codePointAt(0).toString(16));
  }
});

test('a regex literal after return cannot impersonate an add call', () => {
  const src = [
    'const s = new Set();',
    'function f() { return /[s.add(]/; }',
    's.has(1); s.add(42);',
  ].join('\n');
  const row = declaredSets(src).find((r) => r.name === 's');
  assert.equal(row.add, 1, 'regex literal was counted as an add');
  assert.equal(addKey(src, 's'), '42');
});

test('declaration coordinates count JavaScript line terminators', () => {
  for (const separator of ['\r', '\u2028', '\u2029', '\r\n']) {
    const src = 'const first = new Set();' + separator + 'const second = new Set();';
    const rows = declaredSets(src);
    assert.equal(rows[1].declaredAt, 2,
      'second declaration should be on line 2 after ' + JSON.stringify(separator));
  }
});

test('live project scan stays internally consistent without pinning a changing population', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'set-lifetimes.cjs'), '--json'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(0, 400));
  const data = JSON.parse(r.stdout);
  assert.equal(data.rows.length, data.sets);
  assert.ok(data.sets > 10, 'the scanner unexpectedly lost most candidates');
  for (const row of data.rows) {
    assert.ok(row.has > 0 && row.add > 0, row.name);
    assert.equal(row.delete, 0, row.name);
    assert.equal(row.clear, 0, row.name);
  }
});
