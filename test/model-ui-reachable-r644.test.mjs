// R644: the model UI is real and reachable, and the route into it is the Gateway banner — not the account popover.
//
// WHAT WAS MEASURED (real Electron, screenshots kept in .tmp during the run)
//   The home surface carries a banner whose text is "您正在使用 Gateway" with an 打开 button. Its handler is a plain
//   button onClick, so `btn.click()` in-page works:
//       banner found: {"hasBanner":true,"buttons":["打开"]}
//       result: clicked
//       setup window: app://localhost/setup-desktop-3p
//       rendered: {"title":true,"nav":["连接","功能","连接器","遥测与更新","限额","外观","插件","出口流量","来源"]}
//
//   This is the answer to the R642/R643 blocker: those rounds could not open the ACCOUNT POPOVER (a Radix
//   DropdownMenu, which ignores synthetic input). The banner is an ordinary button, so no emulation is needed.
//
// THE MODEL SECTION, read from the live DOM of the 连接 page:
//       模型                    (section)
//       测试模型发现            (button)
//       模型发现                (switch) 启动时从 <gateway>/v1/models 自动填充模型选择器
//       在所有可用的地方使用 1M  (switch)
//       模型列表                (section) 覆盖自动发现的模型列表。第一项为默认模型。
//       添加模型                (button)
//       默认模型思考强度        (select)
//       始终以默认模型开始      (switch)
//
// WHAT IS NOT CLAIMED
//   Not that saving works: 添加模型 and 应用更改 both reach writeConfig, and neither was clicked.
//   Not that model discovery fetches: 测试模型发现 was not clicked.
//   Not that the R642 "Model" menu entry renders: still no DOM evidence for it, and this round does not need it —
//   the banner is the working path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V1 = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1');

/** The setup page chunk the route lazy-loads. */
const pageChunk = () => {
  const files = fs.readdirSync(V1).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const t = fs.readFileSync(path.join(V1, f), 'utf8');
    if (t.includes('Configure third-party inference')) return { file: f, text: t };
  }
  return null;
};

test('the setup page chunk still exists and is the one holding the title', () => {
  const found = pageChunk();
  assert.ok(found, 'no chunk carries the Configure third-party inference title');
  assert.match(found.file, /^c71860c77-/, 'the setup page moved to an unexpected chunk');
});

test('the route that reaches it is declared in the bundle', () => {
  const files = fs.readdirSync(V1).filter((f) => f.endsWith('.js'));
  let route = null;
  for (const f of files) {
    const t = fs.readFileSync(path.join(V1, f), 'utf8');
    if (t.includes('path:"setup-desktop-3p"')) { route = f; break; }
  }
  assert.ok(route, 'the setup-desktop-3p route is gone');
});

test('the model controls are declared where the page can render them', () => {
  // The labels live in the setup chunk or in the schema chunk it imports; either is fine, absence is not.
  const found = pageChunk();
  assert.ok(found);
  const schemaPath = path.join(V1, 'c6f6cf4c2-DnfurqXo.js');
  const haystack = found.text + (fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf8') : '');
  for (const key of ['inferenceModels', 'inferenceGatewayBaseUrl', 'inferenceGatewayApiKey']) {
    assert.ok(haystack.includes(key), `${key} is declared nowhere, so the model surface lost a field`);
  }
});

test('the bridge opener the banner ends up calling is implemented', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.ok(/openSetupWindow',\s*\(\)\s*=>/.test(bridge), 'openSetupWindow is gone');
  assert.ok(bridge.includes('setup-desktop-3p'), 'the opener targets the wrong route');
  assert.ok(bridge.includes("path.join(__dirname, 'preload-frontend.cjs')"),
    'the setup window lost its preload, so the page would render without a bridge');
});

test('the evidence states the negative results rather than implying success', () => {
  const doc = path.join(ROOT, 'evidence', 'model-ui-reachable-r644.md');
  assert.ok(fs.existsSync(doc), 'the evidence document is missing');
  const text = fs.readFileSync(doc, 'utf8');
  // MEASUREMENT-CHECKLIST rule 8: a negative result must read as a negative result.
  assert.ok(text.includes('我没点'), 'the untouched actions are not stated as untouched');
  assert.ok(text.includes('不声称'), 'the document does not scope its claims');
});
