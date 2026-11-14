// Workspace tree tests.
//
// The tree decides what the user sees and what the file tools can reach, so the
// assertions cover the ignore semantics (.ignore always, .gitignore opt-out),
// the always-skipped directories, symlink non-traversal and the entry cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const { listTree, listDirectory, compileRule, globToRegExp, ALWAYS_SKIP } =
  await import('../desktop/workspace-tree.cjs');

function makeTree(root, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    if (content === null) { mkdirSync(full, { recursive: true }); continue; }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'tree-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('globToRegExp supports *, ? and **', () => {
  assert.ok(globToRegExp('*.log').test('a.log'));
  assert.ok(!globToRegExp('*.log').test('a.log.bak'));
  assert.ok(globToRegExp('a?c').test('abc'));
  assert.ok(!globToRegExp('a?c').test('a/c'));
  assert.ok(globToRegExp('**/x.js').test('deep/nested/x.js'));
  assert.ok(globToRegExp('src/**').test('src/a/b'));
  assert.ok(globToRegExp('.env').test('.env'));
});

test('compileRule ignores blanks, comments and negation', () => {
  assert.equal(compileRule(''), null);
  assert.equal(compileRule('   '), null);
  assert.equal(compileRule('# comment'), null);
  // Negation is not supported; returning null prevents a wrong exclusion.
  assert.equal(compileRule('!keep.txt'), null);
});

test('a basename rule matches at any depth, an anchored one does not', () => {
  const basename = compileRule('*.log');
  assert.ok(basename('a.log', false));
  assert.ok(basename('deep/b.log', false));

  const anchored = compileRule('/build.txt');
  assert.ok(anchored('build.txt', false));
  assert.ok(!anchored('deep/build.txt', false));
});

test('a directory-only rule does not exclude same-named files', () => {
  const rule = compileRule('logs/');
  assert.ok(rule('logs', true), 'directory must match');
  assert.ok(!rule('logs', false), 'a file named logs must not match');
});

test('the tree lists files and directories with directories first', () => withRoot(async root => {
  makeTree(root, {
    'src/a.js': 'a',
    'src/b.js': 'b',
    'src/nested/c.js': 'c',
    'README.md': 'r',
  });
  const { entries, truncated } = listTree(root);
  assert.equal(truncated, false);

  const names = entries.map(entry => entry.path);
  assert.ok(names.includes('src'));
  assert.ok(names.includes('src/a.js'));
  assert.ok(names.includes('src/nested/c.js'));
  assert.ok(names.includes('README.md'));

  // Top level: the directory sorts before the file.
  assert.equal(entries[0].path, 'src');
  assert.equal(entries[0].type, 'directory');
  assert.equal(entries.find(entry => entry.path === 'README.md').type, 'file');
}));

test('always-skipped directories never appear', () => withRoot(async root => {
  makeTree(root, {
    'node_modules/pkg/index.js': 'x',
    'dist/out.js': 'x',
    '.git/config': 'x',
    'keep.js': 'k',
  });
  const { entries } = listTree(root);
  const paths = entries.map(entry => entry.path);
  for (const skip of ['node_modules', 'dist', '.git']) {
    assert.ok(!paths.some(p => p === skip || p.startsWith(skip + '/')), `${skip} leaked`);
  }
  assert.ok(paths.includes('keep.js'));
  assert.ok(ALWAYS_SKIP.has('node_modules'));
}));

test('.ignore is always respected, .gitignore is opt-out', () => withRoot(async root => {
  makeTree(root, {
    '.ignore': 'secret.txt\n',
    '.gitignore': 'ignored.txt\n',
    'secret.txt': 's',
    'ignored.txt': 'i',
    'keep.txt': 'k',
  });

  const respecting = listTree(root, { respectGitignore: true });
  assert.ok(!respecting.entries.some(entry => entry.path === 'secret.txt'), '.ignore must always apply');
  assert.ok(!respecting.entries.some(entry => entry.path === 'ignored.txt'), '.gitignore applies by default');
  assert.ok(respecting.entries.some(entry => entry.path === 'keep.txt'));

  const notRespecting = listTree(root, { respectGitignore: false });
  assert.ok(!notRespecting.entries.some(entry => entry.path === 'secret.txt'), '.ignore still applies');
  assert.ok(notRespecting.entries.some(entry => entry.path === 'ignored.txt'), '.gitignore is now opt-out');
}));

test('symlinks are listed but never traversed', () => withRoot(async root => {
  const outside = mkdtempSync(path.join(tmpdir(), 'tree-out-'));
  try {
    writeFileSync(path.join(outside, 'hidden.js'), 'h');
    makeTree(root, { 'real/a.js': 'a' });
    try {
      symlinkSync(outside, path.join(root, 'link'), 'junction');
    } catch {
      return; // creating a symlink may require privileges; skip quietly
    }
    const { entries } = listTree(root);
    const link = entries.find(entry => entry.path === 'link');
    assert.ok(link, 'the symlink itself is listed');
    assert.equal(link.symlink, true);
    assert.ok(!entries.some(entry => entry.path.startsWith('link/')), 'a symlink must not be walked');
  } finally { rmSync(outside, { recursive: true, force: true }); }
}));

test('the entry cap truncates instead of walking forever', () => withRoot(async root => {
  for (let i = 0; i < 40; i++) writeFileSync(path.join(root, `f${i}.txt`), 'x');
  const { entries, truncated } = listTree(root, { maxEntries: 10 });
  assert.equal(truncated, true);
  assert.equal(entries.length, 10);
}));

test('a depth-limited branch does not suppress later siblings or root files', () => withRoot(async root => {
  makeTree(root, {
    'a/deep/hidden.txt': 'hidden',
    'b/visible.txt': 'visible',
    'root.txt': 'root',
  });
  const result = listTree(root, { maxDepth: 1 });
  assert.equal(result.truncated, true);
  const paths = result.entries.map(entry => entry.path);
  assert.ok(paths.includes('a/deep'));
  assert.ok(!paths.includes('a/deep/hidden.txt'));
  assert.ok(paths.includes('b/visible.txt'), 'later shallow branch was lost');
  assert.ok(paths.includes('root.txt'), 'root file was lost');
}));

test('a non-directory or missing root is refused', () => withRoot(async root => {
  assert.throws(() => listTree(path.join(root, 'nope')), /does not exist/);
  writeFileSync(path.join(root, 'file.txt'), 'x');
  assert.throws(() => listTree(path.join(root, 'file.txt')), /not a directory/);
}));

test('listDirectory reads one level and refuses escape', () => withRoot(async root => {
  makeTree(root, { 'a/x.js': 'x', 'b.js': 'b' });
  const top = listDirectory(root, '');
  assert.deepEqual(top.map(entry => entry.name), ['a', 'b.js']);
  assert.equal(top[0].type, 'directory');

  const inside = listDirectory(root, 'a');
  assert.deepEqual(inside.map(entry => entry.name), ['x.js']);

  assert.throws(() => listDirectory(root, '..'), /escapes the workspace/);
  assert.throws(() => listDirectory(root, 'missing'), /does not exist/);
}));
