// Test tooling must not depend on the UI language.
//
// Every probe used to locate controls by their aria-label text ('Send', 'Start task',
// 'Allow', 'Deny'). That is correct only while the UI is English. Once the app ran in
// Chinese the labels became '发送' / '允许', the lookups returned undefined, and the probes
// reported "send blocked" / "no approval card" while the controls were present and enabled.
// Six rounds of the project's history were spent chasing probe artefacts as product bugs.
//
// The stable hooks are data-testid (set by the app, never localised) and data the app
// carries regardless of locale (a file path, a tool name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBES = path.join(ROOT, 'tools', 'probes');

function codeLines() {
  const out = [];
  for (const name of fs.readdirSync(PROBES)) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const lines = fs.readFileSync(path.join(PROBES, name), 'utf8').split(String.fromCharCode(10));
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      // Comments explain the old approach and are allowed to name the labels.
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      out.push({ where: name + ':' + (index + 1), line });
    });
  }
  return out;
}

test('no probe compares an aria-label to an English UI string', () => {
  const offenders = codeLines()
    .filter((c) => /aria-label/.test(c.line) && /===\s*'[A-Za-z]/.test(c.line))
    .map((c) => c.where);
  assert.deepEqual(offenders, [], 'locale-dependent label comparisons: ' + offenders.join(', '));
});

test('no probe decides presence by an English UI phrase', () => {
  // Presence must come from a testid, a data field, or a locale-tolerant pattern.
  const words = ['Send', 'Start task', 'Stop', 'Allow', 'Deny', 'Settings', 'Trust workspace'];
  const offenders = codeLines()
    .filter((c) => words.some((w) => c.line.includes("includes('" + w + "')")))
    .map((c) => c.where);
  assert.deepEqual(offenders, [], 'English-phrase presence checks: ' + offenders.join(', '));
});

test('the send button is addressed by testid everywhere it is clicked', () => {
  // A click path that finds the button by label cannot work in a non-English UI.
  // Only lines that LOOK UP a button matter; a console.log that prints a label does not.
  const sendClickers = codeLines()
    .filter((c) => /querySelector|querySelectorAll/.test(c.line))
    .filter((c) => /'Send'|"Send"|Start task/.test(c.line));
  const bad = sendClickers.filter((c) => !c.line.includes('code-prompt-send')).map((c) => c.where);
  assert.deepEqual(bad, [], 'send lookups that skip the testid: ' + bad.join(', '));
});

test('the shared selector module exists and is the single source', () => {
  const helper = fs.readFileSync(path.join(PROBES, '_ui-selectors.mjs'), 'utf8');
  assert.ok(helper.includes('data-testid="code-prompt-send"'));
  assert.ok(helper.includes('export async function clickSend'));
});