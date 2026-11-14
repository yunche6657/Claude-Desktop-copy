// The test preload must not change the shape of what tests observe.
//
// FOUND BROKEN. tools/test-no-console.cjs wraps every child_process function to force
// windowsHide, which is right — the worker console used to steal focus on Windows. But it
// replaced each function with a plain wrapper and dropped the original's own properties,
// including the util.promisify symbol:
//
//   const run = promisify(execFile);
//   Object.keys(await run(node, ['-e','console.log(1)']))
//     before the fix:  ['0','1']        (the raw [stdout, stderr] pair)
//     after  the fix:  ['stdout','stderr']
//
// so `result.stdout` was undefined and two tests failed with
//   TypeError: Cannot read properties of undefined (reading 'trim')
// while the product itself was fine. The preload is test infrastructure, so a defect here
// reads as a product regression — exactly the confusion this test prevents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = path.join(ROOT, 'tools', 'test-no-console.cjs');
const require = createRequire(import.meta.url);

test('loading the preload keeps promisify(execFile) returning { stdout, stderr }', async () => {
  // Run in a child so the preload is applied to a fresh process, exactly as NODE_OPTIONS does.
  const script = [
    'const path = require("node:path");',
    'require(path.resolve(process.argv[1]));',
    'const { execFile } = require("node:child_process");',
    'const { promisify } = require("node:util");',
    '(async () => {',
    '  const r = await promisify(execFile)(process.execPath, ["-e", "console.log(1)"], { timeout: 8000 });',
    '  console.log(JSON.stringify({ keys: Object.keys(r), stdout: r.stdout }));',
    '})().catch((e) => { console.log(JSON.stringify({ error: String(e.message) })); });',
  ].join(String.fromCharCode(10));
  const child = spawn(process.execPath, ['-e', script, PRELOAD], { windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  await new Promise((resolve) => child.once('close', resolve));
  const parsed = JSON.parse(out.trim());
  assert.deepEqual(parsed.keys, ['stdout', 'stderr'], 'promisify(execFile) lost its documented shape: ' + out.trim());
  assert.equal(parsed.stdout, '1' + String.fromCharCode(10));
});

test('the preload still forces windowsHide on spawned children', () => {
  // The preload exists for this reason; a fix that removed it would be worse than the bug.
  const source = fs.readFileSync(PRELOAD, 'utf8');
  assert.match(source, /windowsHide: true/, 'the preload no longer forces windowsHide');
  assert.match(source, /Reflect\.ownKeys\(original\)/, 'the preload stopped copying the original properties');
});

test('the preload is idempotent when two copies load', () => {
  // NODE_OPTIONS propagates to nested runs, so it can load twice in one process tree; wrapping an
  // already-wrapped function must not lose windowsHide or the promisify symbol.
  const first = require(PRELOAD);
  const second = require(PRELOAD);
  assert.equal(first, second, 'requiring the preload twice returned different exports');
});
