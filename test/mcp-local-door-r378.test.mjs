import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import hostModule from '../desktop/mcp-host.cjs';
import doorModule from '../desktop/mcp-local-door.cjs';

const { McpHost } = hostModule;
const { createLocalMcpDoor } = doorModule;
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-server.mjs');

test('authorized local tool call connects on demand and reuses connection', async () => {
  const host = new McpHost();
  host.load({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } });
  const door = createLocalMcpDoor({ host });
  try {
    assert.equal(host.list()[0].status, 'disconnected');
    const input = { name: 'fixture', operation: 'callTool', toolName: 'echo', args: { text: 'hello' }, isAuthorized: () => true };
    assert.equal((await door.run(input)).content[0].text, 'hello');
    const connection = host.servers.get('fixture').connection;
    assert.equal((await door.run(input)).content[0].text, 'hello');
    assert.equal(host.servers.get('fixture').connection, connection);
  } finally { await host.stopAll(); }
});

test('missing, asynchronous or revoked authorization never dispatches a tool call', async () => {
  let connected = 0, calls = 0, release;
  const state = { status: 'disconnected', connection: null };
  const host = { servers: new Map([['fixture', state]]), connect: async () => {
    connected++;
    await new Promise(resolve => { release = resolve; });
    state.status = 'connected';
    state.connection = { callTool: async () => { calls++; return {}; } };
  } };
  const door = createLocalMcpDoor({ host });
  const input = { name: 'fixture', operation: 'callTool', toolName: 'echo' };
  await assert.rejects(door.run(input), /denied/);
  await assert.rejects(door.run({ ...input, isAuthorized: async () => true }), /denied/);
  assert.equal(connected, 0);
  let current = true;
  const pending = door.run({ ...input, isAuthorized: () => current });
  current = false;
  release();
  await assert.rejects(pending, /denied/);
  assert.equal(calls, 0);
});

test('config replacement during connection prevents dispatch', async () => {
  const state = { status: 'disconnected', connection: null };
  let release, calls = 0;
  const host = { servers: new Map([['fixture', state]]), connect: async () => {
    await new Promise(resolve => { release = resolve; });
    state.status = 'connected';
    state.connection = { callTool: async () => { calls++; return {}; } };
  } };
  const pending = createLocalMcpDoor({ host }).run({ name: 'fixture', operation: 'callTool', toolName: 'echo', isAuthorized: () => true });
  host.servers.set('fixture', {});
  release();
  await assert.rejects(pending, /denied/);
  assert.equal(calls, 0);
});

test('config replacement during a call invalidates its result', async () => {
  const state = { status: 'disconnected', connection: null };
  let finishCall;
  const host = { servers: new Map([['fixture', state]]), connect: async () => {
    state.status = 'connected';
    state.connection = { callTool: () => new Promise(resolve => { finishCall = resolve; }) };
  } };
  const door = createLocalMcpDoor({ host });
  const pending = door.run({ name: 'fixture', operation: 'callTool', toolName: 'echo', isAuthorized: () => true });
  await Promise.resolve();
  host.servers.set('fixture', {});
  finishCall({ content: [] });
  await assert.rejects(pending, /denied/);
});

test('config lease binds loaded server states and exact file bytes', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mcp-config-lease-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'config.json');
  const write = name => fs.writeFileSync(file,JSON.stringify({mcpServers:{[name]:{command:'fixture'}}}));
  write('one');
  const host = new McpHost();
  let selected = file;
  const { createConfigFileLease } = doorModule;
  const lease = createConfigFileLease({host,getPath:()=>selected});
  assert.equal(lease.isCurrent(),true);
  write('two');
  assert.equal(lease.isCurrent(),false);
  const updated = createConfigFileLease({host,getPath:()=>selected});
  assert.equal(host.servers.has('two'),true);
  assert.equal(updated.isCurrent(),true);
  selected = path.join(dir,'missing.json');
  assert.equal(updated.isCurrent(),false);
  selected = file;
  fs.unlinkSync(file);
  assert.equal(updated.isCurrent(),false);
});

test('config lease invalidates on file replacement and host reconfiguration', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mcp-config-replace-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'config.json'), next = path.join(dir,'next.json');
  const data = JSON.stringify({mcpServers:{one:{command:'fixture'}}});
  fs.writeFileSync(file,data); fs.writeFileSync(next,data);
  const host = new McpHost();
  const lease = doorModule.createConfigFileLease({host,getPath:()=>file});
  fs.renameSync(next,file);
  assert.equal(lease.isCurrent(),false);
  const lease2 = doorModule.createConfigFileLease({host,getPath:()=>file});
  host.load({mcpServers:{other:{command:'fixture'}}});
  assert.equal(lease2.isCurrent(),false);
});

test('config modification during connect revokes lease before tool dispatch', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mcp-config-connect-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'config.json');
  fs.writeFileSync(file,JSON.stringify({mcpServers:{one:{command:'fixture'}}}));
  let release, dispatched = false;
  const host = {servers:new Map(),load(){this.servers.set('one',{status:'disconnected',server:{name:'one'}});},
    async connect(){await new Promise(resolve=>{release=resolve});const state=this.servers.get('one');
      state.status='connected';state.connection={async callTool(){dispatched=true;return {}}};}};
  const lease = doorModule.createConfigFileLease({host,getPath:()=>file});
  const pending = createLocalMcpDoor({host}).run({name:'one',operation:'callTool',toolName:'tool',isAuthorized:()=>lease.isCurrent()});
  fs.writeFileSync(file,JSON.stringify({mcpServers:{one:{command:'different'}}}));
  release();
  await assert.rejects(pending,/denied/);
  assert.equal(dispatched,false);
});


test('config lease rejects in-place mutation of the loaded server definition', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mcp-config-mutate-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'config.json');
  fs.writeFileSync(file,JSON.stringify({mcpServers:{one:{command:'fixture'}}}));
  const host = new McpHost();
  const lease = doorModule.createConfigFileLease({host,getPath:()=>file});
  assert.equal(lease.isCurrent(),true);
  host.servers.get('one').server.command = 'mutated';
  assert.equal(lease.isCurrent(),false);
});
