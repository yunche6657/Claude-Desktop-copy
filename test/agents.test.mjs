// LocalSessions.getAgents must answer an array, never null.
//
// Two consumers in c227f4d5e-B8RiNIYP.js, with different robustness:
//
//   1. gO()  e?.getAgents?.().catch(_O) ?? []          // null -> [], safe
//            select: e => e.filter(x => x.source === "user")
//
//   2. lk()  the "@" mention provider:
//            fetchOptions: e => r().then(t => i(t, e))
//            i = (e, t) => { let n = t.toLowerCase();
//                            return e.filter(x => x.source === "user" && ...) }
//
// A null reaches `e.filter` and throws. The trailing `.catch(() => [])` swallows the
// TypeError, so the provider silently yields an empty list. Measured on the live replica:
//   answer null
//   consumer2 { threw: true, message: "Cannot read properties of null (reading 'filter')" }
//
// So "@" never offered any Agents, and the reason was a thrown error rather than an honest
// empty answer. This host has no ~/.claude/agents directory, so the truthful result is [].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { kernel, call };
}

test('the answer is an array, never null', async () => {
  const { call } = makeBridge();
  const agents = await call('LocalSessions', 'getAgents');
  assert.ok(Array.isArray(agents), `expected an array, got ${agents === null ? 'null' : typeof agents}`);
});

test('the mention provider does not throw on the answer', async () => {
  // This is the exact expression that used to throw: `e.filter(...)` on a null.
  const { call } = makeBridge();
  const agents = await call('LocalSessions', 'getAgents');
  assert.doesNotThrow(() => agents.filter((x) => x.source === 'user'));
});

test('the query consumer yields a list, not a fallback caused by a throw', async () => {
  // Consumer 1 does `?.() ?? []`. With an array the `?? []` is not needed, which is the
  // point: the empty list should come from the data, not from an error path.
  const { call } = makeBridge();
  const raw = await call('LocalSessions', 'getAgents');
  const viaNullish = raw ?? [];
  assert.equal(Array.isArray(viaNullish), true);
  assert.equal(viaNullish.length, raw.length, 'the ?? [] must not be what produces the list');
});

test('every returned record has the fields the consumers read', async () => {
  const { call } = makeBridge();
  const agents = await call('LocalSessions', 'getAgents');
  for (const a of agents) {
    assert.equal(typeof a.name, 'string', 'name is used as both id and label');
    assert.ok(a.name.length > 0);
    assert.equal(typeof a.source, 'string', 'source filters user vs project');
    assert.equal(typeof a.description, 'string', 'description may be empty but must exist');
  }
});

test('a project folder with no agents directory answers [] instead of throwing', async () => {
  const { call } = makeBridge();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-noagents-'));
  const agents = await call('LocalSessions', 'getAgents', empty);
  assert.ok(Array.isArray(agents));
});

test('real agent markdown files are read and parsed', async () => {
  // Build a project-level agents directory and confirm the handler picks it up, so the
  // implementation is not just "always return []".
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-proj-'));
  const dir = path.join(project, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviewer.md'), [
    '---',
    'name: reviewer',
    'description: Reviews pull requests for correctness',
    '---',
    '',
    'You are a careful reviewer.',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'helper.md'), 'No front matter here.\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an agent\n');

  const { call } = makeBridge();
  const agents = await call('LocalSessions', 'getAgents', project);

  const names = agents.map((a) => a.name).sort();
  assert.deepEqual(names, ['helper', 'reviewer'], 'only .md files become agents');

  const reviewer = agents.find((a) => a.name === 'reviewer');
  assert.equal(reviewer.description, 'Reviews pull requests for correctness');
  assert.equal(reviewer.source, 'project');

  const helper = agents.find((a) => a.name === 'helper');
  assert.equal(helper.description, '', 'a file without front matter still yields a record');
});

test('a broken markdown file does not break the whole list', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-broken-'));
  const dir = path.join(project, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'good.md'), '---\ndescription: fine\n---\nbody\n');
  // A directory named like a markdown file: readdir lists it, readFile fails.
  fs.mkdirSync(path.join(dir, 'weird.md'));

  const { call } = makeBridge();
  const agents = await call('LocalSessions', 'getAgents', project);
  assert.ok(agents.some((a) => a.name === 'good'), 'the readable agent must survive');
});
