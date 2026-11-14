// The application menu must only install accelerators this platform can fire.
//
// Measured on this host before the fix: of the 18 installed accelerators exactly two were
// macOS-only — Hide (Command+H) and Hide Others (Command+Alt+H) — because the menu template
// listed the macOS roles hide / hideOthers / unhide unconditionally. On Windows those
// render as ordinary items whose accelerators can never fire.
//
// After gating them behind process.platform === 'darwin':
//   total 16, macOS-only 0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'app-menu.cjs'), 'utf8');

test('the macOS-only roles are gated on darwin', () => {
  const at = SRC.indexOf("platform === 'darwin'");
  assert.ok(at > 0, 'the menu never checks the platform, so macOS roles are added everywhere');
  const block = SRC.slice(Math.max(0, at - 400), at + 400);
  for (const role of ['hide', 'hideOthers', 'unhide']) {
    assert.ok(block.includes(role), 'the darwin branch omits ' + role);
  }
});

test('no accelerator string is macOS-only', () => {
  const bare = [...SRC.matchAll(/accelerator:\s*'(Command\+[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(bare, [], 'macOS-only accelerators in the template: ' + bare.join(', '));
});

test('the explicit accelerators use a cross-platform modifier', () => {
  // Most accelerators come from Electron roles; the ones this file spells out must work
  // on Windows too, so CmdOrCtrl (not Command) is the only correct prefix.
  const explicit = [...SRC.matchAll(/accelerator: '([^']*)'/g)].map((m) => m[1]);
  assert.ok(explicit.length >= 2, 'expected explicit accelerators, found ' + explicit.length);
  for (const acc of explicit) {
    assert.ok(/^(CmdOrCtrl|CommandOrControl)/.test(acc), 'not cross-platform: ' + acc);
  }
});
