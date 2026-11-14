import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLocalBackup, LIMITS } = require('../desktop/local-backup.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-backup-'));
  const kernel = createSessionKernel({ emit() {}, createAgent: () => ({ tools: [], async run() { return { text: '' }; } }), storePath: path.join(root, 'kernel.json') });
  let store = { spaces: [], tasks: [], artifacts: {}, sessionSpaces: {}, migrations: {} };
  const api = createLocalBackup({ kernel, root: path.join(root, '.cowork'), getStore: () => store, setStore: v => { store = v; }, storeFile: path.join(root, '.cowork', 'store.json') });
  t.after(() => { kernel.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, kernel, api, store: () => store };
}
function resign(data) { data.sha256 = crypto.createHash('sha256').update(JSON.stringify(data.payload)).digest('hex'); }
function fixture(h) {
  fs.writeFileSync(path.join(h.root, 'notes.txt'), 'attachment payload');
  fs.writeFileSync(path.join(h.root, 'unrelated.txt'), 'do not archive workspace');
  const s = h.kernel.start({ cwd: h.root });
  h.kernel.update(s.sessionId, { title: 'backup session', apiKey: 'secret-value', attachments: [{ path: 'notes.txt' }] });
  h.kernel.setTranscript(s.sessionId, [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'read @notes.txt' }, { type: 'file', path: 'notes.txt' }] } }]);
  return s.sessionId;
}
test('backup restores real kernel state, binary files and relative references without packing workspace', t => {
  const h = setup(t), id = fixture(h);
  const exported = h.api.export();
  const text = fs.readFileSync(exported.path, 'utf8'), data = JSON.parse(text);
  assert.equal(exported.files, 1);
  assert.doesNotMatch(text, /secret-value|unrelated.txt|do not archive workspace/);
  assert.equal(data.payload.files[0].sha256.length, 64);
  assert.throws(() => h.api.restore(exported.path), /CONFLICT/);
  assert.equal(h.api.inspect(exported.path).conflicts[0].sessionId, id);
  assert.equal(h.api.restore(exported.path, { conflict: 'skip' }).skipped, 1);
  const restored = h.api.restore(exported.path, { conflict: 'overwrite' });
  assert.equal(restored.imported, 1);
  const session = h.kernel.getSession(id), ref = h.kernel.getTranscript(id)[0].message.content[1].path;
  assert.equal(path.isAbsolute(ref), false);
  assert.equal(fs.readFileSync(path.join(session.cwd, ref), 'utf8'), 'attachment payload');
  assert.match(h.kernel.getTranscript(id)[0].message.content[0].text, /@files\//);
  assert.equal(session.isRunning, false);
  assert.equal(session.importedFrom, 'localBackup');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, 'kernel.json'))).sessions[0].cwd, session.cwd);
});
test('tampered digest, path traversal, duplicate names and size overflow fail before publication', t => {
  const h = setup(t); fixture(h); const result = h.api.export();
  const original = JSON.parse(fs.readFileSync(result.path));
  for (const mutate of [d => { d.payload.files[0].data = 'AAAA'; }, d => { d.payload.files[0].name = '../outside'; resign(d); }, d => { d.payload.files.push(d.payload.files[0]); resign(d); }]) {
    const d = structuredClone(original); mutate(d); fs.writeFileSync(result.path, JSON.stringify(d));
    assert.throws(() => h.api.restore(result.path, { conflict: 'overwrite' }), /CHECKSUM_MISMATCH|INVALID_BACKUP/);
  }
  fs.writeFileSync(path.join(h.root, 'large'), ''); fs.truncateSync(path.join(h.root, 'large'), LIMITS.fileBytes + 1);
  const id = h.kernel.getAll()[0].sessionId; h.kernel.update(id, { attachments: [{ path: 'large' }] });
  assert.throws(() => h.api.export(), /BACKUP_TOO_LARGE/);
});
test('running overwrite and persistence failure preserve kernel and managed files', t => {
  const h = setup(t), id = fixture(h), file = h.api.export().path;
  h.kernel.update(id, { isRunning: true });
  assert.throws(() => h.api.restore(file, { conflict: 'overwrite' }), /SESSION_RUNNING/);
  h.kernel.update(id, { isRunning: false, title: 'before failure' });
  h.kernel.flush();
  const kernelFile = path.join(h.root, 'kernel.json'); fs.unlinkSync(kernelFile); fs.mkdirSync(kernelFile);
  assert.throws(() => h.api.restore(file, { conflict: 'overwrite' }), /RESTORE_WRITE_FAILED/);
  assert.equal(h.kernel.getSession(id).title, 'before failure');
  assert.deepEqual(fs.readdirSync(path.join(h.root, '.cowork', 'restored')), []);
  assert.equal(fs.existsSync(path.join(h.root, '.cowork', 'store.json')), false);
});
test('explicit Write artifacts are archived without walking workspace', t => {
  const h = setup(t), id = fixture(h);
  h.kernel.update(id, { attachments: [] });
  h.kernel.setTranscript(id, [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(h.root, 'notes.txt'), content: 'attachment payload' } }] } }]);
  const file = h.api.export().path;
  assert.equal(h.api.inspect(file).files, 1);
  h.api.restore(file, { conflict: 'overwrite' });
  const ref = h.kernel.getTranscript(id)[0].message.content[0].input.file_path;
  assert.equal(fs.readFileSync(path.join(h.kernel.getSession(id).cwd, ref), 'utf8'), 'attachment payload');
});

test('credential attachment names and symlink sources are excluded or rejected', t => {
  const h = setup(t), id = fixture(h);
  fs.writeFileSync(path.join(h.root, '.env'), 'TOKEN=private');
  h.kernel.update(id, { attachments: [{ path: '.env' }] });
  h.kernel.setTranscript(id, []);
  assert.equal(h.api.preview().files, 0);
  try { fs.symlinkSync(path.join(h.root, 'notes.txt'), path.join(h.root, 'link.txt')); }
  catch (e) { if (e.code === 'EPERM') return; throw e; }
  h.kernel.update(id, { attachments: [{ path: 'link.txt' }] });
  assert.throws(() => h.api.export(), /UNSAFE_PATH/);
});
