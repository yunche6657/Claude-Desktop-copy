import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices, messageChannel } = require('../desktop/bridge-services.cjs');

test('both import confirmation IPC routes reach the session kernel', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, 'sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({ sessions: ['one', 'two', 'staged'].map(id => ({
    sessionId: `local_${id}`, cwd: dir, workingDir: dir, originCwd: dir,
    importedFrom: 'terminalCli', ...(id === 'staged' ? { stagedTranscriptPath: 'staged.jsonl', cliSessionId: 'fixture-cli' } : {}),
  })), transcripts: {} }));
  const kernel = createSessionKernel({ storePath, emit() {}, createAgent: () => ({ model: 'fixture', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }) });
  t.after(() => kernel.dispose());
  const handlers = new Map();
  registerBridgeServices({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) },
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: path.resolve('.') },
  });
  const call = (channel, id) => handlers.get(channel)({}, id);
  const code = messageChannel('claude.web', 'LocalSessions', 'confirmImportedSessionResume');
  const importer = messageChannel('claude.settings', 'ClaudeAiImport', 'confirmImportedSessionResume');
  assert.equal(await call(code, 'one'), true);
  assert.equal(await call(importer, 'two'), true);
  assert.equal(await call(importer, 'one'), false);
  assert.equal(await call(code, 'staged'), false);
  assert.equal(await call(importer, 'missing'), false);
  const saved = JSON.parse(fs.readFileSync(storePath, 'utf8')).sessions;
  assert.equal(saved.find(s => s.sessionId === 'local_one').resumeConfirmed, true);
  assert.equal(saved.find(s => s.sessionId === 'local_two').resumeConfirmed, true);
  assert.equal(saved.find(s => s.sessionId === 'local_staged').resumeConfirmed, undefined);
});
