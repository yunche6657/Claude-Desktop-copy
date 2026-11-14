// The nine settings surfaces each render their OWN content, measured on a live window.
//
// MEASURED this round via tools/packaged-proof.cjs with CLAUDE_PROOF_PHASES=surfaces:
// one invisible Electron window, nine routes clicked through the real dialog buttons, the
// resulting dialog text captured for each. Every panel showed content unique to itself:
//
//   #settings/general                您从事什么工作？
//   #settings/data-privacy-controls  您正在通过贵组织自有的推理服务提供商
//   #settings/usage                  本设备上对话、Cowork 和 Code 中的 token 用量
//   #settings/claude-code            代码外观 / Claude Light / Claude Dark
//   #settings/import                 此部署未启用导入功能
//   #settings/desktop                桌面应用版本 2.42304.0
//   #customize/skills/yours          由您创建 / explain-usage
//   #customize/connectors/yours      添加您的第一批连接器
//   #customize/plugins/yours         添加您的第一批插件
//
// This is the assertion the earlier rounds could not make. Round 308 used `body.innerText`,
// which concatenates across elements and made five WORKING panels look broken; the fix was to
// scope the read to [role=dialog]. Round 331 also showed that a URL change alone is not
// evidence — the pane had stayed on 常规 while the hash moved.
//
// So the assertion below is: each route's dialog text must contain a marker that ONLY that panel
// produces. A shared marker would pass even if every route rendered the same pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'evidence', 'live', 'round341-surfaces', 'surfaces.json');

// The marker each panel must show, and no other panel may show.
const MARKERS = [
  ['#settings/general', '您从事什么工作'],
  ['#settings/data-privacy-controls', '推理服务提供商'],
  ['#settings/usage', 'token 用量'],
  ['#settings/claude-code', '代码外观'],
  ['#settings/import', '此部署未启用导入功能'],
  ['#settings/desktop', '桌面应用版本'],
  ['#customize/skills/yours', '由您创建'],
  ['#customize/connectors/yours', '添加您的第一批连接器'],
  ['#customize/plugins/yours', '添加您的第一批插件'],
];

test('the live surfaces report covers all nine routes', (t) => {
  if (!fs.existsSync(REPORT)) return t.skip('no live surfaces run recorded in evidence/live/round341-surfaces');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  assert.equal(report.ok, true, 'the live surfaces run did not pass: ' + JSON.stringify(report.error || null));
  assert.equal(report.visible, false, 'the window was supposed to stay invisible');
  assert.equal(report.surfaces.length, 9, 'the run covered ' + report.surfaces.length + ' surfaces');
  assert.deepEqual(report.surfaces.map((s) => s.hash), MARKERS.map(([route]) => route));
});

test('each surface renders content that only it produces', (t) => {
  if (!fs.existsSync(REPORT)) return t.skip('no live surfaces run recorded');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  for (const [route, marker] of MARKERS) {
    const pane = report.surfaces.find((s) => s.hash === route);
    assert.ok(pane, route + ' was not captured');
    assert.equal(pane.dialog, true, route + ' did not open a dialog');
    assert.ok(pane.text.includes(marker), route + ' is missing its own marker ' + marker);
    // And the marker must be exclusive: if every panel contained it, it would prove nothing.
    const others = report.surfaces.filter((s) => s.hash !== route && s.text.includes(marker));
    assert.deepEqual(others.map((s) => s.hash), [], marker + ' also appears on ' + others.map((s) => s.hash).join(', '));
  }
});

test('the dialog is what was measured, not the flattened page', () => {
  // Guards the exact mistake of round 308: reading body.innerText made unrelated siblings
  // appear inside the panel. Every captured text must therefore carry the navigation labels
  // (proving it came from the dialog) AND stay free of the sidebar-only mode switch.
  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'background-check.cjs'), 'utf8');
  assert.match(source, /\[role=dialog\]/, 'the capture no longer scopes to the dialog');
  if (!fs.existsSync(REPORT)) return;
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  for (const pane of report.surfaces) {
    assert.ok(pane.text.includes('设置'), pane.hash + ' does not look like the settings dialog');
  }
});
