import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchesCliServer, isToolDisabled } = require('../desktop/mcp-session-policy.cjs');

test('CLI name matching and tool denial match the shipped functions', () => {
  const helper = fs.readFileSync(path.resolve('../ccd-ref/asar/.vite/build/index.chunk-M6SkuaH9.js'), 'utf8');
  const app = fs.readFileSync(path.resolve('../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js'), 'utf8');
  const names = helper.slice(helper.indexOf('function Ne('), helper.indexOf('function Ge('));
  const policies = helper.slice(helper.indexOf('function uD('), helper.indexOf('function hD('));
  const ea = app.slice(app.indexOf('function EA('), app.indexOf('var DA=', app.indexOf('function EA(')));
  const native = vm.runInNewContext(`(()=>{${names}${policies}const n={Yu:Ue,qu:We};${ea}return {EA,mD};})()`, { t: { kP: 'remote-devices' } });
  for (const [known, name] of [[new Set(['plugin:My-App']), 'my_app'], [new Set(['foo']), 'foobar'], [new Set(['x']), 'other'], [new Set(['example.com']), 'EXAMPLE_com']]) {
    assert.equal(matchesCliServer(known, name), native.EA(known, name));
  }
  for (const session of [
    {}, { enabledMcpTools: { 's:write': false } }, { enabledMcpTools: { 'local:s:write': false } },
    { mcpToolsAskedOff: new Set(['s:write']) }, { mcpConnectorsAskedOut: new Set(['s']) },
    { mcpConnectorsAsked: new Set(), remoteMcpServersConfig: [{ uuid: 's', tools: [{ name: 'write' }] }] },
    { mcpConnectorsAsked: new Set(['s']), remoteMcpServersConfig: [{ uuid: 's', tools: [] }] },
  ]) assert.equal(isToolDisabled(session, 's', 'write'), native.mD(session, 's', 'write'));
  assert.equal(matchesCliServer(['plugin:My-App'], 'my_app'), true);
  assert.equal(isToolDisabled({ mcpToolsAskedOff: ['s:write'] }, 's', 'write'), true);
});

test('LocalSessions enforces CLI ownership and tool flags before contacting the host', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-session-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.CLAUDE_MCP_CONFIG;
  const configPath = path.join(dir, 'config.json');
  process.env.CLAUDE_MCP_CONFIG = configPath;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_MCP_CONFIG; else process.env.CLAUDE_MCP_CONFIG = previous; });
  const config = { mcpServers: { my_app: { command: 'fixture' } } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const { createSessionKernel } = require('../desktop/session-kernel.cjs');
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  const { McpHost } = require('../desktop/mcp-host.cjs');
  const kernel = createSessionKernel({ emit() {}, createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }), storePath: path.join(dir, 'sessions.json') });
  kernel.start({ sessionId: 's' });
  const host = new McpHost();
  host.load(config);
  const calls = [];
  Object.assign(host.servers.get('my_app'), { status: 'connected', connection: {
    async listResources() { calls.push('list'); return [{ uri: 'fixture' }]; },
    async readResource() { calls.push('read'); return [{ uri: 'fixture' }]; },
    async callTool() { calls.push('call'); return { content: [{ type: 'text', text: 'ok' }] }; },
  } });
  const handlers = new Map();
  registerBridgeServices({ mcpHost: host, ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler() {} },
    bridgeMap: require('../desktop/shim/bridge-map.json'), getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel }, frontend: { root: process.cwd() } });
  const call = (method, ...args) => {
    const channel = [...handlers.keys()].find(item => item.endsWith(`_$_LocalSessions_$_${method}`));
    return handlers.get(channel)({}, ...args);
  };
  kernel.update('s', { cliMcpAppServerNames: ['plugin:My-App'] });
  assert.deepEqual(await call('mcpListResources', 's', 'my_app'), []);
  assert.deepEqual(await call('mcpReadResource', 's', 'my_app', 'fixture'), { contents: [], unavailable: 'not_connected' });
  assert.equal((await call('mcpCallTool', 's', 'my_app', 'write', {})).isError, true);
  assert.deepEqual(calls, []);
  const reads = [];
  kernel.readCliMcpAppResource = async (...args) => { reads.push(args); return { contents: [{ uri: 'ui://fixture' }] }; };
  assert.deepEqual(await call('mcpReadResource', 's', 'my_app', 'ui://fixture'), { contents: [{ uri: 'ui://fixture' }] });
  assert.deepEqual(reads, [['s', 'my_app', 'ui://fixture']]);
  assert.deepEqual(calls, []);
  kernel.update('s', { cliMcpAppServerNames: [], enabledMcpTools: { 'local:my_app:write': false } });
  assert.equal((await call('mcpCallTool', 's', 'my_app', 'write', {})).content[0].text, "Tool 'write' is not permitted");
  assert.deepEqual(calls, []);
  kernel.update('s', { enabledMcpTools: {} });
  assert.equal((await call('mcpCallTool', 's', 'my_app', 'write', {})).content[0].text, 'ok');
  assert.deepEqual(calls, ['call']);
  kernel.flush();
});
