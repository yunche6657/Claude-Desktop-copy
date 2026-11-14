import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { projectSessionPaths } = require('../desktop/session-path-projection.cjs');

test('public path projection handles independently missing legacy path fields', () => {
  for (const missing of [null, undefined, '', 1, {}]) {
    const raw = { cwd: 'C:\\old-project', workingDir: missing, originCwd: missing };
    const result = projectSessionPaths(raw, 'C:\\fixture');
    assert.equal(result.workingDir, raw.cwd);
    assert.equal(result.originCwd, raw.cwd);
    assert.equal(raw.workingDir, missing);
    // Same operation as c22d6171c-C3t7W9JR.js's path-version hook.
    assert.doesNotThrow(() => result.workingDir.replace(/[\\/]+$/, ''));
  }
  assert.deepEqual(projectSessionPaths({ cwd: null, workingDir: null, originCwd: null }, 'C:\\fixture'), {
    cwd: 'C:\\fixture', workingDir: 'C:\\fixture', originCwd: 'C:\\fixture', folderless: true,
  });
  assert.deepEqual(projectSessionPaths({ cwd: 'C:\\a', workingDir: 'C:\\b', originCwd: 'C:\\c' }), {
    cwd: 'C:\\a', workingDir: 'C:\\b', originCwd: 'C:\\c',
  });
});

test('loading a persisted legacy session projects usable paths without rewriting raw nulls', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-path-projection-'));
  const storePath = path.join(dir, 'store.json');
  const sessionId = 'local_591fcec4-2bd7-4db8-954b-136105280c04';
  const raw = { version: 2, sessions: [{ sessionId, title: '你好', cwd: dir, workingDir: null, originCwd: null }], transcripts: { [sessionId]: [] } };
  writeFileSync(storePath, JSON.stringify(raw));
  const before = readFileSync(storePath, 'utf8');
  const kernel = createSessionKernel({ storePath, emit() {}, createAgent: () => ({ run() {} }) });
  const session = kernel.getSession(sessionId);
  assert.equal(session.workingDir, dir);
  assert.equal(session.originCwd, dir);
  assert.equal(kernel.getAll()[0].workingDir, dir);
  assert.equal(readFileSync(storePath, 'utf8'), before);
  kernel.dispose();
});
