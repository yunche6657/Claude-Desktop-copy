// The Files service must not ask for approval in a mode that promises never to ask.
//
// Round 184 fixed this in tool-approval.cjs (the agent's tool path). The Files service has
// its own four entry points, and two of them (write, replace) opened a consent prompt for
// ANY non-ALLOW verdict — including dontAsk. So the same user-visible defect existed on a
// second path: pick "Don't ask", then get asked to approve every file write.
//
// After routing through classify():
//   dontAsk + write   -> { ok: false, denied: true, decision: 'denied-by-mode' }, no prompt
//   ask     + write   -> still prompts (there is someone to answer)
//
// read and previewWrite already refused outright (they throw), which is correct for both
// DENY and ASK because those surfaces have no consent UI at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'main-services.cjs'), 'utf8');

/** The body of the `write` entry point, up to the next service method. */
function writeBody() {
  const start = SRC.indexOf('      write: async (_event, filePath, content) => {');
  assert.ok(start > 0, 'the write entry point is missing');
  const end = SRC.indexOf('      replace: async (_event, filePath, oldText, newText) => {', start);
  assert.ok(end > start, 'could not delimit the write entry point');
  return SRC.slice(start, end);
}

test('write refuses dontAsk before it can open a consent prompt', () => {
  const body = writeBody();
  assert.match(body, /classify\(permissionMode\(\), ACTIONS\.EDIT\) === DECISIONS\.DENY/,
    'write does not distinguish DENY from ASK');
  const denyAt = body.indexOf('DECISIONS.DENY');
  const askAt = body.indexOf('consent.ask');
  assert.ok(denyAt > 0 && askAt > 0, 'one of the two branches is missing');
  assert.ok(denyAt < askAt, 'the consent prompt is reachable before the DENY check');
});

test('the DENY branch returns a denial rather than throwing', () => {
  // A throw would surface as a tool failure with no structured reason; the renderer reads
  // { ok:false, denied:true } to show the refusal inline.
  const body = writeBody();
  assert.match(body, /return \{ ok: false, denied: true, decision: 'denied-by-mode'/);
});

test('replace has the same DENY guard as write', () => {
  const start = SRC.indexOf('      replace: async (_event, filePath, oldText, newText) => {');
  assert.ok(start > 0, 'the replace entry point is missing');
  const block = SRC.slice(start, start + 1400);
  assert.match(block, /DECISIONS\.DENY/, 'replace does not check for DENY');
  const denyAt = block.indexOf('DECISIONS.DENY');
  const askAt = block.indexOf('consent.ask');
  assert.ok(denyAt < askAt, 'replace can prompt before checking DENY');
});

test('read and previewWrite refuse every non-ALLOW verdict outright', () => {
  // These surfaces have no consent UI, so ASK and DENY are both a plain refusal.
  for (const marker of ['      read: (_event, filePath) => {', '      previewWrite: (_event, filePath, content) => {']) {
    const at = SRC.indexOf(marker);
    assert.ok(at > 0, 'missing entry point: ' + marker.trim());
    const block = SRC.slice(at, at + 400);
    assert.match(block, /if \(policy\.prompt\) throw new Error\(policy\.reason\)/,
      'the refusal no longer carries the reason');
  }
});

test('classify is imported, not re-implemented locally', () => {
  // A local copy would drift from permissions.cjs and reintroduce the bug.
  assert.match(SRC, /const \{[^}]*classify[^}]*\} = require\('\.\/permissions\.cjs'\)/);
  assert.equal((SRC.match(/function classify/g) || []).length, 0, 'a local classify shadows the shared one');
});
