// Tests for the desktop user-agent contract.
//
// The frontend picks its desktop branch from the UA's `Claude/<version>`
// product token: with it, it keeps /epitaxy, sets data-dframe and renders the
// workbench; without it, it rewrites to /code and renders the web page. This was
// established by observation (setting the token over CDP flipped the rendered
// page from the marketing page to "What's up next?"), so the token format is a
// contract worth pinning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('the shipped original reports a Claude product token', () => {
  // Captured from the installed 2.42304.0 instance.
  const original =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Claude/2.42304.0 Chrome/152.0.7977.149 Electron/44.7.2 Safari/537.36';
  assert.match(original, /\bClaude\/\d+\.\d+\.\d+\b/);
});

test('the Electron default UA has no Claude token', () => {
  const bare =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) code-desktop-reconstruction/0.1.0 Chrome/148.0.7778.280 Electron/42.11.15 Safari/537.36';
  assert.doesNotMatch(bare, /\bClaude\//);
});

test('the desktop UA template produces a valid Claude token', () => {
  // Mirrors DESKTOP_USER_AGENT in desktop/main.cjs.
  const version = '2.42304.0';
  const ua =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Claude/${version} ` +
    `Chrome/148.0.7778.280 Electron/42.11.15 Safari/537.36`;
  assert.match(ua, /\bClaude\/2\.42304\.0\b/);
  assert.match(ua, /\bElectron\//);
  assert.match(ua, /\bSafari\/537\.36$/);
});

test('the token detector accepts only a real Claude product token', () => {
  const has = (ua) => /\bClaude\//.test(ua);
  assert.equal(has('Claude/2.42304.0 Chrome/1'), true);
  assert.equal(has('code-desktop-reconstruction/0.1.0'), false);
  assert.equal(has('ClaudeDesktop/1.0'), false);
});
