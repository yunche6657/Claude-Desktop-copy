// Session row actions, verified live with real pointer input this round.
//
// These already worked. The point of pinning them is that nothing in the suite would
// have noticed if they stopped, and rounds 145-150 showed how easily a plausible
// change breaks behaviour that no test touches.
//
// Measured on the replica, all with mousePressed/mouseReleased rather than .click():
//
//   session row right-click -> 打开方式 / 置顶 P / 标记为未读 U / 重命名 R /
//                             分叉 F / 移至分组 / 归档 A / 删除 D
//   置顶   -> trace: LocalSessions.updateSession [id, {isStarred:true}]
//            and AppPreferences starred-local-code-sessions gains the id
//   重命名 -> trace: LocalSessions.updateSession [id, {title:"RENAMED-BY-PROBE"}]
//   restart -> 111 sessions, the rename and the pin all survive
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

/** The body of applyPatch, up to its closing brace. */
function applyPatchBody() {
  const start = SRC.indexOf('const applyPatch = (sessionId, patch) => {');
  assert.ok(start > 0, 'the patch whitelist is missing');
  // The body ends at the return line; a bare '};' search stops too early.
  const marker = 'return kernel.update(sessionId, next);';
  const end = SRC.indexOf(marker, start);
  assert.ok(end > start, 'applyPatch has no return line');
  assert.ok(end - start < 3000, 'applyPatch body looks truncated');
  return SRC.slice(start, end);
}

test('applyPatch copies each row-action field onto the record', () => {
  // The first version of this test searched a 900-character window for the bare word
  // 'title' and still passed after that line was deleted, because other lines in the
  // window mention it. Anchor on the assignment itself.
  const body = applyPatchBody();
  const ASSIGNMENTS = [
    "if (typeof patch.title === 'string') next.title = patch.title;",
    "if (typeof patch.isStarred === 'boolean') next.isStarred = patch.isStarred;",
    "if (typeof patch.isArchived === 'boolean') next.isArchived = patch.isArchived;",
  ];
  for (const line of ASSIGNMENTS) {
    assert.ok(body.includes(line), 'applyPatch no longer applies: ' + line);
  }
});

test('updateSession persists through applyPatch and emits the update', () => {
  // A handler that only echoed the payload would look correct and change nothing.
  const at = SRC.indexOf('_$_updateSession');
  const block = SRC.slice(at, at + 400);
  assert.match(block, /applyPatch\s*\(/, 'updateSession must patch the stored record');
  assert.match(block, /emitSessionEvent/, 'other views must be told the record changed');
});

test('the app has a session store it can flush', () => {
  // Restart persistence was verified end to end; this pins the mechanism.
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  assert.match(kernel, /flush\s*[:(]/, 'the kernel exposes no flush');
  assert.match(kernel, /storePath|writeFileSync/, 'the kernel never writes its store');
});
