// R426: why GrepTool cannot be called directly in this build — and the boundary of what is proven.
//
// THE ATTEMPT
//   R425 proved ripGrep's `onTimeout` fires on a real timeout. The remaining gap was the layer
//   above: does GrepTool's returned `{ data }` actually contain `timedOut: true`? The obvious way
//   to close it is to import the tool and call it:
//
//       import { GrepTool } from './chunk-3n8nsksv.js'
//       await GrepTool.call({ pattern, path, output_mode }, { abortController, getAppState })
//
//   That does not work in this build, for a reason that is a property of the bundle rather than of
//   the test:
//
//       TypeError: require() async module "chunk-ysa5q71m.js" is unsupported.
//       at dist/chunk-3n8nsksv.js  (src/tasks.ts:10)
//         var LocalWorkflowTask = import.meta.require("./chunk-ysa5q71m.js").LocalWorkflowTask
//
//   `import.meta.require` is the bundler's CommonJS escape hatch. Under Bun it throws when the
//   target is an async module. A static import fails, `await import()` fails identically, and the
//   failure is inside the module graph — not in how the probe imports it.
//
// WHAT THIS FILE PINS
//   1. The bundler still uses `import.meta.require` for that chunk, so the limitation is still real
//      rather than a stale note.
//   2. The CLI still starts, which is what makes the limitation non-obvious: the same chunk loads
//      fine on the CLI's own path.
//   3. The boundary of the R425 conclusion — ripGrep is verified, GrepTool's output is not.
//
//   Keeping this as a test means the next round does not re-attempt the same import and does not
//   claim more than was proven.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'agent-core', 'claude-code', 'dist');
const BUN = path.join(ROOT, 'agent-core', 'bun', 'bun.exe');

/** The chunk that exports GrepTool, discovered because filenames are content hashes. */
function grepChunk() {
  for (const name of fs.readdirSync(DIST)) {
    if (!name.endsWith('.js')) continue;
    const p = path.join(DIST, name);
    if (fs.statSync(p).size > 20_000_000) continue;
    if (/export\s*\{[^}]*\bGrepTool\b/.test(fs.readFileSync(p, 'utf8'))) return name;
  }
  return null;
}

test('the bundler still needs import.meta.require, so the import limitation is real', () => {
  const chunk = grepChunk();
  assert.ok(chunk, 'no chunk exports GrepTool: the dist layout changed');

  const src = fs.readFileSync(path.join(DIST, chunk), 'utf8');
  assert.match(src, /import\.meta\.require\("/,
    'import.meta.require is gone from the GrepTool chunk: a direct import may now work, and the '
    + 'end-to-end proof R426 could not do should be attempted again');

  // The specific call that throws. If the target chunk name changes, this test must be updated
  // rather than silently passing.
  const m = /import\.meta\.require\("\.\/(chunk-[\w]+\.js)"\)\.LocalWorkflowTask/.exec(src);
  assert.ok(m, 'the LocalWorkflowTask require site moved: re-check whether it still throws');
  const target = path.join(DIST, m[1]);
  assert.ok(fs.existsSync(target),
    'the require target ' + m[1] + ' no longer exists: re-check whether the throw still happens');
});

test('importing the tool directly fails inside the module graph, not in the probe', () => {
  const chunk = grepChunk();
  assert.ok(chunk, 'GrepTool chunk missing');

  const probe = path.join(DIST, 'probe-r426-boundary.mjs');
  fs.writeFileSync(probe, [
    "try {",
    "  const m = await import('./" + chunk + "')",
    "  console.log(JSON.stringify({ ok: true, type: typeof m.GrepTool }))",
    '} catch (e) {',
    "  console.log(JSON.stringify({ ok: false, message: String(e?.message).slice(0, 180) }))",
    '}',
  ].join('\n'));

  try {
    const r = spawnSync(BUN, [probe], { cwd: DIST, encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '').trim();
    assert.ok(out, 'probe produced no output: ' + (r.stderr || '').slice(-300));
    const parsed = JSON.parse(out);

    // If this ever becomes `ok: true`, the end-to-end test from R426 is now possible and this
    // assertion should be replaced with a real one.
    assert.equal(parsed.ok, false,
      'GrepTool imported successfully: the require() limitation is gone, so the end-to-end '
      + 'timedOut proof should now be written');
    assert.match(parsed.message, /require\(\) async module/,
      'the import failed for a different reason than the known bundler limitation: ' + parsed.message);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test('the CLI still starts, which is why the limitation is easy to miss', () => {
  // The same chunk participates in a successful CLI start. Anyone reasoning "the CLI works, so the
  // chunk loads" would be wrong about the direct-import path.
  const r = spawnSync(BUN, [path.join(DIST, 'cli-bun.js'), '--version'],
    { cwd: DIST, encoding: 'utf8', timeout: 120000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  assert.match(out, /\d+\.\d+\.\d+/,
    'the CLI no longer reports a version; re-derive whether the chunk still loads on its path');
});

test('the R425 conclusion stays scoped to ripGrep, not GrepTool', () => {
  // The boundary matters: the live test proves the callback fires, and nothing more. Asserting it
  // here keeps a later round from reading that evidence as "the tool reports timedOut".
  const liveTest = path.join(ROOT, 'test', 'grep-timedout-live-r425.test.mjs');
  assert.ok(fs.existsSync(liveTest), 'the R425 live test is gone');
  const t = fs.readFileSync(liveTest, 'utf8');

  // It must still drive ripGrep directly...
  assert.match(t, /ripGrep\(/, 'the live test no longer calls ripGrep');
  // ...and must not claim to test the tool.
  assert.ok(!/\bGrepTool\.call\(/.test(t),
    'the live test now calls GrepTool: if that works, R426\'s boundary note is obsolete');
});
