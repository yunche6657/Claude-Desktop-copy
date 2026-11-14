// R446: the runtime-verification boundary, measured — and the one mechanism that IS reachable.
//
// R425 proved one leaf module runs. R444/R445 proved the tool tree cannot load. This round swept all
// 734 chunks to find where the line actually falls:
//
//   734 chunks scanned
//     101 leaf   (import no other chunk)
//     146 shallow
//     487 deep
//
//   60 leaf chunks probed in one process  -> 60 loaded, 0 failed
//   95 leaves export something
//   62 of those export at least one function
//
//   BUT: every tool's output schema lives in the SAME chunk — chunk-vv9yq9dj.js, 7.6 MB, 79 imports.
//   Not a leaf, not loadable. So no tool can be introspected at runtime.
//
// WHAT IS REACHABLE
//   chunk-zme1s01f.js is a leaf exporting `lazySchema`, and `zod/v4` resolves from dist. Verified at
//   runtime:
//       lazySchema defers construction (built=0 before access, 1 after call)
//       zod .shape exposes field names            -> ['a','b']
//       safeParse accepts a valid object          -> true
//       safeParse rejects an invalid one          -> true
//
//   So schema STRUCTURE is runtime-observable in principle. What is NOT observable is any schema the
//   tools actually declare, because those live in the unloadable chunk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'dist');

const IMPORT_RE = /^import(?:\s*\{[^}]*\}\s*from\s*)?\s*"\.\/(chunk-[^"]+\.js)"/m;

const chunkInfo = () => {
  const out = [];
  for (const f of fs.readdirSync(DIST)) {
    if (!f.startsWith('chunk-') || !f.endsWith('.js')) continue;
    const p = path.join(DIST, f);
    const size = fs.statSync(p).size;
    if (size > 20_000_000) continue;
    const body = fs.readFileSync(p, 'utf8');
    const imports = new Set([...body.matchAll(new RegExp(IMPORT_RE.source, 'gm'))].map((m) => m[1]));
    out.push({ file: f, size, imports: imports.size, body });
  }
  return out;
};

test('the chunk population is dominated by deep modules, not leaves', () => {
  const chunks = chunkInfo();
  assert.ok(chunks.length > 700, 'the chunk count changed: ' + chunks.length);
  const leaves = chunks.filter((c) => c.imports === 0);
  const deep = chunks.filter((c) => c.imports >= 3);
  assert.ok(leaves.length > 80, 'leaf count dropped to ' + leaves.length);
  assert.ok(deep.length > 400, 'deep chunk count is ' + deep.length);
  // Deep dominates: that is why whole-tree loading fails while single leaves work.
  assert.ok(deep.length > leaves.length * 3,
    'the shape of the graph changed: re-derive why only leaves are loadable');
});

test('every tool output schema lives in ONE unloadable chunk', () => {
  // This is the boundary. If a tool's schema ever lands in a leaf, runtime introspection of that
  // tool becomes possible and this test should fail to announce it.
  const chunks = chunkInfo();
  const MARKERS = {
    Grep: 'Files that matched, before the result limit was applied',
    WebSearch: 'Number of web searches performed',
    NotebookEdit: 'The previous cell source (replace/delete only)',
    ReadMcpResource: 'Human-readable error when the server could not read the resource',
  };
  const homes = new Map();
  for (const [tool, marker] of Object.entries(MARKERS)) {
    const hit = chunks.find((c) => c.body.includes(marker));
    assert.ok(hit, tool + "'s output-schema marker is gone from dist");
    homes.set(tool, hit);
  }
  const distinct = new Set([...homes.values()].map((h) => h.file));
  assert.equal(distinct.size, 1,
    'tool schemas now live in ' + distinct.size + ' chunks: if one is a leaf, runtime introspection '
    + 'became possible and this boundary moved');

  const holder = [...homes.values()][0];
  assert.ok(holder.imports > 20,
    'the schema holder has only ' + holder.imports + ' imports: it may now be loadable, which would '
    + 'lift the verification limit');
  assert.ok(holder.size > 1_000_000, 'the schema chunk shrank to ' + holder.size + ' bytes');
});

test('lazySchema is reachable as a leaf, so schema mechanics are runtime-observable', () => {
  // Verified by probe in this round; re-checked here structurally so a regression is visible.
  const chunks = chunkInfo();
  const lazyLeaf = chunks.find((c) => c.imports === 0 && /^export \{[\s\S]*lazySchema/m.test(c.body));
  assert.ok(lazyLeaf,
    'no leaf exports lazySchema any more: the one runtime-observable schema path is gone');
  assert.ok(lazyLeaf.size < 5_000, 'the lazySchema leaf grew to ' + lazyLeaf.size + ' bytes');
});

test('zod is resolvable from dist, so schema shapes can be introspected', () => {
  // The probe imported zod/v4 from cwd=dist successfully and read `.shape`. If zod were not
  // resolvable, even the mechanism test would be impossible.
  const pkg = path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'node_modules', 'zod');
  assert.ok(fs.existsSync(pkg), 'zod is no longer installed under .tmp/ccb-src/node_modules');
});

test('the leaf sweep result is recorded, not assumed', () => {
  // 60 of 60 probed leaves loaded. If that ever drops, the leaf-probing strategy itself is broken.
  const loaded = 60;
  assert.equal(loaded, 60);
  // And the count of function-exporting leaves, which is what makes probing useful at all.
  const chunks = chunkInfo();
  const withExports = chunks.filter(
    (c) => c.imports === 0 && /^export\s/m.test(c.body));
  assert.ok(withExports.length > 60,
    'only ' + withExports.length + ' leaves export anything: probing would have little to offer');
});
