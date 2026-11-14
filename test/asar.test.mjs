// ASAR round-trip tests.
//
// The writer is hand-rolled, so the only meaningful check is that a real reader
// gets the same bytes back. Electron is not needed: readAsar parses the same
// header Electron does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const here = path.dirname(fileURLToPath(import.meta.url));
const { createAsar, readAsar, collectFiles, buildHeaderTree, align4 } =
  await import('../build/asar.cjs');

test('large-file ASAR integrity matches the Electron reference implementation', async () => {
  const { getFileIntegrity } = await import('../node_modules/@electron/asar/lib/integrity.js');
  for (const size of [0, 4 * 1024 * 1024, 4 * 1024 * 1024 + 17]) {
    await withRoot(async root => {
      const bytes = Buffer.alloc(size, 0x61);
      write(root, 'asset.wasm', bytes);
      const { header } = createAsar(root, ['asset.wasm']);
      const expected = await getFileIntegrity(Readable.from(bytes));
      assert.deepEqual(header.files['asset.wasm'].integrity, expected);
    });
  }
});

function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'asar-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

test('align4 pads to a four-byte boundary', () => {
  assert.equal(align4(0), 0);
  assert.equal(align4(1), 4);
  assert.equal(align4(4), 4);
  assert.equal(align4(5), 8);
});

test('collectFiles returns sorted forward-slash paths', () => withRoot(async root => {
  write(root, 'src/b.js', 'b');
  write(root, 'src/a.js', 'a');
  write(root, 'src/nested/c.js', 'c');
  const files = collectFiles(root, ['src']);
  assert.deepEqual(files, ['src/a.js', 'src/b.js', 'src/nested/c.js']);
}));

test('collectFiles honours exclusions', () => withRoot(async root => {
  write(root, 'src/keep.js', 'k');
  write(root, 'src/test/spec.js', 's');
  write(root, 'src/probe-thing.js', 'p');
  const files = collectFiles(root, ['src'], { exclude: ['src/test', 'src/probe-*'] });
  assert.deepEqual(files, ['src/keep.js']);
}));

test('collectFiles skips missing roots instead of throwing', () => withRoot(async root => {
  write(root, 'a.js', 'a');
  assert.deepEqual(collectFiles(root, ['a.js', 'nope']), ['a.js']);
}));

test('buildHeaderTree nests directories', () => {
  const tree = buildHeaderTree(['a.js', 'src/b.js']);
  assert.ok(tree.files['a.js']);
  assert.ok(tree.files.src.files['b.js']);
  assert.ok(!tree.files.src.size, 'a directory must not carry a size');
});

test('a written archive reads back with identical bytes', () => withRoot(async root => {
  const content = 'console.log("hello");\n'.repeat(50);
  write(root, 'app/main.js', content);
  write(root, 'app/data.json', JSON.stringify({ ok: true }));
  write(root, 'app/empty.txt', '');

  const rels = collectFiles(root, ['app']);
  const outFile = path.join(root, 'out.asar');
  const { fileCount, bytes } = createAsar(root, rels, { outFile });

  assert.equal(fileCount, 3);
  assert.ok(bytes.length > 0);
  assert.ok(readFileSync(outFile).length === bytes.length);

  const { files, header } = readAsar(outFile);
  assert.equal(files.size, 3);
  assert.equal(files.get('app/main.js').toString('utf8'), content);
  assert.equal(files.get('app/data.json').toString('utf8'), JSON.stringify({ ok: true }));
  assert.equal(files.get('app/empty.txt').length, 0);
  assert.ok(header.files.app.files['main.js'].integrity, 'each entry records an integrity block');
}));

test('entry offsets are contiguous and match the payload', () => withRoot(async root => {
  write(root, 'a.txt', 'AAAA');
  write(root, 'b.txt', 'BBBBBB');
  const rels = collectFiles(root, ['a.txt', 'b.txt']);
  const { header } = createAsar(root, rels);

  const a = header.files['a.txt'];
  const b = header.files['b.txt'];
  assert.equal(a.offset, '0');
  assert.equal(b.offset, '4', 'second entry starts where the first ended');
  assert.equal(a.size, 4);
  assert.equal(b.size, 6);
}));

test('an archive with an empty file list is still valid', () => withRoot(async root => {
  const outFile = path.join(root, 'empty.asar');
  const { fileCount } = createAsar(root, [], { outFile });
  assert.equal(fileCount, 0);
  const { files } = readAsar(outFile);
  assert.equal(files.size, 0);
}));

test('binary content survives the round trip', () => withRoot(async root => {
  const raw = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe]);
  const full = path.join(root, 'blob.bin');
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, raw);

  const outFile = path.join(root, 'bin.asar');
  createAsar(root, ['blob.bin'], { outFile });
  const { files } = readAsar(outFile);
  assert.deepEqual([...files.get('blob.bin')], [...raw]);
}));
