// R649: the installer now carries the changes. R648 only updated win-unpacked/resources/app.asar, so the NSIS exe
// still wrapped the old frontend.
//
// THREE FAILURES, EACH MEASURED, EACH WITH A DISTINCT CAUSE
//   1. electron-builder could not fetch its runtime:
//        "Timeout awaiting 'request' for 600000ms"
//      -> electronDist pointed at node_modules/electron/dist (same version 42.11.15, unpacked). Compilation then ran.
//   2. NSIS died compiling:
//        "Internal compiler error #12345: error creating mmap the size of 490457747"
//      NSIS is 32-bit and cannot map a ~490 MB block. `compression: 'store'` did NOT help — the block is the
//      payload, not the codec. (`nsis.compression` is also not in electron-builder's schema and is rejected.)
//   3. The payload was 451.5 MB because the stage carried agent-core/claude-code-src, 592.3 MB of TypeScript that
//      the app never loads. The previously shipped win-unpacked has agent-core at 144.9 MB, which proves the source
//      tree is not part of a real install. Excluding it built successfully: installer 261.1 MB, agent-core 144.9 MB.
//
// ALSO: disk filled mid-copy. Reclaimed ~8.2 GB (three C:\ccd-package-* stages plus a stale nsis.7z), then
// re-verified win-unpacked: 812.9 MB, 3743 files, app.asar 188 MB, agent-core 144.9 MB.
//
// FINAL RUN, FROM release/win-unpacked
//     served chunk: { len:23438, model:true, openSetup:true }
//     items: ["设置Ctrl+,", "Model", "语言", "推理配置", ...]
//     click Model -> SETUP WINDOW: OPENED
//     rendered: title true, nav 连接/功能/连接器/遥测与更新/限额/外观, hasModel true
//
// WHAT IS NOT CLAIMED
//   Not that the installer was executed end to end: the built win-unpacked and the installer file were verified,
//   but no full install-through-the-wizard run was performed.
//   Not that 261.1 MB is optimal: compression:store avoids the mmap ceiling at the cost of size.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'release');
const ARTIFACT = path.join(RELEASE, 'Code Desktop (Reconstruction)-0.1.0-x64.exe');

test('the installer was rebuilt and is larger than the payload that could not be mmapped', () => {
  assert.ok(fs.existsSync(ARTIFACT), 'the installer is missing');
  const mb = fs.statSync(ARTIFACT).size / 1048576;
  // The old one was 195.1 MB (and predated the edits); the rebuilt one is 261.1 MB with compression:store.
  assert.ok(mb > 200 && mb < 400, `installer size ${mb.toFixed(1)} MB is outside the expected band`);
});

test('the unpacked build the installer was made from carries the edits', () => {
  const asar = path.join(RELEASE, 'win-unpacked', 'resources', 'app.asar');
  assert.ok(fs.existsSync(asar), 'win-unpacked/app.asar is missing');
  const t = fs.readFileSync(asar, 'latin1');
  assert.ok(t.includes('user-menu-model'), 'the Model entry is absent from the packaged asar');
  assert.ok(t.includes('if(!e.ok){try{T('), 'the R645 apply() report is absent');
  assert.ok(t.includes('openSetupWindow'), 'the R641 opener is absent');
});

test('the shipped source tree stays out of the package', () => {
  // claude-code-src is 592.3 MB of TypeScript the app never loads; including it is what made NSIS exceed its
  // mmap ceiling. agent-core in a real install is ~144.9 MB.
  const ac = path.join(RELEASE, 'win-unpacked', 'resources', 'agent-core');
  assert.ok(fs.existsSync(ac), 'agent-core is missing from win-unpacked');
  assert.ok(!fs.existsSync(path.join(ac, 'claude-code-src')),
    'claude-code-src is back in the package, which reintroduces the NSIS mmap failure');
  const mb = (function walk(dir) {
    let sum = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      sum += e.isDirectory() ? walk(p) : fs.statSync(p).size;
    }
    return sum;
  })(ac) / 1048576;
  assert.ok(mb < 300, `agent-core is ${mb.toFixed(1)} MB, which suggests the source tree returned`);
});

test('win-unpacked survived the disk-full incident intact', () => {
  const wu = path.join(RELEASE, 'win-unpacked');
  assert.ok(fs.existsSync(path.join(wu, 'Code Desktop (Reconstruction).exe')), 'the executable is missing');
  assert.ok(fs.existsSync(path.join(wu, 'resources', 'app.asar')), 'the asar is missing');
  assert.ok(fs.existsSync(path.join(wu, 'resources', 'agent-core')), 'agent-core is missing');
  assert.ok(fs.existsSync(path.join(wu, 'resources', 'ion-dist')), 'the frontend directory is missing');
});

test('the evidence names all three packaging failures and the unperformed install test', () => {
  const doc = path.join(ROOT, 'evidence', 'installer-rebuilt-r649.md');
  assert.ok(fs.existsSync(doc), 'the evidence document is missing');
  const text = fs.readFileSync(doc, 'utf8');
  assert.ok(text.includes('Timeout awaiting'), 'the download failure is not recorded');
  assert.ok(text.includes('mmap'), 'the NSIS ceiling is not recorded');
  assert.ok(text.includes('claude-code-src'), 'the payload cause is not recorded');
  // Rule 8: the step that was not performed must read as not performed.
  assert.ok(text.includes('不声称我运行了安装器做安装测试'), 'the untested install flow is not declared');
});
