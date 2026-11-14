import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { createCoworkGlobalMemory } = createRequire(import.meta.url)('../desktop/cowork-global-memory.cjs');
const temp = 'D:/CodexArtifacts/claude-code-desktop/tmp';
function fixture() {
  fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, 'reset-memory-'));
  const base = path.join(root, 'local-agent-mode-sessions', 'a', 'o');
  let identity = { accountId: 'a', orgId: 'o' };
  const store = createCoworkGlobalMemory({ userDataDir: root, getAccountContext: () => identity });
  const put = (relative, text) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  return { root, base, store, put, setIdentity: value => { identity = value; }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const prefix = 'local-agent-mode-sessions/a/o/';

test('reset clears only current account and space memories, recreating empty directories', async () => {
  const f = fixture();
  try {
    for (const name of ['memory/memory/MEMORY.md', 'memory/memory/nested/data', 'spaces/one/memory/nested/data', 'spaces/two/memory/other']) f.put(prefix + name, 'delete');
    for (const name of ['memory/CLAUDE.md', 'spaces/one/keep.txt']) f.put(prefix + name, 'keep');
    f.put('local-agent-mode-sessions/a/other/memory/memory/keep.md', 'keep');
    f.put('local-agent-mode-sessions/b/o/memory/memory/keep.md', 'keep');
    assert.equal(await f.store.resetMemories(), true);
    for (const dir of ['memory/memory', 'spaces/one/memory', 'spaces/two/memory']) assert.deepEqual(fs.readdirSync(path.join(f.base, dir)), []);
    for (const name of [prefix + 'memory/CLAUDE.md', prefix + 'spaces/one/keep.txt', 'local-agent-mode-sessions/a/other/memory/memory/keep.md', 'local-agent-mode-sessions/b/o/memory/memory/keep.md']) assert.equal(fs.readFileSync(path.join(f.root, name), 'utf8'), 'keep');
  } finally { f.cleanup(); }
});

test('missing, invalid or revoked identity never deletes', async () => {
  const f = fixture();
  try {
    f.put(prefix + 'memory/memory/keep.md', 'keep');
    for (const identity of [null, {accountId: '../a', orgId: 'o'}, {accountId: 'a', orgId: 'o', isCurrent: () => false}, {accountId: 'a', orgId: 'o', isCurrent: () => { throw Error('revoked'); }}]) {
      f.setIdentity(identity);
      assert.equal(await f.store.resetMemories(), false);
      assert.equal(fs.readFileSync(path.join(f.base, 'memory/memory/keep.md'), 'utf8'), 'keep');
    }
    let checks = 0;
    f.setIdentity({accountId:'a', orgId:'o', isCurrent: () => ++checks < 3});
    assert.equal(await f.store.resetMemories(), false);
    assert.equal(fs.readFileSync(path.join(f.base, 'memory/memory/keep.md'), 'utf8'), 'keep');
  } finally { f.cleanup(); }
});

test('junction in target tree prevents all deletions', async t => {
  const f = fixture();
  try {
    f.put(prefix + 'memory/memory/keep.md', 'keep');
    f.put('outside/keep.md', 'outside');
    const space = path.join(f.base, 'spaces/one'); fs.mkdirSync(space, {recursive:true});
    try { fs.symlinkSync(path.join(f.root, 'outside'), path.join(space, 'memory'), 'junction'); }
    catch (error) { if (['EPERM','EACCES','ENOSYS'].includes(error.code)) return t.skip('junction unavailable'); throw error; }
    assert.equal(await f.store.resetMemories(), false);
    assert.equal(fs.readFileSync(path.join(f.base, 'memory/memory/keep.md'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(f.root, 'outside/keep.md'), 'utf8'), 'outside');
  } finally { f.cleanup(); }
});
