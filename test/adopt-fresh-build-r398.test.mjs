import crypto from 'node:crypto';
// R398: --adopt-from must work, and must REPLACE the bundle rather than merge into it.
//
// Two real defects were found and fixed in tools/setup-agent-core.cjs. Both are the kind that
// look fine and produce a wrong artifact:
//
//   1. adopt() hardcoded its bun source to %TEMP%\bun-prefix\node_modules\bun\bin\bun.exe, a
//      leftover from an `npm i bun` into TEMP. That directory no longer exists, so every
//      --adopt-from invocation threw "no bun.exe at ..." even though the repo ships a verified
//      agent-core/bun/bun.exe.
//
//   2. copyTree() only writes files, so adopting over an existing dist MERGED the trees.
//      Measured on the first run: fileCount 1479 -> 2405 and chunks 734 -> 1197, because the old
//      content-hash chunk names and the new ones both survived. The entry imports the new names
//      while stale duplicates of the same modules sit next to them, and the manifest then
//      digests that contaminated tree.
//
// This test reads the SCRIPT as text rather than running an adopt, because an adopt mutates the
// vendored tree: a test that performed one would be a destructive side effect inside `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tools', 'setup-agent-core.cjs');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

/**
 * Strip line comments conservatively.
 *
 * The first version counted quote characters on the line to decide whether a `//` opened a
 * comment, and discarded the WHOLE line when the count looked odd — which deleted real code such
 * as `for (const target of [BUNDLE, BUN_DIR]) fs.rmSync(...)` because the line contains an even
 * number of quotes only by accident of the surrounding text. Dropping lines wholesale made
 * assertions fail on a correct script.
 *
 * This removes only the comment TAIL, and leaves the line untouched when the `//` is preceded by
 * an odd number of quotes (i.e. it sits inside a string).
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      if (i < 0) return line;
      const before = line.slice(0, i);
      const quotes = (before.match(/['"`]/g) || []).length;
      return quotes % 2 === 0 ? before + line.slice(i).replace(/^\/\/.*$/, '') : line;
    })
    .join('\n');
}

/**
 * The body of a named function, by brace matching from the body's opening brace.
 *
 * `SRC.indexOf('{', at)` was wrong: the signature `function adopt(sourceRoot, options = {}) {`
 * contains `{` inside the default parameter, so the match landed there and the "body" was the
 * two characters `{}` — every assertion inside then looked absent. Anchor on the closing paren of
 * the parameter list instead.
 */
function fnBody(name, { code = true } = {}) {
  const at = SRC.indexOf('function ' + name + '(');
  assert.ok(at >= 0, 'no function ' + name);
  const paramsOpen = SRC.indexOf('(', at);
  let paren = 0;
  let paramsEnd = -1;
  for (let i = paramsOpen; i < SRC.length; i += 1) {
    if (SRC[i] === '(') paren += 1;
    else if (SRC[i] === ')') {
      paren -= 1;
      if (paren === 0) { paramsEnd = i; break; }
    }
  }
  assert.ok(paramsEnd > 0, 'unbalanced parameter list for ' + name);
  const open = SRC.indexOf('{', paramsEnd);
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = SRC.slice(open, i + 1);
        return code ? stripComments(body) : body;
      }
    }
  }
  return assert.fail('unbalanced function ' + name);
}

test('adopt() no longer depends on a %TEMP% bun install', () => {
  const body = fnBody('adopt');
  assert.ok(!body.includes('bun-prefix'),
    'adopt() is again reading bun from %TEMP%\\bun-prefix, which does not exist on this machine');
  assert.ok(body.includes('bunExe()'),
    'adopt() does not fall back to bunExe(), so it has no valid bun source');
});

test('adopt() resets the bundle tree unconditionally, not behind a flag', () => {
  // The merge bug: `if (options.force) rm -rf` meant a plain --adopt-from merged instead.
  // The statement removes `target` inside a loop over [BUNDLE, BUN_DIR]; the loop list is what
  // proves BUNDLE is covered. Asserting `fs.rmSync(BUNDLE` was wrong — that exact text never
  // exists, so the assertion failed on a correct script.
  const body = fnBody('adopt');
  const resetAt = body.indexOf('fs.rmSync(target');
  assert.ok(resetAt > 0, 'adopt() never removes the existing bundle');
  assert.ok(body.slice(Math.max(0, resetAt - 200), resetAt).includes('[BUNDLE, BUN_DIR]'),
    'the reset no longer covers BUNDLE, so a previous bundle would survive and merge');
  const guard = body.slice(Math.max(0, resetAt - 200), resetAt);
  assert.ok(!/options\.force/.test(guard),
    'the bundle reset is conditional again: merging two builds into one tree is never correct');
});

test('adopt() snapshots bun.exe before the reset can delete it', () => {
  // bunExe()'s normal fallback IS the reset target, so deleting first leaves nothing to copy.
  const body = fnBody('adopt');
  const readAt = body.indexOf('bunBytes = fs.readFileSync');
  const resetAt = body.indexOf('fs.rmSync(target');
  assert.ok(readAt > 0, 'adopt() does not snapshot bun.exe before the reset');
  assert.ok(readAt < resetAt,
    'bun.exe is read after the reset, so the source may already be gone');
  assert.ok(body.includes('fs.writeFileSync(targetBun, bunBytes)'),
    'the snapshotted bytes are never written back');
});

test('setupFromScratch() fetches the PIN, not upstream HEAD', () => {
  const body = fnBody('setupFromScratch');
  assert.ok(!body.includes("'clone'"),
    'setupFromScratch() clones again: `git clone --depth 1` takes HEAD, not the pinned commit');
  assert.ok(body.includes("'fetch', 'git', ['fetch', '--depth', '1', 'origin', COMMIT]"),
    'setupFromScratch() does not shallow-fetch the pinned commit');
  assert.ok(body.includes("'checkout', 'git', ['checkout', '--quiet', 'FETCH_HEAD']"),
    'setupFromScratch() does not check the fetched commit out');
});

test('a non-pinned source tree aborts the build instead of warning', () => {
  // A warning produced a manifest that faithfully described the WRONG kernel and still verified.
  const body = fnBody('setupFromScratch');
  const check = body.indexOf('actualCommit !== COMMIT');
  assert.ok(check > 0, 'the pin check is gone');
  assert.ok(body.slice(check, check + 400).includes('throw'),
    'drift only warns again: the build would produce a mislabeled manifest');
});

test('setupFromScratch() installs with --ignore-scripts', () => {
  // CCB's prepare is `husky` (unresolvable here) and postinstall runs setup-chrome-mcp.mjs
  // (MODULE_NOT_FOUND). Either failure rolls the WHOLE install back: node_modules keeps 3
  // entries and the build dies with a wall of "Could not resolve" — while the install still
  // reports a long elapsed time and multi-GB temp use, so it looks successful.
  const body = fnBody('setupFromScratch');
  assert.ok(body.includes("['install', '--ignore-scripts']"),
    'the install dropped --ignore-scripts: it will roll back and the build will fail');
});

test('the vendored tree is internally consistent after the adopt', () => {
  // Not a re-run of the adopt; just the invariant the fixes are supposed to preserve.
  const dist = path.join(ROOT, 'agent-core', 'claude-code', 'dist');
  const chunks = fs.readdirSync(dist).filter((n) => /^chunk-.*\.js$/.test(n));
  assert.ok(chunks.length > 500, 'unexpectedly few chunks');

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-core', 'manifest.json'), 'utf8'));
  assert.equal(manifest.bundle.fileCount, fs.readdirSync(dist, { recursive: true })
    .filter((n) => fs.statSync(path.join(dist, n)).isFile()).length,
    'the manifest fileCount does not match the tree on disk: an adopt merged or truncated it');
  const entrySha = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(dist, 'cli-bun.js'))).digest('hex');
  assert.equal(manifest.bundle.entrySha256, entrySha,
    'the entry sha256 does not match: the manifest describes a different tree');
});
