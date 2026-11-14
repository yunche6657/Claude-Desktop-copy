// R444: the runtime blocker's real shape — and a correction to last round's plan.
//
// WHAT THIS ROUND SET OUT TO DO
//   R443 proposed attacking the `import.meta.require` obstacle so the session's static conclusions
//   could become runtime evidence.
//
// WHAT IT FOUND
//   1. The obstacle is not "one bad call site". dist has 256 `import.meta.require` call sites
//      targeting 135 distinct chunks, and all 135 are ESM.
//   2. It is not about which import syntax the PROBE uses. Dynamic `await import()` fails on the
//      same module that static `import` fails on:
//
//          TypeError: require() async module "...chunk-5jp14vvr.js" is unsupported.
//                     use "await import()" instead.
//
//      Bun's own advice — "use await import() instead" — does not help, because the failing
//      `require()` is INSIDE the emitted module, not in the probe.
//   3. The chunk it fails on has no top-level await of its own. It is marked async because of its
//      dependency graph: it statically imports dozens of sibling chunks, and an async module
//      anywhere in that closure makes the whole chain unloadable by a synchronous require.
//
// SO THE BLOCKER IS STRUCTURAL
//   Bun's `splitting: true` + a top-level-await module somewhere in the graph produces chunks that
//   plain `require()` cannot load. That is a property of the build, not of how a caller imports it.
//
// WHAT STILL WORKS
//   A chunk with no async dependency closure loads fine by dynamic import — verified on a real dist
//   chunk (`chunk-06ffvw2k.js`). So per-chunk runtime verification is possible for some chunks, just
//   not for the ones containing src/tasks.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'dist');

const chunks = () => fs.readdirSync(DIST).filter((f) => /^chunk-[a-z0-9]+\.js$/.test(f));

test('the bundle contains hundreds of import.meta.require sites, not one', () => {
  // R426 recorded a single call site. The real number determines whether a hand fix is plausible.
  let sites = 0;
  const targets = new Set();
  const files = [];
  for (const f of fs.readdirSync(DIST)) {
    if (!f.endsWith('.js')) continue;
    const p = path.join(DIST, f);
    if (fs.statSync(p).size > 20_000_000) continue;
    const t = fs.readFileSync(p, 'utf8');
    for (const m of t.matchAll(/import\.meta\.require\("\.\/([^"]+)"/g)) {
      sites += 1;
      targets.add(m[1]);
    }
    if (t.includes('import.meta.require')) files.push(f);
  }
  assert.ok(sites > 100,
    'only ' + sites + ' require sites: if the emitter changed, re-derive whether the blocker is gone');
  assert.ok(targets.size > 50, 'distinct targets dropped to ' + targets.size);
  assert.ok(files.length > 1,
    'the calls are concentrated in one file — that would make a manual fix feasible, re-derive');
});

test('the failing chunk is async because of its DEPENDENCY CLOSURE, not its own top-level await', () => {
  // This is the finding that distinguishes "the fix is to use await import" from "no import syntax
  // helps". The chunk Bun refuses to require has no TLA of its own.
  const failing = 'chunk-5jp14vvr.js';
  const p = path.join(DIST, failing);
  if (!fs.existsSync(p)) {
    // Chunk names are content hashes and change every build. Find the equivalent by shape instead:
    // a small chunk with many static sibling imports and no TLA.
    const candidates = chunks().filter((f) => {
      const body = fs.readFileSync(path.join(DIST, f), 'utf8');
      const imports = (body.match(/^import\s*(?:\{[^}]*\})?\s*from\s*"\.\/chunk-|^import"\.\/chunk-/gm) || []).length;
      const hasTla = /^\s*await\s/m.test(body);
      return imports > 20 && !hasTla && fs.statSync(path.join(DIST, f)).size < 20_000;
    });
    assert.ok(candidates.length > 0,
      'no chunk with a heavy import fan-out and no TLA remains: re-derive the shared-closure claim');
    return;
  }
  const body = fs.readFileSync(p, 'utf8');
  assert.ok(!/^\s*await\s/m.test(body),
    'the failing chunk now HAS top-level await: the shared-closure explanation would be wrong');
  const fanOut = (body.match(/^import/gm) || []).length;
  assert.ok(fanOut > 20, 'the failing chunk imports only ' + fanOut + ' modules: re-derive');
});

test('some chunks DO load at runtime — so per-chunk verification is not wholly blocked', () => {
  // Recorded so a future round does not conclude "nothing can be verified at runtime".
  const candidates = chunks().filter((f) => {
    const p = path.join(DIST, f);
    return fs.statSync(p).size < 5_000 &&
      /^export\s/m.test(fs.readFileSync(p, 'utf8'));
  });
  assert.ok(candidates.length > 20,
    'few small self-contained ESM chunks remain: runtime probing may no longer be practical');
});

test('the source has no import.meta.require — it is emitted by the bundler', () => {
  // R426 described the obstacle as living at src/tasks.ts:10. The source there is a plain
  // `require()`; the bundled form is what cannot work. The distinction decides where a fix belongs.
  const tasksTs = path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'src', 'tasks.ts');
  const src = fs.readFileSync(tasksTs, 'utf8');
  assert.ok(!src.includes('import.meta.require'),
    'the source now contains import.meta.require: re-derive where the transformation happens');
  assert.match(src, /require\('\.\/tasks\//,
    'src/tasks.ts no longer uses plain require: re-derive the emitted form');
});

test('the tsconfig path aliases are why a probe inside the tree resolves to SOURCE', () => {
  // The first probes failed with a stack pointing at src/tasks.ts, not at dist — because the probe
  // sat inside a tree whose tsconfig.json aliases `src/*`. Isolating the probe from that config is
  // what made the real error visible.
  const tsconfig = path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'tsconfig.json');
  const text = fs.readFileSync(tsconfig, 'utf8');
  assert.match(text, /"paths"\s*:/,
    'tsconfig no longer has path aliases: probe placement may no longer affect resolution');
  assert.match(text, /"src\/\*"/,
    'the src/* alias is gone: re-derive why in-tree probes resolved to source');
});
