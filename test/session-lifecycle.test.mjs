// Session lifecycle actions, verified live with real pointer input.
//
// Measured this round on the replica:
//
//   right-click a row -> 打开方式 / 置顶 P / 标记为未读 U / 重命名 R /
//                        分叉 F / 移至分组 / 归档 A / 删除 D
//   归档  -> getAll archived count 0 -> 1
//   删除  -> confirmation alertdialog:
//            「删除 1 个会话？…将被永久删除。此操作无法撤销。」 [取消] [删除]
//
// The first version of this test called kernel.update() directly. A mutation that removed
// the isArchived assignment from the bridge's applyPatch left it green — because the test
// never went through applyPatch. These assertions now read the bridge source itself, which
// is where the menu's write actually happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

/** The body of applyPatch — where the row-menu fields are actually written. */
function applyPatchBody() {
  const start = SRC.indexOf('const applyPatch = (sessionId, patch) => {');
  assert.ok(start > 0, 'applyPatch is missing');
  const end = SRC.indexOf('return kernel.update(sessionId, next);', start);
  assert.ok(end > start, 'applyPatch has no return line');
  return SRC.slice(start, end);
}

const makeKernel = () => createSessionKernel({
  emit: () => {},
  log: () => {},
  createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: 'ok' }; } }),
});

test('applyPatch copies the archive flag onto the record', () => {
  // 归档 must flip isArchived. The assertion names the exact assignment so a mutation that
  // deletes that line turns this red.
  const body = applyPatchBody();
  assert.ok(
    body.includes("if (typeof patch.isArchived === 'boolean') next.isArchived = patch.isArchived;"),
    'applyPatch no longer applies isArchived',
  );
});

test('archiving keeps the record, deleting removes it', () => {
  // The distinction the UI promises: 归档 is reversible, 删除 is not.
  const kernel = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  kernel.update(s.sessionId, { isArchived: true });
  assert.equal(kernel.getSession(s.sessionId).isArchived, true);
  assert.ok(kernel.getSession(s.sessionId), 'archiving destroyed the record');

  const result = kernel.remove(s.sessionId);
  assert.equal(result.ok, true);
  assert.equal(kernel.getSession(s.sessionId), null, 'the session survived deletion');
});

test('the confirm copy warns that deletion is irreversible', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'i18n-overlay', 'zh-Hans.json'), 'utf8'));
  const values = Object.values(zh).filter((v) => typeof v === 'string');
  assert.ok(values.some((v) => v.includes('无法撤销')), 'no irreversible-action warning in the catalogue');
});

test('the lifecycle channels the menu uses all have handlers', () => {
  for (const method of ['updateSession', 'delete']) {
    assert.ok(SRC.includes('_$_' + method + "'"), 'no handler for ' + method);
  }
});
