import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { createCcbKernel } = require('../desktop/ccb-kernel.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('poll results are actor and sequence bound and never publish CLI apps', async () => {
  let actor = 'one';
  const listeners = new Set(), pending = [], events = [];
  const backend = { id: 'ccb', start() {}, async sendMessage() {}, cancel() {}, dispose() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getInfo() { return { actorToken: actor }; },
    mcpServerStatus(_id, token) { const entry = deferred(); pending.push({ ...entry, token }); return entry.promise; },
  };
  const kernel = createSessionKernel({ backend, emit: e => events.push(e) });
  kernel.start({ sessionId: 's' });
  for (const fn of listeners) fn({ type: 'query_installed', sessionId: 's', actorToken: 'one' });
  assert.equal(pending.length, 1);
  const second = kernel.refreshCliMcpStatus('s');
  pending[1].resolve({ actorToken: 'one', servers: [{ name: 'new', status: 'connected', config: { secret: 'must-not-project' } }] });
  assert.equal(await second, true);
  pending[0].resolve({ actorToken: 'one', servers: [{ name: 'old', status: 'connected' }] });
  await Promise.resolve();
  assert.deepEqual(kernel.getCliMcpStatus('s'), { actorToken: 'one', servers: [{ name: 'new', status: 'connected' }] });
  const oldActorPoll = kernel.refreshCliMcpStatus('s');
  actor = 'two';
  assert.equal(kernel.getCliMcpStatus('s'), null);
  for (const fn of listeners) fn({ type: 'query_installed', sessionId: 's', actorToken: 'two' });
  pending[3].resolve({ actorToken: 'two', servers: [{ name: 'second', status: 'connected', tools: [{ name: 'x' }] }] });
  await Promise.resolve();
  pending[2].resolve({ actorToken: 'one', servers: [{ name: 'late', status: 'connected' }] });
  assert.equal(await oldActorPoll, false);
  assert.deepEqual(kernel.getCliMcpStatus('s'), { actorToken: 'two', servers: [{ name: 'second', status: 'connected', toolCount: 1 }] });
  assert.equal(events.some(e => e.type === 'session_cli_mcp_servers'), false);
  assert.equal(kernel.getSession('s').cliMcpAppServers, undefined);
  actor = null;
  for (const fn of listeners) fn({ type: 'query_closed', sessionId: 's', actorToken: null });
  assert.equal(kernel.getCliMcpStatus('s'), null);
  kernel.dispose();
});

test('actual CCB initialize triggers actor-bound MCP status without app publication', { timeout: 10000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ccb-mcp-'));
  const script = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(script, String.raw`
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line); if(f.type!=='control_request')return;
 const body=f.request.subtype==='mcp_status'?{mcpServers:[{name:'fixture',status:'connected',scope:'project',config:{type:'stdio',command:'private'},tools:[{name:'app',_meta:{ui:{resourceUri:'ui://app'}}}]}]}:{};
 process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:body}})+'\n');
});`);
  const backend = createCcbKernel({ bunPath: process.execPath, entryPath: script, kernelRoot: dir, cwd: dir, homeDir: path.join(dir, 'home'), scratchDir: path.join(dir, 'scratch') });
  const events = [];
  const kernel = createSessionKernel({ backend, emit: e => events.push(e) });
  t.after(async () => { kernel.dispose(); await backend.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  kernel.start({ sessionId: 's', cwd: dir });
  await backend.initialize('s');
  for (let i = 0; i < 100 && !kernel.getCliMcpStatus('s'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const status = kernel.getCliMcpStatus('s');
  assert.equal(status.actorToken, backend.getInfo('s').actorToken);
  assert.deepEqual(status.servers, [{ name: 'fixture', status: 'connected', transport: 'stdio', scope: 'project', toolCount: 1 }]);
  assert.equal(events.some(e => e.type === 'session_cli_mcp_servers'), false);
  assert.equal(kernel.getSession('s').cliMcpAppServers, undefined);
});

test('session update exposes sanitized MCP status only for the current actor',async t=>{
 let actor='a',status='failed';const events=[];
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},async sendMessage(){},getInfo(){return{actorToken:actor}},
  async mcpServerStatus(_id,token){return{actorToken:token,servers:[{name:'srv',status,scope:'project',config:{type:'http',url:'https://secret.example/private'},error:'Failed https://u:p@example.test/path?token=x',tools:[{name:'t'}]}]}}};
 const kernel=createSessionKernel({backend,emit:e=>events.push(e)});t.after(()=>kernel.dispose());kernel.start({sessionId:'s'});
 await kernel.refreshCliMcpStatus('s');
 const expected=[{name:'srv',status:'failed',error:'Failed https://example.test',transport:'http',scope:'project'}];
 assert.deepEqual(kernel.getSession('s').sdkMcpServers,expected);
 assert.deepEqual(events.filter(e=>e.type==='session_updated').at(-1).session.sdkMcpServers,expected);
 assert.equal(JSON.stringify(kernel.getSession('s')).includes('secret.example'),false);
 const count=events.filter(e=>e.type==='session_updated').length;await kernel.refreshCliMcpStatus('s');assert.equal(events.filter(e=>e.type==='session_updated').length,count);
 status='connected';await kernel.refreshCliMcpStatus('s');assert.equal(kernel.getSession('s').sdkMcpServers[0].toolCount,1);
 actor='b';assert.equal(kernel.getSession('s').sdkMcpServers,undefined);
});
