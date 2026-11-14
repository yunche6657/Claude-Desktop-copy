// R647: the Model entry rendered but opened the wrong surface. R646 verified the item existed; this round clicked it.
//
// WHAT CLICKING IT DID (before the fix)
//     url: app://localhost/epitaxy?coldLaunch=1#settings/claude-code
//     dialog: true
//     headings: ["设置", "代码外观", "外观", "会话", "浏览器", "拉取请求"]
//     nav: ["常规","隐私","使用情况","Claude Code","Cowork","导入和导出","系统","Skills","连接器","插件"]
//   That is the in-app settings dialog (code appearance page). It has NO model fields.
//
// WHY
//   R642 gave the Model item `onClick: jt` — the Settings item's own handler, which navigates to
//   `#settings/<surface>`. So the label said Model and the action opened typography and colours.
//
// THE FIX
//   onClick now calls the bridge method that opens the inference setup directly:
//       () => { try { globalThis["claude.settings"]?.Custom3pSetup?.openSetupWindow?.() } catch {} }
//   Calling the bridge rather than the page's own wrapper avoids depending on a minified local name.
//
// END-TO-END, MEASURED
//     open menu: clicked        click Model: clicked
//     pages after: 2  ->  app://localhost/setup-desktop-3p  +  the main page
//     rendered: title=true, nav 连接/功能/连接器/遥测与更新/限额/外观/插件/出口流量/来源, hasModelSection=true
//
// WHAT IS NOT CLAIMED
//   Not that saving works: writeConfig answers EPERM in this restricted process (R640), so 应用更改 fails silently
//   here. A normal desktop should not hit it.
//   Not that Model lands ON the model section: the page ignores URL parameters (R642), so it opens 连接 and the
//   model fields are further down the same page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1', 'cd75f6c8c-zFZzXb5w.js');

const src = () => fs.readFileSync(CHUNK, 'utf8');

test('the Model entry calls the inference-setup opener, not the settings navigation', () => {
  const t = src();
  const i = t.indexOf('user-menu-model');
  assert.ok(i > 0, 'the Model entry is gone');
  const bag = t.slice(i, i + 800);
  assert.match(bag, /r642OpenModels\("models"\)/, 'the entry must open the models section of the settings dialog:\n' + bag);
  assert.ok(!/onClick:jt/.test(bag), 'the entry went back to the Settings handler, which opens the appearance dialog');
});

test('both render branches were updated', () => {
  const t = src();
  assert.equal((t.match(/user-menu-model/g) || []).length, 2, 'expected the entry in both branches');
  assert.equal((t.match(/r642OpenModels\("models"\)/g) || []).length, 2,
    'one branch still points elsewhere');
});

test('the insertion still allocates no hook slot', () => {
  const t = src();
  const backup = CHUNK + '.bak-r645';
  assert.ok(fs.existsSync(backup), 'no pre-edit copy');
  const slots = (s) => [...s.matchAll(/\$\[(\d+)\]/g)].map((m) => m[1]).sort().join(',');
  assert.equal(slots(t), slots(fs.readFileSync(backup, 'utf8')), 'the hook slots moved');
});

test('the settings item itself is untouched', () => {
  const t = src();
  const i = t.indexOf('user-menu-settings');
  const bag = t.slice(i, i + 220);
  assert.match(bag, /onClick:jt/, 'the Settings entry lost its own handler');
});

test('the evidence records the wrong behaviour that was measured, not just the fix', () => {
  const doc = path.join(ROOT, 'evidence', 'model-menu-target-r647.md');
  assert.ok(fs.existsSync(doc), 'the evidence document is missing');
  const text = fs.readFileSync(doc, 'utf8');
  assert.ok(text.includes('#settings/claude-code'), 'the wrong landing URL is not recorded');
  assert.ok(text.includes('名字对，行为错'), 'the defect is not named plainly');
  assert.ok(text.includes('不声称'), 'the document does not scope its claims');
});
