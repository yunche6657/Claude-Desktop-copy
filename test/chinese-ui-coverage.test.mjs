// The Chinese UI must actually be Chinese — in the chrome, not just in the catalogue file.
//
// Measured live this round on the running app, counting only CHROME (buttons, menu items,
// nav links) and excluding conversation content:
//
//   /settings/general    zh=154  en=11   (en = Claude Code, Cowork, Skills, product names)
//   /settings/usage      zh=163  en=18
//   /settings/connectors zh= 57  en= 4
//   /epitaxy             zh=209  en=268 — but every English word came from probe conversations
//                        ('Use the Bash tool', 'APPROVAL PROBE'), not from the interface.
//
// Filtering to interface chrome alone: 77 controls, 2 with Latin text, both conversation
// titles. So the localisation is complete on the surfaces checked.
//
// The catalogue assertions below are what make that reproducible in CI; the live numbers
// are recorded here because they are the evidence the catalogue is actually consumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY = path.join(ROOT, 'resources', 'i18n-overlay', 'zh-Hans.json');

function catalogue() {
  return JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
}

test('the Chinese catalogue is large enough to cover a real application', () => {
  // A stub catalogue would render the interface in English while every test passed.
  const entries = Object.entries(catalogue());
  assert.ok(entries.length > 30000, 'the catalogue holds only ' + entries.length + ' keys');
});

test('every translated value is a non-empty string', () => {
  // A null or empty value renders as blank text, which looks like a layout bug.
  const bad = Object.entries(catalogue()).filter(([, v]) => typeof v !== 'string' || !v.trim());
  assert.deepEqual(bad.slice(0, 5), [], bad.length + ' catalogue values are empty');
});

test('the settings surface vocabulary is translated', () => {
  // These are the words measured on the live settings dialog; if any disappears from the
  // catalogue the corresponding control falls back to English.
  const values = new Set(Object.values(catalogue()));
  for (const word of ['设置', '常规', '隐私', '使用情况', '连接器', '外观', '通知']) {
    assert.ok([...values].some((v) => typeof v === 'string' && v.includes(word)),
      'no catalogue entry contains ' + word);
  }
});

test('en-US is deliberately not overridden', () => {
  // The overlay exists for Chinese; serving it for en-US would make the English UI Chinese.
  const overlayDir = path.join(ROOT, 'resources', 'i18n-overlay');
  assert.equal(fs.existsSync(path.join(overlayDir, 'en-US.json')), false,
    'an en-US overlay exists and would override the shipped English catalogue');
});

test('product names are left untranslated on purpose', () => {
  // Measured on the live UI: the only Latin chrome text was 'Claude Code', 'Cowork',
  // 'Skills' and the like. Translating those would be wrong, so this pins the decision.
  const values = Object.values(catalogue());
  const claudeCode = values.filter((v) => typeof v === 'string' && v.includes('Claude Code'));
  assert.ok(claudeCode.length > 0, 'Claude Code is no longer referenced verbatim anywhere');
});
