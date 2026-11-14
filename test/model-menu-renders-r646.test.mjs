// R646: the Model menu entry renders. The previous rounds could not see it because they clicked the wrong element.
//
// WHAT WAS MEASURED (real Electron, screenshot kept at evidence/assets/r646-menu-open.png)
//     footer trigger: {"cx":144,"cy":778,"w":271,"h":28,"text":"Administrator·Gateway"}
//     in-page click: clicked
//     -> menus: 1
//        items: ["设置Ctrl+,", "Model", "语言", "推理配置", "查看更新日志", "了解更多", "退出登录"]
//        model: true, settings: true
//
// WHY FOUR ROUNDS MISSED IT
//   `(105, 272)` resolves to a button whose text is `Administrator`, so a text match found it every time. But that
//   button has aria-expanded="true" and NO aria-haspopup — it is the sidebar's group expander, not the account
//   menu. The real trigger is the footer status bar `Administrator · Gateway` at (8,764), 271x28, with
//   aria-haspopup="menu". Nothing ever clicked it.
//
//   The correct selector is therefore aria-driven, not text-driven:
//       [...document.querySelectorAll('[aria-haspopup="menu"]')]
//         .find(x => /Administrator/.test(x.textContent) && x.getBoundingClientRect().y > 700)
//
//   A plain in-page .click() opens it — no CDP input needed. That refutes the R643 conclusion that this popover
//   ignores synthetic input. Recorded as rule 9 in evidence/MEASUREMENT-CHECKLIST.md.
//
// WHAT IS NOT CLAIMED
//   Not that the Model item was clicked through to its destination: its onClick is `jt`, which reaches
//   openSetupWindow, verified separately in R641. Menu renders + handler verified is strong, but not one recording.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the menu chunk still carries the Model entry next to Settings', () => {
  const f = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1', 'cd75f6c8c-zFZzXb5w.js');
  assert.ok(fs.existsSync(f), 'the menu chunk is missing');
  const src = fs.readFileSync(f, 'utf8');
  assert.ok(src.includes('user-menu-model'), 'the Model entry is gone');
  assert.ok(src.includes('user-menu-settings'), 'the Settings entry is gone');
  // Both ride one fragment, which is why the menu renders them adjacently.
  const i = src.indexOf('user-menu-model');
  const before = src.slice(Math.max(0, i - 600), i);
  assert.ok(before.includes('children:['), 'the entries are no longer co-rendered in one fragment');
});

test('the Model entry carries a click handler at all', () => {
  // R646 asserted this entry used the Settings handler (onClick:jt). R647 measured that handler landing on
  // #settings/claude-code — the appearance dialog with no model fields — so the entry was repointed at
  // openSetupWindow. What survives from R646 is only that the item renders with some handler attached.
  const src = fs.readFileSync(path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1', 'cd75f6c8c-zFZzXb5w.js'), 'utf8');
  const i = src.indexOf('user-menu-model');
  assert.match(src.slice(i, i + 260), /onClick:/, 'the Model entry has no click handler');
});

test('the locator this round proved is recorded, not the one that failed', () => {
  const doc = path.join(ROOT, 'evidence', 'model-menu-renders-r646.md');
  assert.ok(fs.existsSync(doc), 'the evidence document is missing');
  const text = fs.readFileSync(doc, 'utf8');
  assert.ok(text.includes('aria-haspopup'), 'the working locator is not written down');
  assert.ok(text.includes('y > 700'), 'the position filter is not written down');
  // And the retracted claim must be named as retracted.
  assert.ok(text.includes('这句话是错的'), 'the earlier wrong conclusion is not marked as retracted');
});

test('the checklist gained the rule this round earned', () => {
  const f = path.join(ROOT, 'evidence', 'MEASUREMENT-CHECKLIST.md');
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.includes('## 9.'), 'rule 9 was not appended');
  assert.ok(text.includes('aria-haspopup'), 'rule 9 does not name the attribute that disambiguates the target');
  assert.ok(text.includes('R646'), 'rule 9 does not cite the round that established it');
});

test('the screenshot that shows the entry exists', () => {
  const shot = path.join(ROOT, 'evidence', 'assets', 'r646-menu-open.png');
  assert.ok(fs.existsSync(shot), 'the screenshot is missing');
  assert.ok(fs.statSync(shot).size > 10000, 'the screenshot looks truncated');
});
