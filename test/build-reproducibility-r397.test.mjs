// R397: a build from the pinned source reproduces the vendored bundle.
//
// This closes the last unknown blocking §1–§3 implementation: before this round nobody had
// verified that `bun install && bun run build` on the pinned commit produces something equivalent
// to the `agent-core/claude-code/dist` the replica actually runs, so any source edit would have
// been unverifiable.
//
// Measured facts (see evidence/build-reproducibility.md):
//   entry  cli-bun.js     sha256 identical to the vendored one: c9b9732e...
//   files  1479 in both builds, total bytes differ by 88
//   chunks 926 filenames differ, 0 share a name — the bundler names chunks by content hash
//   cli.js same byte length (11449), differs ONLY in which chunk filenames it imports
//   chunks after normalising `chunk-<hash>.js` to `chunk-XXX.js`, sampled pairs are IDENTICAL
//
// So the build is semantically reproducible but not byte-reproducible at the dist level. The
// distinction matters: byte-equality would be a much stronger claim than the evidence supports,
// and asserting it here would fail on a correct tree.
//
// THE BUILD OUTPUT IS NOT COMMITTED. This test reads a build directory outside the repo
// (.tmp/ccb-src/dist) and fails rather than skips when absent, because a skipped test would let
// the claim rot silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'dist');
const VEND = path.join(ROOT, 'agent-core', 'claude-code', 'dist');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function requireBuild() {
  assert.ok(fs.existsSync(BUILT),
    'no build at ' + BUILT + '. Reproduce with: git fetch --depth 1 origin '
    + '77a7934e15d69da13879112ed7db695c9ee7a52a, then bun install --ignore-scripts && bun run build. '
    + '(`bun install` without --ignore-scripts fails on the husky prepare hook.)');
}

test('the built entry point is byte-identical to the vendored one', () => {
  // The strongest reproducible fact available: the actual entry the app loads.
  requireBuild();
  const built = sha(fs.readFileSync(path.join(BUILT, 'cli-bun.js')));
  const vend = sha(fs.readFileSync(path.join(VEND, 'cli-bun.js')));
  assert.equal(built, vend,
    'the build from the pinned source no longer matches the vendored entry — either the pin '
    + 'moved, dependencies resolved differently, or the vendored dist was replaced');
  assert.equal(built, 'c9b9732e4da5ddc9c2f3ddbc7488868cbdbc162795a4ab425b8d3b8ea64f5c70',
    'the entry sha256 changed from the value recorded in agent-core/manifest.json');
});

test('both trees have the same file count', () => {
  requireBuild();
  const count = (dir) => {
    let n = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) n += count(p);
      else n += 1;
    }
    return n;
  };
  assert.equal(count(BUILT), count(VEND), 'the build produces a different number of files');
});

test('chunk names match exactly now that the fresh build has been adopted', () => {
  // HISTORY, because the meaning of this assertion changed:
  //
  // Before R398 adopted the fresh build, the vendored tree was a DIFFERENT build of the same
  // pinned source. Compared against that tree, 463 of 734 chunk names differed (content-hash
  // naming), and the claim was "semantically reproducible, not byte-reproducible at the dist
  // level" — chunks matched only after normalising `chunk-<hash>.js`.
  //
  // R398 then ran --adopt-from on the fresh build, so agent-core/claude-code/dist IS that build.
  // The two trees are now identical, and the honest assertion is exact name equality. Keeping
  // the old "many differ" assertion would have been false.
  //
  // The semantic-equivalence paragraph in evidence/build-reproducibility.md still stands as the
  // statement about two INDEPENDENT builds; it is not contradicted by this one.
  requireBuild();
  const chunks = (dir) => new Set(fs.readdirSync(dir).filter((n) => /^chunk-.*\.js$/.test(n)));
  const built = chunks(BUILT);
  const vend = chunks(VEND);
  assert.ok(built.size > 500, 'expected hundreds of chunks');
  assert.equal(built.size, vend.size, 'the two trees have different chunk counts');
  const onlyBuilt = [...built].filter((n) => !vend.has(n));
  assert.deepEqual(onlyBuilt, [],
    'the adopted tree is no longer the build at ' + BUILT + ': it was replaced or rebuilt');
});

test('cli.js differs only in which chunk filenames it imports', () => {
  // Same length, same structure, different names. This is the assertion that separates
  // "semantically identical" from "byte identical", which the evidence must not conflate.
  requireBuild();
  const built = fs.readFileSync(path.join(BUILT, 'cli.js'), 'utf8');
  const vend = fs.readFileSync(path.join(VEND, 'cli.js'), 'utf8');

  assert.equal(built.length, vend.length,
    'cli.js lengths now differ: the difference is no longer only filenames');

  const normalise = (s) => s.replace(/chunk-[a-z0-9]+\.js/g, 'chunk-XXX.js');
  assert.equal(normalise(built), normalise(vend),
    'cli.js differs beyond chunk filenames after normalisation — this is real drift');
});

test('the adopted tree matches the build byte for byte', () => {
  // Before R398 adopted the build, this compared two INDEPENDENT builds and had to normalise
  // chunk filenames: chunk-xedw8rgj.js (built) held the same module as chunk-mxz1j2zx.js
  // (vendored). Now the vendored tree IS the adopted build, so the stronger statement holds —
  // same names, same bytes — and a normalising comparison would hide a real divergence.
  //
  // The sample is taken FROM DISK rather than hardcoded. Hardcoding one chunk name meant this
  // test broke on the next legitimate rebuild (chunk-s9f2xf0k.js no longer exists), which is a
  // defect in the test, not in the tree. The whole-tree comparison lives in
  // evidence/adopt-fresh-build.md, where it found 0 differing files.
  requireBuild();
  const entries = fs.readdirSync(BUILT).filter((n) => n.endsWith('.js'));
  assert.ok(entries.length > 500, 'the build has unexpectedly few .js files');
  // Fixed names that must always exist, plus a few real chunks picked deterministically.
  const samples = ['cli.js', 'cli-bun.js',
    ...entries.filter((n) => n.startsWith('chunk-')).sort().slice(0, 3)];

  const missing = samples.filter((name) =>
    !fs.existsSync(path.join(BUILT, name)) || !fs.existsSync(path.join(VEND, name)));
  assert.deepEqual(missing, [],
    'sampled files are absent from one side, so nothing was compared');
  for (const name of samples) {
    assert.equal(sha(fs.readFileSync(path.join(BUILT, name))), sha(fs.readFileSync(path.join(VEND, name))),
      name + ' differs between the build and the adopted tree');
  }
});

test('the source tree is at the pinned commit', () => {
  requireBuild();
  const head = path.resolve(ROOT, '..', '.tmp', 'ccb-src', '.git', 'HEAD');
  assert.ok(fs.existsSync(head), 'the build directory has no .git, so the commit is unverifiable');
  const ref = fs.readFileSync(head, 'utf8').trim();

  // HEAD is either a detached 40-hex sha or `ref: <path>`. Rather than branch, resolve BOTH
  // shapes unconditionally and assert the resolved sha. A branch here would be a guard around an
  // assertion (test-hygiene forbids that: if the branch never fires, it still looks like a pass).
  const detached = /^[0-9a-f]{40}$/.test(ref) ? ref : '';
  const symbolicPath = ref.startsWith('ref: ')
    ? path.resolve(ROOT, '..', '.tmp', 'ccb-src', '.git', ref.slice('ref: '.length))
    : '';
  const symbolic = symbolicPath && fs.existsSync(symbolicPath)
    ? fs.readFileSync(symbolicPath, 'utf8').trim()
    : '';

  assert.equal(detached || symbolic, '77a7934e15d69da13879112ed7db695c9ee7a52a',
    'the source tree drifted from the pin (or HEAD is in neither expected shape: '
    + JSON.stringify(ref) + '), so the build proves nothing about the pinned commit');
});
