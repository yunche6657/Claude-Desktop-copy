// R645: a failed save closed the dialog, changed nothing, and said nothing.
//
// THE CHAIN, MEASURED IN A REAL ELECTRON RUN
//   With a readable but unwritable library, the full UI path (添加模型 → type model id → Tab → 应用更改 →
//   保存并重启) left the file byte-identical and wrote no inferenceModels.
//   The bridge, called directly, answers:
//       { ok:false, error: "cannot write the configuration library at <dir> (EPERM): ..." }
//   So the diagnosis exists (R639 added it) and the UI drops it.
//
// THE DEFECT
//       de = s(async () => (await D(C.current)).ok, [D])          // apply(): ok -> boolean, nothing else
//       async function tr({ lib, markSaved, setSaving, onRelaunch }) {
//         setSaving(true);
//         try { await lib.apply() && (markSaved(), onRelaunch()) } finally { setSaving(false) }
//       }
//   `apply()` false means tr does nothing. `commitApply` (P) DOES call T(e); `apply` did not. That asymmetry
//   is the bug, and P shows the author already knew the failure needed reporting.
//
// THE FIX
//       de = s(async () => { let e = await D(C.current);
//         if (!e.ok) { try { T(e.error ?? "unknown") } catch {} }
//         return e.ok }, [D, T])
//
// WHAT IT ACHIEVED — AND WHAT IT DID NOT
//   before: T never ran; no badge; footer said "无效：模型列表"
//   after : T runs; the 连接 nav item gains a (1) badge; footer says "① 连接 需要1个字段"
//   still : the error TEXT (the sentence naming the library directory) never reaches the screen, because
//           T only forwards to `w.current.onError`, a prop callback, and this component has `m = I()` (intl)
//           but no toast channel — addError lives in a different component (rr()).
//
// WHAT IS NOT CLAIMED
//   Not that saving works: it still fails here, and R640 showed the failure belongs to this restricted process.
//   Not that a user on a normal desktop ever hits this path, which would make the patch dormant.
//   Not that the string reaches the user: it does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1', 'c71860c77-BwbfSKgy.js');
const BACKUP = CHUNK + '.bak-r645';

test('apply() reports a failed write through the surface error channel', () => {
  const src = fs.readFileSync(CHUNK, 'utf8');
  assert.ok(src.includes('if(!e.ok){try{T(e.error??"unknown")}catch{}}'),
    'the apply() failure report is gone, so a failed save is silent again');
  assert.ok(src.includes('return e.ok},[D,T])'), 'apply() no longer depends on T');
});

test('the silent form is gone', () => {
  const src = fs.readFileSync(CHUNK, 'utf8');
  assert.ok(!src.includes('de=s(async()=>(await D(C.current)).ok,[D])'),
    'the boolean-only apply() is back');
});

test('commitApply still reports, so the two paths stay symmetric', () => {
  const src = fs.readFileSync(CHUNK, 'utf8');
  // P is commitApply: it catches, calls T(e), returns false.
  const i = src.indexOf('P=s(async()=>{let t=C.current.id');
  assert.ok(i > 0, 'commitApply is gone');
  const body = src.slice(i, i + 300);
  assert.match(body, /T\(e\)/, 'commitApply stopped reporting, so the asymmetry returned from the other side');
  assert.match(body, /return!(0|1)/, 'commitApply no longer signals failure in either branch');
});

test('a rollback copy of the pre-edit chunk exists', () => {
  assert.ok(fs.existsSync(BACKUP), 'no rollback copy');
  const orig = fs.readFileSync(BACKUP, 'utf8');
  assert.ok(orig.includes('de=s(async()=>(await D(C.current)).ok,[D])'), 'the backup is not the pre-edit file');
  assert.ok(!orig.includes('if(!e.ok){try{T(e.error'), 'the backup already carries the patch');
});

test('the evidence separates what improved from what did not', () => {
  const doc = path.join(ROOT, 'evidence', 'save-failure-silent-r645.md');
  assert.ok(fs.existsSync(doc), 'the evidence document is missing');
  const text = fs.readFileSync(doc, 'utf8');
  // Rule 8: the part that still fails must be written as still failing.
  assert.ok(text.includes('仍然否'), 'the remaining gap is not stated');
  assert.ok(text.includes('不声称'), 'the document does not scope its claims');
  assert.ok(text.includes('r645-after.png'), 'the screenshot that shows the partial fix is not referenced');
});
