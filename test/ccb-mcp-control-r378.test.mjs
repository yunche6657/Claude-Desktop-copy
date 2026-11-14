import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { createCcbKernel } = createRequire(import.meta.url)('../desktop/ccb-kernel.cjs');

test('MCP controls bind to the running actor and validate responses', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-mcp-control-'));
  const script = path.join(dir, 'fixture.cjs');
  const log = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(script, String.raw`
const readline = require('node:readline'), fs = require('node:fs'), path = require('node:path');
let invalidStatus = false;
const out = x => process.stdout.write(JSON.stringify(x) + '\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const f = JSON.parse(line);
  if (f.type !== 'control_request') return;
  const r = f.request;
  if (r.subtype !== 'initialize') fs.appendFileSync(path.join(__dirname, 'requests.jsonl'), JSON.stringify(r) + '\n');
  const reply = body => out({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:body}});
  if (r.subtype === 'initialize') return reply({});
  if (r.subtype === 'mcp_status') return reply({mcpServers:invalidStatus ? 'invalid' : [{name:'owned',status:'connected'}]});
  if (r.subtype === 'mcp_reconnect' || r.subtype === 'mcp_toggle') return reply({});
  if (r.subtype === 'mcp_read_resource') {
    if (r.uri === 'ui://bad-status') { invalidStatus = true; return reply({contents:[]}); }
    if (r.uri === 'ui://timeout') return;
    if (r.uri === 'ui://exit') return process.exit(0);
    if (r.uri === 'ui://delay') return setTimeout(() => reply({contents:[{uri:r.uri,text:'old'}]}), 300);
    if (r.uri === 'ui://invalid') return reply({contents:[{uri:1}]});
    if (r.uri === 'ui://reject') return out({type:'control_response',response:{subtype:'error',request_id:f.request_id,error:'fixture denied'}});
    return reply({contents:[{uri:r.uri,text:'fixture',_meta:{ui:{resourceUri:r.uri}}}]});
  }
});`);
  const kernel = createCcbKernel({ bunPath: process.execPath, entryPath: script, kernelRoot: dir, cwd: dir,
    homeDir: path.join(dir, 'home'), scratchDir: path.join(dir, 'scratch'), mcpControlTimeoutMs: 120 });
  t.after(async () => { await kernel.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  kernel.start({ sessionId: 's' });
  await kernel.initialize('s');
  const actor = kernel.getInfo('s').actorToken;
  assert.ok(actor);
  assert.deepEqual(await kernel.mcpServerStatus('s', actor), { actorToken: actor, servers: [{ name: 'owned', status: 'connected' }] });
  assert.deepEqual(await kernel.reconnectMcpServer('s', actor, 'owned'), { actorToken: actor });
  assert.deepEqual(await kernel.toggleMcpServer('s', actor, 'owned', false), { actorToken: actor });
  await assert.rejects(kernel.toggleMcpServer('s', actor, 'owned', 'false'), TypeError);
  assert.deepEqual(await kernel.readMcpResource('s', actor, 'owned', 'ui://ok'), {
    actorToken: actor, contents: [{ uri: 'ui://ok', text: 'fixture', _meta: { ui: { resourceUri: 'ui://ok' } } }],
  });
  await assert.rejects(kernel.readMcpResource('s', actor, 'owned', 'ui://invalid'), e => e.code === 'CCB_CONTROL_INVALID');
  await assert.rejects(kernel.readMcpResource('s', actor, 'owned', 'ui://reject'), e => e.code === 'CCB_CONTROL_REJECTED');
  await kernel.readMcpResource('s', actor, 'owned', 'ui://bad-status');
  await assert.rejects(kernel.mcpServerStatus('s', actor), e => e.code === 'CCB_CONTROL_INVALID');
  await assert.rejects(kernel.readMcpResource('s', actor, 'owned', 'ui://timeout'), e => e.code === 'CCB_CONTROL_TIMEOUT');
  const pending = kernel.readMcpResource('s', actor, 'owned', 'ui://delay');
  const pendingResult = Promise.allSettled([pending]);
  for (let i = 0; i < 100 && !fs.readFileSync(log, 'utf8').includes('ui://delay'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(fs.readFileSync(log, 'utf8').includes('ui://delay'));
  assert.equal(kernel.removeSession('s').ok, true);
  assert.equal((await pendingResult)[0].reason.code, 'CCB_SESSION_REMOVED');
  kernel.start({ sessionId: 's' });
  await kernel.initialize('s');
  const replacement = kernel.getInfo('s').actorToken;
  assert.notEqual(replacement, actor);
  await assert.rejects(kernel.mcpServerStatus('s', actor), e => e.code === 'CCB_ACTOR_STALE');
  await assert.rejects(kernel.reconnectMcpServer('s', actor, 'owned'), e => e.code === 'CCB_ACTOR_STALE');
  assert.equal((await kernel.mcpServerStatus('s', replacement)).actorToken, replacement);
  const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests[0], { subtype: 'mcp_status' });
  assert.deepEqual(requests[1], { subtype: 'mcp_reconnect', serverName: 'owned' });
  assert.deepEqual(requests[2], { subtype: 'mcp_toggle', serverName: 'owned', enabled: false });
  assert.deepEqual(requests[3], { subtype: 'mcp_read_resource', serverName: 'owned', uri: 'ui://ok' });
  await assert.rejects(kernel.readMcpResource('s', replacement, 'owned', 'ui://exit'), e => e.code === 'CCB_CONTROL_EXIT');
  await assert.rejects(kernel.mcpServerStatus('s', replacement), e => e.code === 'CCB_ACTOR_STALE');
});
