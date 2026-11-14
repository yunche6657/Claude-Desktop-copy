// R570: 19 assertions in this repo pin a CONTROL-FLOW spelling inside a .cjs file. Audited, and only some are hazards.
//
// THE AUDIT
//   `tools/text-assertion-audit.cjs` separates assertions about source text into two kinds:
//
//       wiring   149   a call, a path, an identifier whose PRESENCE is the fact
//       control   19   a branch, a return, a throw, a ternary
//
//   Wiring assertions are legitimate by construction: "does main.cjs pass canUseTool" is a fact about main.cjs and
//   nothing else can assert it. Control-flow assertions are the movable ones, and R569 produced the worked example —
//   `assert.match(main, /if \(unavailable\.available\) throw error;/)` failed the moment the line moved six lines into a
//   module, with behaviour unchanged.
//
// THE AUDIT MADE ITS OWN MISTAKE FIRST, AND IT WAS THE MISTAKE IT EXISTS TO PREVENT
//   The first run put `rewind-refused-prompt.test.mjs:62` at the top of the hazard list:
//
//       const source = fs.readFileSync(PINNED_ION_DIST + '/assets/v1/…js', 'utf8');
//       assert.match(source, /if\(!n\|\|e\.type!=="local"\)return null/);
//
//   That IS control flow, and asserting it as text is CORRECT: the subject is a shipped artefact this project does not
//   edit. Extracting it is impossible; pinning its spelling is the point. Counting it as a hazard would have sent the
//   next round to rewrite a test that was doing the right thing.
//
//   Excluded by where the bytes come from: PINNED_ION_DIST, ion-dist, ccd-ref, agent-core/claude-code/dist, .asar,
//   .vite/build. 187 -> 168 assertions after the exclusion.
//
// THE THREE CHECKED BY HAND, AND WHY THEY STAY AS TEXT
//   `fallback-shapes-live.test.mjs:101-102` pins an ORDER, not a decision: two `if (/…$/.test(frag)) return []` lines
//   must appear in `bridge-services.cjs` before the generic rule. The comment says so — "they must be checked BEFORE the
//   generic /Sessions$/ rule". A function cannot assert relative order inside another function; the text can.
//
//   `agent-config-guards.test.mjs:74` pins `if (error instanceof AgentError) throw error;` inside a fetch catch. This is
//   the closest to a real hazard: it is a decision, and it sits inside .cjs code that could be extracted the way
//   `fallbackDecision` was. It stays for now because the catch is inside a larger async function with no seams; the
//   assertion is at least wrong-loudly (it fails if the line moves) rather than wrong-silently.
//
//   `bridge-vs-composer-r472.test.mjs:149` pins `useFrontend ? FRONTEND_URL : origin`. A ternary whose two arms are both
//   module constants; extracting it would move one expression for no gain, and the assertion would fail loudly.
//
// SO: THE HAZARD IS NOT "TEXT ASSERTION", IT IS "SILENTLY SURVIVING"
//   Every one of the 19 fails loudly if its line moves. The failure mode that actually costs something is the other one:
//   a pattern that keeps matching after the logic around it changed — a dead branch, a copied condition, a comment. None
//   of the 19 is in that state today, and the audit cannot tell.
//
// WHAT IS NOT CLAIMED
//   Not that 19 is stable: the detector requires a regex literal in an `assert.match`-shaped call, so a pattern built by
//   `new RegExp` and passed separately is invisible.
//   Not that these should be rewritten: three were read and two are better as text. The list exists so the next extraction
//   knows which assertions will complain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'text-assertion-audit.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the audit failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('tests that read the OFFICIAL bundle are not counted as refactor hazards', () => {
  // The audit's own first mistake: pinning a shipped artefact's spelling is correct, not a hazard.
  const d = report();
  for (const row of d.rows) {
    const text = fs.readFileSync(path.join(ROOT, 'test', row.file), 'utf8');
    assert.ok(!/PINNED_ION_DIST|ion-dist|ccd-ref|\.asar/.test(text),
      `${row.file} reads official material but is listed as a hazard`);
  }
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /function readsOfficial/, 'the exclusion is gone');
  assert.match(src, /Counting it as a refactor hazard would have sent the next round to rewrite a test/,
    'the reason for the exclusion is not recorded');
});

test('the split is reported, not just the hazard count', () => {
  const d = report();
  assert.ok(d.sourceAssertions > 50, `only ${d.sourceAssertions} source assertions found`);
  assert.equal(d.controlFlow + d.wiring, d.sourceAssertions, 'the split does not sum');
  assert.ok(d.wiring > d.controlFlow,
    `wiring is ${d.wiring} and control ${d.controlFlow}: the category boundaries inverted`);
});

test('every control-flow row is an assertion about a source file', () => {
  const d = report();
  for (const row of d.rows.filter((r) => r.control)) {
    const text = fs.readFileSync(path.join(ROOT, 'test', row.file), 'utf8');
    assert.match(text, /readFileSync\(|read\(ROOT,/, `${row.file} does not read a source file`);
    assert.ok(row.pattern.length > 0, `${row.file}:${row.line} has no pattern recorded`);
  }
});

test('the order-pinning assertion is listed, because a function cannot assert relative order', () => {
  const d = report();
  const rows = d.rows.filter((r) => r.file === 'fallback-shapes-live.test.mjs');
  assert.equal(rows.length, 2, 'the two order-pinning assertions are not both listed');
  // And the comment that explains why is still there.
  const text = fs.readFileSync(path.join(ROOT, 'test', 'fallback-shapes-live.test.mjs'), 'utf8');
  assert.match(text, /must be checked BEFORE the generic/, 'the reason this stays as text is gone');
});

test('the audit says each listed failure is a loud one, not a silent one', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /whose subject can MOVE/, 'the output no longer says what the rows have in common');
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /fail LOUDLY|fails loudly|wrong-loudly/i, 'the loud-versus-silent distinction is not recorded');
});

test('a pattern built by new RegExp is not claimed to be covered', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /new RegExp` and passed separately is invisible|is invisible/,
    'the limitation of the detector is not stated');
});
