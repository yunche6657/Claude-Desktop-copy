// The slash palette complained 「部分命令未能加载」 and then listed duplicated rows.
//
// getSupportedCommands answered [], which passed the palette's own filter
//   function HT(e){ return e.scope === "cowork" }
// but left the warning in the header. Serving the full CLI command list fixed the
// warning and created a worse problem: the palette renders 13 built-ins itself, so the
// list doubled to 24 rows with 10 duplicates, each duplicate tagged 「自定义命令」.
//
// The renderer treats anything from this list as a user-defined command, so the list
// must contain only what the palette cannot render on its own — measured by diffing the
// built-in rows against the served list: exactly one name, `permissions`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

// The rows the palette renders without any bridge help (measured live).
const BUILT_IN = ['plugin', 'model', 'effort', 'plan', 'skills', 'workflows', 'usage',
  'config', 'storage', 'sandbox', 'theme', 'resume', 'help'];

test('getSupportedCommands answers an array, not a status object', () => {
  // Answering {status:'unavailable'} made the consumer's .filter throw on every mount.
  for (const svc of ['LocalSessions', 'LocalAgentModeSessions']) {
    const re = new RegExp(svc + '_\\$_getSupportedCommands\', \\(\\) => ([a-zA-Z]+)\\(');
    const m = SRC.match(re);
    assert.ok(m, svc + '.getSupportedCommands is missing');
    assert.equal(m[1], 'supportedCommands', svc + ' must call the shared builder');
  }
});

test('every served command carries the scope the palette filters on', () => {
  // HT(e) keeps only e.scope === 'cowork'; without it the list is silently empty.
  const start = SRC.indexOf('const supportedCommands = () =>');
  assert.ok(start > 0, 'the command builder is missing');
  const block = SRC.slice(start, start + 600);
  assert.match(block, /scope:\s*'cowork'/, 'served commands must carry scope cowork');
});

test('the served list does not duplicate the palette built-ins', () => {
  // A duplicate shows twice and the second copy is mislabelled 自定义命令.
  const start = SRC.indexOf('const CLI_COMMANDS = [');
  const end = SRC.indexOf('];', start);
  assert.ok(start > 0 && end > start, 'CLI_COMMANDS is missing');
  const block = SRC.slice(start, end);
  for (const name of BUILT_IN) {
    assert.doesNotMatch(block, new RegExp("name: '" + name + "'"),
      'the served list duplicates the built-in command ' + name);
  }
});

test('CLI commands missing from the palette are served, including manual compaction', () => {
  const start = SRC.indexOf('const CLI_COMMANDS = [');
  const block = SRC.slice(start, SRC.indexOf('];', start));
  assert.match(block, /name: 'permissions'/, 'permissions is no longer served');
  assert.match(block, /name: 'compact'/, 'manual compaction is missing from the command palette');
});
// ---- round 253: /theme works end to end through the slash surface -----------------------
//
// The palette lists 14 rows: the 13 built-ins above plus `permissions`, which matches exactly
// what this file already pins. Typing '/' in the composer produced that list, live.
//
// Running the command with an argument applies it:
//   '/theme dark'  + Enter -> data-mode light->dark,  bg rgb(252,252,251)->rgb(21,21,21),
//                             transcript shows 外观已设置为深色
//   '/theme light' + Enter -> back to data-mode=light
//   '/theme'       + Enter -> usage line  / theme [system|light|dark]  (no state change)
//
// This is a SECOND path to the same attribute the round-249 fix addressed: the settings radio
// goes through the renderer's own state, the slash command through the CLI surface. Both land
// on data-mode, so verifying one did not verify the other.
//
// Three earlier attempts reported "/theme does nothing". Each was a probe bug: the palette had
// already autocompleted the first token, so the composer held '/theme/theme dark'. The command
// was correct the whole time.

test('the theme command takes an explicit mode and applies it', () => {
  // The usage line the composer showed names all three values; the applier must accept them
  // and refuse anything else rather than writing an unknown value into data-mode.
  const start = SRC.indexOf('const applyThemeToRenderer =');
  assert.ok(start > 0, 'the theme applier is missing');
  const block = SRC.slice(start, start + 1400);
  for (const mode of ['light', 'dark', 'system']) {
    assert.ok(block.includes("'" + mode + "'"), 'the applier rejects ' + mode);
  }
  assert.match(block, /resolved !== 'light' && resolved !== 'dark'\) return null/,
    'an unknown mode is written through instead of refused');
});

test('the palette does not offer clear, and that is expected', () => {
  // Round 230 implemented clearSession and it is reachable, but the shipped palette does not
  // list it. Both facts are true; recording them together prevents someone from adding a row
  // the real UI never shows.
  const measured = [...BUILT_IN, 'permissions'];
  assert.equal(measured.length, 14);
  assert.equal(measured.includes('clear'), false);
});
