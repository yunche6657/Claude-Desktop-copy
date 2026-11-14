import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

test('shipped CLI resource reader reports not_connected without an owned query', async () => {
  const source = fs.readFileSync(path.resolve('../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js'), 'utf8');
  const start = source.indexOf('async readFromCliMcpAppServer(');
  const end = source.indexOf('};function Fj(', start);
  assert.ok(start > 0 && end > start);
  const Native = vm.runInNewContext(`(class { ${source.slice(start, end)} })`, {
    t: { GQ: { NotConnected: 'not_connected', ReadFailed: 'read_failed' } },
    kA: () => false, n: { pu: () => 'ui://fixture' },
  });
  const reader = new Native();
  reader.appMcpServerReadings = async () => [];
  reader.cliMcpAppsApply = () => true;
  const result = await reader.readFromCliMcpAppServer({ cliMcpAppServers: [{ name: 'fixture', tools: [] }] }, 'fixture', 'ui://fixture');
  assert.equal(result.unavailable, 'not_connected');
  assert.equal(result.contents.length, 0);
});
