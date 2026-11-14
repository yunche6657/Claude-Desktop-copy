import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const { buildRelaunchArgs, isTransientRelaunchArg } = createRequire(import.meta.url)('../desktop/relaunch-args.cjs');

test('original transient arguments are filtered individually', () => {
  const rejected = [
    ...['claude', 'claude-dev', 'claude-nest', 'claude-nest-dev', 'claude-nest-prod'].map(s => `${s}://open`),
    'CLAUDE://open', '--startup', 'extension.DXT', 'extension.McPb', '--os-entry=jump_list',
    '--relaunched-after-gpu-crash-loop', '--claude-hybrid-switch-org=example',
    path.resolve('absolute.txt'), pathToFileURL(path.resolve('absolute.txt')).href,
    ...(process.platform === 'win32' ? ['C:"', 'C:\\folder\\file.txt', 'file:///C:/folder/file.txt'] : []),
  ];
  for (const arg of rejected) assert.equal(isTransientRelaunchArg(arg), true, arg);
  for (const arg of ['relative/file', 'file:invalid%', 'https://claude.ai', '--startup=1', '--os-entry', '--claude-hybrid-switch-org', 'x.dxt.more', '--flag']) {
    assert.equal(isTransientRelaunchArg(arg), false, arg);
  }
});

test('default app preserves entry; packaged skips executable; additional args append unfiltered', () => {
  const argv = ['electron.exe', 'C:\\app\\entry.js', '--startup', '--ordinary', 'relative', 'claude://open', '--os-entry=service', 'tail'];
  assert.deepEqual(buildRelaunchArgs(argv, true, ['--startup', 'added']), ['C:\\app\\entry.js', '--ordinary', 'relative', 'tail', '--startup', 'added']);
  assert.deepEqual(buildRelaunchArgs(['app.exe', ...argv.slice(2)], false, ['added']), ['--ordinary', 'relative', 'tail', 'added']);
});
