// R648: the frontend edits were in the developer tree only. The packaged exe reads resources/app.asar, which had none.
//
// THE MEASUREMENT
//   Reading both asar files as bytes:
//       release/win-unpacked/resources/app.asar   user-menu-model: false   apply-fix: false
//       dist-r648/resources/app.asar              user-menu-model: true    apply-fix: true
//   So rounds 641-647 changed files under resources/ion-dist, and the packaged build never saw them. That is why
//   launching the exe showed no Model entry — not a code defect, a packaging gap.
//
// THE REPAIR
//       node build/build.cjs --target asar --out dist-r648
//       Copy-Item dist-r648/resources/app.asar release/win-unpacked/resources/app.asar
//   `resources/ion-dist` is already in SHIP (build/packaging.cjs), so a rebuild carries the frontend automatically.
//   Prior asar kept at .tmp/app.asar.bak-r648.
//
// MEASURED IN THE PACKAGED EXE, NOT THE DEV TREE
//       served chunk: { ok:true, len:23438, model:true }
//       menu items: ["设置Ctrl+,", "Model", "语言", "推理配置", ...]
//       click Model -> pages: 2 -> app://localhost/setup-desktop-3p
//       rendered: title true, nav 连接/功能/连接器/遥测与更新/限额/外观/插件/出口流量/来源
//
// WHAT IS NOT CLAIMED
//   Not that the installer is updated: release/*.exe (195.1 MB NSIS) still wraps the old asar, and
//   build/build.cjs only produces --target dir|asar. Rebuilding the installer needs electron-builder and was not done.
//   Not that saving works: writeConfig answers EPERM in this restricted process (R640).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASAR = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');

const asarText = () => {
  assert.ok(fs.existsSync(ASAR), 'the packaged asar is missing: ' + ASAR);
  return fs.readFileSync(ASAR, 'latin1');
};

test('the packaged asar carries the Model menu entry', () => {
  // The entry lives inside the ion-dist copy that the asar embeds, so a plain byte search is the right check.
  assert.ok(asarText().includes('user-menu-model'),
    'the packaged frontend predates R642: rebuild with build/build.cjs and copy dist-r648/resources/app.asar');
});

test('the packaged asar carries the R645 apply() failure report', () => {
  assert.ok(asarText().includes('if(!e.ok){try{T('),
    'the packaged frontend predates R645');
});

test('the packaged asar still carries the inference-setup opener', () => {
  // R641 is the bridge handler in desktop/bridge-services.cjs, which is also inside the asar.
  assert.ok(asarText().includes('openSetupWindow'), 'the packaged app lost openSetupWindow');
});

test('the source of truth it was built from also carries them', () => {
  const chunk = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1', 'cd75f6c8c-zFZzXb5w.js');
  const src = fs.readFileSync(chunk, 'utf8');
  assert.ok(src.includes('user-menu-model'));
  // Everything that reaches the asar must first exist here; a mismatch means the asar is stale again.
  const bundle = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1', 'c71860c77-BwbfSKgy.js');
  assert.ok(fs.readFileSync(bundle, 'utf8').includes('if(!e.ok){try{T('));
});

test('the evidence says the installer was not rebuilt', () => {
  const doc = path.join(ROOT, 'evidence', 'packaged-asar-updated-r648.md');
  assert.ok(fs.existsSync(doc), 'the evidence document is missing');
  const text = fs.readFileSync(doc, 'utf8');
  // Rule 8: an unperformed step must read as unperformed, not be omitted.
  assert.ok(text.includes('不声称安装器已更新'), 'the untouched installer is not declared untouched');
  assert.ok(text.includes('win-unpacked'), 'the runnable artifact is not named');
});
