import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import planModule from '../tools/test-run-plan.cjs';
const { createTestRunPlan } = planModule;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-test-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test'));
  return root;
}

test('option-only runs enumerate project tests and keep option values out of file batches', t => {
  const root = fixture(t);
  for (let i = 0; i < 101; i++) fs.writeFileSync(path.join(root, 'test', `${String(i).padStart(3, '0')}.test.mjs`), '');
  const plan = createTestRunPlan(root, ['--test-name-pattern', 'selected', '--test-reporter=spec']);
  assert.equal(plan.tests.length, 101);
  assert.deepEqual(plan.batches.map(batch => batch.length), [100, 1]);
  assert.deepEqual(plan.options, ['--test-name-pattern', 'selected', '--test-reporter=spec']);
  assert.ok(plan.batches.flat().every(file => file.startsWith('test/')));
});

test('validates bare test paths and rejects missing option values before launch', t => {
  const root = fixture(t);
  assert.throws(() => createTestRunPlan(root, ['absent.mjs']), /Requested test path not found/);
  assert.throws(() => createTestRunPlan(root, ['--test-name-pattern']), /Missing value/);
});

test('a missing child lifecycle completion fails instead of silently exiting zero', t => {
  const root = fixture(t);
  const preload = path.join(root, 'missing-child.cjs');
  fs.writeFileSync(preload, `const cp = require('node:child_process');\ncp.spawn = () => new (require('node:events').EventEmitter)();\n`);
  const run = spawnSync(process.execPath, ['--require', preload, path.resolve('tools/run-tests.cjs'),
    'test/test-runner-missing-r378.test.mjs'],
  { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(run.error);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /incomplete run: 0\/1 batches completed/);
});

test('each batch receives the same name filter in a real runner process', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'tools'));
  for (const name of ['run-tests.cjs', 'test-run-plan.cjs', 'test-no-console.cjs']) {
    fs.copyFileSync(path.resolve('tools', name), path.join(root, 'tools', name));
  }
  // Duplicate explicit files force a second batch without launching 101 workers.
  fs.writeFileSync(path.join(root, 'test', 'fixture.test.mjs'), `import test from 'node:test';\ntest('selected', () => {});\ntest('excluded', () => { throw new Error('FILTER_LOST'); });\n`);
  const run = spawnSync(process.execPath, [path.join(root, 'tools', 'run-tests.cjs'),
    '--test-name-pattern', '^selected$', ...Array(101).fill('test/fixture.test.mjs')],
  { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stderr, /batch 2\/2/);
  assert.match(run.stderr, /2 batch\(es\), 101 files, exit 0/);
  assert.doesNotMatch(run.stdout, /FILTER_LOST/);
});
