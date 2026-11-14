import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerBridgeServices, messageChannel } = require('../desktop/bridge-services.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-export-'));
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.APPDATA = path.join(root, 'roaming');
  process.env.LOCALAPPDATA = root;
  const kernel = createSessionKernel({ emit() {}, createAgent: () => ({ tools: [], async run() { return { text: '' }; } }) });
  const handlers = new Map();
  const bridge = registerBridgeServices({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: c => handlers.delete(c) },
    bridgeMap: { 'claude.web': {
      CoworkStorage: ['exportTask', 'exportProject', 'exportAll'],
      CoworkSpaces: ['createSpace', 'setRemoteSessionSpace'],
      CoworkScheduledTasks: ['createScheduledTask'],
    } },
    getMainWindow: () => null,
    settings: { dataDir: root, coworkUserFilesPath: root, kernelFactory: () => kernel },
    frontend: { root },
  });
  t.after(async () => {
    await bridge.dispose();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = (service, method, ...args) => handlers.get(messageChannel('claude.web', service, method))({}, ...args);
  const readExport = result => {
    assert.equal(result.ok, true);
    assert.equal(fs.statSync(result.path).size, result.sizeBytes);
    const archive = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    return { format: archive.format, ...archive.payload, ...archive.payload.metadata };
  };
  return { root, kernel, call, readExport };
}

function session(h, title) {
  const record = h.kernel.start({ cwd: h.root });
  h.kernel.update(record.sessionId, { title });
  h.kernel.setTranscript(record.sessionId, [{ type: 'user', message: { role: 'user', content: [
    { type: 'text', text: title + ' content' }, { type: 'image', source: { data: 'excluded-binary' } },
  ] } }]);
  return record.sessionId;
}

test('task export writes only the selected conversation and complete transcript', async t => {
  const h = boot(t);
  const id = session(h, 'selected');
  session(h, 'other');
  const result = await h.call('CoworkStorage', 'exportTask', id);
  const data = h.readExport(result);
  assert.equal(data.format, 'claude-desktop-local-backup-v1');
  assert.equal(data.kind, 'task');
  assert.deepEqual(data.sessions.map(s => s.session.sessionId), [id]);
  assert.match(data.sessions[0].transcript[0].message.content[0].text, /selected content/);
  assert.doesNotMatch(fs.readFileSync(result.path, 'utf8'), /other content/);
});

test('project export selects membership and all export includes the complete local store', async t => {
  const h = boot(t);
  const a = session(h, 'project member');
  const b = session(h, 'outside');
  const space = await h.call('CoworkSpaces', 'createSpace', { name: 'project', instructions: 'keep these' });
  await h.call('CoworkSpaces', 'setRemoteSessionSpace', a, space.id);
  const task = await h.call('CoworkScheduledTasks', 'createScheduledTask', { name: 'daily', prompt: 'do work' });
  h.kernel.update(a, { scheduledTaskId: task.id });
  const project = h.readExport(await h.call('CoworkStorage', 'exportProject', space.uuid));
  assert.deepEqual(project.sessions.map(s => s.session.sessionId), [a]);
  assert.equal(project.spaces[0].instructions, 'keep these');
  assert.equal(project.tasks[0].prompt, 'do work');
  assert.deepEqual(project.sessionSpaces, { [a]: space.id });
  const first = await h.call('CoworkStorage', 'exportAll');
  const all = h.readExport(first);
  assert.deepEqual(new Set(all.sessions.map(s => s.session.sessionId)), new Set([a, b]));
  assert.equal(all.tasks[0].id, task.id);
  assert.equal(all.spaces[0].id, space.id);
  const second = await h.call('CoworkStorage', 'exportAll');
  h.readExport(second);
  assert.notEqual(first.path, second.path);
  assert.equal(fs.existsSync(first.path), true);
});

test('scheduled definitions and empty all exports produce readable files', async t => {
  const h = boot(t);
  assert.deepEqual(h.readExport(await h.call('CoworkStorage', 'exportAll')).sessions, []);
  const task = await h.call('CoworkScheduledTasks', 'createScheduledTask', { name: 'daily', prompt: 'retained prompt' });
  const data = h.readExport(await h.call('CoworkStorage', 'exportTask', task.id));
  assert.equal(data.tasks[0].prompt, 'retained prompt');
  assert.deepEqual(data.sessions, []);
});

test('missing IDs and failed writes never claim success or return a path', async t => {
  const h = boot(t);
  for (const method of ['exportTask', 'exportProject']) {
    const result = await h.call('CoworkStorage', method, '../../missing');
    assert.deepEqual(result, { ok: false, errorCode: 'NOT_FOUND' });
  }
  const exportsDir = path.join(h.root, '.cowork', 'exports');
  fs.writeFileSync(exportsDir, 'block directory creation');
  const result = await h.call('CoworkStorage', 'exportAll');
  assert.deepEqual(result, { ok: false, errorCode: 'UNSAFE_PATH' });
  assert.equal(fs.readFileSync(exportsDir, 'utf8'), 'block directory creation');
});
