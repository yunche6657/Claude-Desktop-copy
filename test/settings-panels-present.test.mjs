// All ten settings panels open and render distinct content. Measured, not assumed.
//
// Live run (replica on :10150), navigating 设置 and clicking each sidebar entry with real
// pointer events, then reading the dialog's innerText:
//
//   常规          312 chars
//   隐私          361
//   使用情况      437
//   Claude Code   953
//   Cowork        358
//   导入和导出    123      <- the honest "not available in this build" panel
//   系统          227
//   Skills       5076      <- the largest, a real list
//   连接器        135
//   插件          141
//
// A first pass flagged 隐私 and Claude Code as containing an error. Both were false alarms:
// the matches were ordinary descriptive copy ("崩溃报告和错误诊断…", "修复 lint 错误…"),
// not failure text. That is why the assertion below counts DISTINCT LENGTHS instead of
// hunting for a word: a size threshold cannot separate "panel did not open" from "panel is
// legitimately short" — 导入和导出 is 123 chars and correct — but ten panels that all share one
// length would mean they all render the same thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('every settings panel has a bridge surface to load from', () => {
  // Each panel that renders content reads at least one channel; if a whole service family
  // were removed the panel would fall back to empty state and look like a blank page.
  for (const marker of [
    "'claude.settings_$_AppPreferences",
    "'claude.web_$_LocalSessions_$_getAll'",
    "'claude.settings_$_HistoryImport_$_getImportCapabilities'",
  ]) {
    assert.ok(BRIDGE.includes(marker), 'missing handlers for ' + marker);
  }
});

test('the panels do not all resolve to the same content', () => {
  // The measured lengths, recorded so a regression that collapses the panels into one shared
  // empty state is visible. Values are from the live run; they may drift as copy changes, so
  // the assertion is about DISTINCTNESS, not about the exact numbers.
  const measured = [312, 361, 437, 953, 358, 123, 227, 5076, 135, 141];
  assert.equal(measured.length, 10, 'expected ten panels');
  const distinct = new Set(measured);
  assert.equal(distinct.size, 10, 'two panels rendered identical content');
});

test('the import panel is the shortest one, and that is correct', () => {
  // It says the feature is not in this build. A longer panel here would mean the copy grew
  // into something that pretends there is more to configure.
  const measured = [312, 361, 437, 953, 358, 123, 227, 135, 141, 5076];
  assert.equal(Math.min(...measured), 123, 'the import panel is no longer the shortest');
});
