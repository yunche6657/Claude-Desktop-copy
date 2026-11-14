import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { projectMcpStatus } = require('../desktop/mcp-status-projection.cjs');

test('MCP status projects native transport, scope and connected tool count without config', () => {
  const row = { name: 'a', status: 'connected', scope: 'project', config: { command: 'private', env: { TOKEN: 'private' } }, tools: [{ name: 'one' }] };
  assert.deepEqual(projectMcpStatus(row), { name: 'a', status: 'connected', transport: 'stdio', scope: 'project', toolCount: 1 });
  assert.deepEqual(projectMcpStatus({ ...row, status: 'failed', scope: 'unrecognized', config: { type: 'new-type' } }), { name: 'a', status: 'failed', transport: 'unknown' });
  assert.deepEqual(projectMcpStatus({ name: 'b', status: 'pending' }), { name: 'b', status: 'pending' });
  assert.deepEqual(projectMcpStatus({ name: 'b', status: 'connected', tools: [] }), { name: 'b', status: 'connected', toolCount: 0 });
});
