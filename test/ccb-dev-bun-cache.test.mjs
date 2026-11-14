import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { prepareDevBun } = require('../desktop/ccb-dev-bun-cache.cjs');
const { createCcbKernel } = require('../desktop/ccb-kernel.cjs');
const sha = b => createHash('sha256').update(b).digest('hex');
const exec = promisify(execFile);

test('verified cache, tamper repair, manifest and source mismatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-cache-test-'));
  try {
    const base = path.join(root, 'agent-core'); fs.mkdirSync(path.join(base, 'bun'), { recursive: true });
    const source = path.join(base, 'bun', 'bun.exe'); const bytes = Buffer.from('fixture-bun');
    fs.writeFileSync(source, bytes); fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify({ bun: { sha256: sha(bytes) } }));
    const cache = path.join(root, 'cache');
    const first = prepareDevBun(source, root, cache);
    assert.equal(sha(fs.readFileSync(first)), sha(bytes));
    assert.equal(prepareDevBun(source, root, cache), first);
    fs.writeFileSync(first, 'bad');
    const repaired = prepareDevBun(source, root, cache);
    assert.notEqual(repaired, first); assert.equal(sha(fs.readFileSync(repaired)), sha(bytes));
    fs.writeFileSync(source, 'changed');
    assert.throws(() => prepareDevBun(source, root, cache), /does not match manifest/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('concurrent writers publish only verified complete executables', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-cache-race-'));
  try {
    const base = path.join(root, 'agent-core'); fs.mkdirSync(path.join(base, 'bun'), { recursive: true });
    const source = path.join(base, 'bun', 'bun.exe'); const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    fs.writeFileSync(source, bytes); fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify({ bun: { sha256: sha(bytes) } }));
    const helper = require.resolve('../desktop/ccb-dev-bun-cache.cjs'); const cache = path.join(root, 'cache');
    const script = 'process.stdout.write(require(process.argv[1]).prepareDevBun(process.argv[2],process.argv[3],process.argv[4]))';
    const results = await Promise.all(Array.from({ length: 4 }, () => exec(process.execPath, ['-e', script, helper, source, root, cache], { windowsHide: true })));
    for (const result of results) assert.equal(sha(fs.readFileSync(result.stdout)), sha(bytes));
    assert.ok(fs.readdirSync(path.join(cache, sha(bytes))).every(x => x.endsWith('.exe')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('overrides, packaged and non-Windows launches bypass cache without retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-paths-test-'));
  try {
    const base = path.join(root, 'agent-core'); fs.mkdirSync(path.join(base, 'bun'), { recursive: true });
    const bundled = path.join(base, 'bun', 'bun.exe'); const custom = path.join(root, 'custom.exe');
    const entry = path.join(root, 'entry.js'); fs.writeFileSync(bundled, 'bundled'); fs.writeFileSync(custom, 'custom'); fs.writeFileSync(entry, '');
    const cases = [
      [{ platform: 'win32', isPackaged: false, bunPath: custom, env: {} }, custom],
      [{ platform: 'win32', isPackaged: false, env: { CCB_BUN: custom } }, custom],
      [{ platform: 'win32', isPackaged: true, env: {} }, bundled],
      [{ platform: 'linux', isPackaged: false, env: {} }, bundled],
    ];
    for (const [opts, expected] of cases) {
      const calls = [];
      const kernel = createCcbKernel({ ...opts, projectRoot: root, entryPath: entry, cwd: root, spawnImpl(exe) { calls.push(exe); throw new Error('spawn sentinel'); } });
      try { await assert.rejects(kernel.initialize('s'), /spawn sentinel/); assert.deepEqual(calls, [expected]); }
      finally { await kernel.dispose(); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real bundled CCB initializes with cached Bun', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const root = path.resolve('.'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-real-cache-'));
  const env = { ...process.env }; delete env.CCB_BUN; delete env.CCB_ROOT; delete env.CCB_ENTRY;
  const { spawn } = require('node:child_process'); let launched;
  const k = createCcbKernel({ projectRoot: root, isPackaged: false, env, bunCacheRoot: path.join(tmp, 'cache'), cwd: tmp, homeDir: path.join(tmp, 'home'), scratchDir: path.join(tmp, 'scratch'), startupTimeoutMs: 60000,
    spawnImpl(exe, args, options) { launched = exe; return spawn(exe, args, options); } });
  try {
    k.start({ sessionId: 'real' }); await k.initialize('real');
    assert.ok(k.getInfo('real').init); assert.ok(launched.startsWith(path.join(tmp, 'cache') + path.sep));
    assert.equal(sha(fs.readFileSync(launched)), sha(fs.readFileSync(path.join(root, 'agent-core', 'bun', 'bun.exe'))));
  } finally { await k.dispose(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
