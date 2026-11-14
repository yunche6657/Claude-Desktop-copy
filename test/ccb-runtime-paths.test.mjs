import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveAgentRoot } = require('../desktop/ccb-runtime-paths.cjs');
const { resolveCcbPaths } = require('../desktop/ccb-kernel.cjs');
const { probeCcb } = require('../desktop/kernel-select.cjs');

test('source launch retains the repository runtime even under Electron', () => {
  assert.equal(resolveAgentRoot({ appRoot: path.resolve('source'), resourcesPath: path.resolve('electron/resources') }), path.resolve('source'));
});

test('packaged probe and spawn agree on the external pinned payload', () => {
  const resourcesPath = path.resolve('build/resources');
  for (const appRoot of [path.join(resourcesPath, 'app.asar'), path.join(resourcesPath, 'app')]) {
    const root = resolveAgentRoot({ appRoot, resourcesPath });
    assert.equal(root, resourcesPath);
    const fsImpl = { existsSync: () => true };
    const paths = resolveCcbPaths({ projectRoot: root, env: {}, fsImpl });
    const probe = probeCcb({ root, env: {}, exists: () => true });
    assert.equal(probe.bun, paths.bunPath);
    assert.equal(probe.entry, paths.entryPath);
    assert.ok(!paths.bunPath.includes('.asar'));
  }
});
