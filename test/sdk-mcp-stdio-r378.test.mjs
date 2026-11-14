import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createSdkStdioSession } = require('../desktop/sdk-mcp-stdio-session.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'tools', 'proof-sdk-stdio-server.cjs');

test('malformed server frames reject pending work without crashing the host', async () => {
  for (const frame of ['null', '[]', '{"id":1,"result":{}}']) {
    const script = `process.stdin.once('data', () => process.stdout.write(${JSON.stringify(frame + '\n')}));`;
    const endpoint = createSdkStdioSession({ command: process.execPath, args: ['-e', script] });
    try {
      await assert.rejects(endpoint.read('ui://test'), /closed|invalid MCP frame/);
      await endpoint.exit;
    } finally { endpoint.close(); }
  }
});

test('separate stdio servers multiplex requests, cancel, and propagate exit', async () => {
  const wire = [];
  const alpha = createSdkStdioSession({ command: process.execPath, args: [server, 'alpha'], onMessage: m => wire.push(m) });
  const beta = createSdkStdioSession({ command: process.execPath, args: [server, 'beta'] });
  try {
    const req = id => ({ jsonrpc: '2.0', id, method: 'proof/delayed' });
    const results = await Promise.all([alpha.ccb(req(5)), alpha.ccb(req(5)), alpha.read('ui://alpha/page', 5)]);
    assert.deepEqual(results.map(x => x.id), [5, 5, 5]);
    assert.equal(new Set(wire.map(x => x.id)).size, 3);
    assert.equal(results[2].result.contents[0].text, 'alpha-content');
    const cancelled = alpha.ccb(req(6));
    await alpha.ccb({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 6 } });
    assert.equal((await cancelled).error.code, -32800);
    alpha.close();
    assert.equal((await alpha.exit).code, 0);
    assert.equal((await beta.read('ui://beta/page')).result.contents[0].text, 'beta-content');
    await assert.rejects(beta.ccb({ jsonrpc: '2.0', id: 7, method: 'proof/exit' }), /closed|exited/);
    assert.equal((await beta.exit).code, 7);
  } finally { alpha.close(); beta.close(); await Promise.all([alpha.exit, beta.exit]); }
});

test('real CCB uses two host-owned stdio fixture endpoints', { skip: process.env.CCD_REAL_SDK_STDIO_PROOF !== '1' }, async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'tools', 'proof-sdk-stdio-r378.cjs')], { cwd: root, env: process.env, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.err + result.out);
  const report = JSON.parse(result.out);
  assert.equal(report.ok, true);
  assert.equal(report.checks.unexpectedServerExitRejectsRequests, true);
});
