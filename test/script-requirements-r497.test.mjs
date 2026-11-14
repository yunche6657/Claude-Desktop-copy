// R497: reading the twelve largest undocumented scripts replaced "add a comment" with a factual
// precondition list — and turned up a shared bootstrap block across five of them.
//
// WHY THE COMMENT PLAN WAS DROPPED
//   R496 established that none of the 157 unreferenced scripts is named in any evidence file, so a
//   `// produced: …` header would have been invention. The remaining proposal was a one-line description of
//   what each script does. Reading them showed that would also have misled, because these are not
//   self-contained proofs — they are harnesses with hard preconditions, and a sentence about intent implies
//   the script can simply be run.
//
// WHAT THE READING FOUND
//   Five of the twelve share an identical bootstrap:
//       if (process.env.R378_SOURCE_PROOF_CHILD === '1') { ... Module._load patched ... }
//   — proof-hidden-real-ccb-plugin-oauth, proof-hidden-real-ccb-oauth, proof-cli-mcp-main,
//   proof-hidden-identity-notification, proof-hidden-mcp-clear-queue. They re-exec themselves as a child,
//   monkey-patch the module loader, and write fixture files into a workspace. Run from a shell without those
//   things, they do not fail loudly; they look like a no-op. That is the fact worth recording.
//
//   The others carry their own requirements, quoted from their assertions:
//       proof-hidden-history-import-confirm   absolute evidence root required
//                                             existing absolute packaged exe required
//                                             new absolute evidence directory required
//       proof-ccb-unread-r383                 fresh absolute evidence directory required
//       proof-hidden-cowork-memory-r378       self-spawn R378_COWORK_MEMORY_PROOF_CHILD, needs CLAUDE_WORKSPACE
//       proof-ccb-steer-ipc-r384              a positional mode validated against ['held','rekey','now','merge']
//
// A FILTER THAT WAS NEEDED IMMEDIATELY
//   The first version quoted every assertion message, which included `confirmImportedSessionResume`,
//   `sessions.json`, `getTranscript`, `bun/bun.exe` — function names, a file name, a tool name. Those are
//   things the script CALLS or LOOKS FOR, not things the caller must supply. Listing them under "requires:"
//   would have been the same error as a fabricated provenance, one layer down.
//
//   The filter keeps only messages containing a space (a phrase, not an identifier) and a requirement word
//   (required / must / missing / not found / not exist / expected / need). 23 of the 57 undocumented scripts
//   end up with at least one genuinely quoted requirement.
//
// WHAT THIS IS AND IS NOT
//   A text scan over source. It records preconditions it can see; a script with an empty list may still have
//   requirements beyond the scan. It records no intent, and it does not claim any script can be run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'script-requirements.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

test('the scan covers every undocumented script', () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, 'the tool failed:\n' + (result.stderr || '').slice(0, 800));
  const d = JSON.parse(result.stdout);

  // Cross-check against script-docs.cjs's own count, computed independently here.
  const tools = path.join(ROOT, 'tools');
  let undocumented = 0;
  for (const name of fs.readdirSync(tools).filter((n) => /\.(cjs|mjs)$/.test(n))) {
    const text = fs.readFileSync(path.join(tools, name), 'utf8');
    const meaningful = text.split(/\r?\n/).filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (t.startsWith('#!')) return false;
      if (/^['"]use strict['"];?$/.test(t)) return false;
      return true;
    });
    if (!/^(\/\/|\/\*)/.test(meaningful[0] || '')) undocumented += 1;
  }
  assert.equal(d.count, undocumented,
    `the scan reports ${d.count} undocumented scripts, the independent count is ${undocumented}`);
});

test('the shared R378 bootstrap is detected as a group', () => {
  const d = JSON.parse(run(['--json']).stdout);
  const withMarker = d.rows.filter((r) => r.selfSpawn && r.selfSpawn.includes('R378_SOURCE_PROOF_CHILD'));
  assert.ok(withMarker.length >= 5,
    `only ${withMarker.length} scripts carry the R378_SOURCE_PROOF_CHILD marker; the shared bootstrap claim changed`);
  for (const name of ['proof-hidden-real-ccb-plugin-oauth.cjs', 'proof-cli-mcp-main.cjs',
    'proof-hidden-mcp-clear-queue.cjs']) {
    assert.ok(withMarker.some((r) => r.name === name), `${name} no longer reports the marker`);
  }
});

test('quoted requirements are phrases, not identifiers', () => {
  const d = JSON.parse(run(['--json']).stdout);
  const allQuoted = d.rows.flatMap((r) => r.preconditions || []);
  assert.ok(allQuoted.length > 0, 'no requirement was quoted at all');

  for (const q of allQuoted) {
    // An identifier has no space. Quoting one under "requires:" would say the caller must supply a function.
    assert.match(q, /\s/, `quoted requirement is an identifier, not a phrase: ${q}`);
    assert.match(q, /(required|must|missing|not found|not exist|expected|need)/i,
      `quoted requirement has no requirement wording: ${q}`);
  }

  // Specifically: these identifiers appeared in the unfiltered run and must not come back.
  for (const bogus of ['confirmImportedSessionResume', 'sendMessage', 'getTranscript', 'bun/bun.exe']) {
    assert.ok(!allQuoted.includes(bogus), `${bogus} is quoted as a caller requirement`);
  }
});

test('the known preconditions are captured for specific scripts', () => {
  const d = JSON.parse(run(['--json']).stdout);
  const byName = new Map(d.rows.map((r) => [r.name, r]));

  const unread = byName.get('proof-ccb-unread-r383.cjs');
  assert.ok(unread, 'proof-ccb-unread-r383.cjs missing');
  assert.ok(unread.preconditions.some((p) => /fresh absolute evidence directory/.test(p)),
    'the fresh-directory requirement is no longer quoted: ' + JSON.stringify(unread.preconditions));
  assert.ok(unread.argv && unread.argv.validatesSet,
    'the positional-mode validation is no longer detected');

  const steer = byName.get('proof-ccb-steer-ipc-r384.cjs');
  assert.ok(steer, 'proof-ccb-steer-ipc-r384.cjs missing');
  assert.ok(steer.argv && steer.argv.validatesSet,
    'the fixed mode set is no longer detected for the steer proof');
});

test('env vars and local imports are recorded', () => {
  const d = JSON.parse(run(['--json']).stdout);
  const byName = new Map(d.rows.map((r) => [r.name, r]));

  const history = byName.get('proof-hidden-history-import-confirm.cjs');
  assert.ok(history, 'the history proof is missing');
  assert.ok(history.envVars.length >= 5,
    'the history proof reports too few env vars: ' + JSON.stringify(history.envVars));
  assert.ok(history.envVars.every((v) => /^[A-Z][A-Z0-9_]+$/.test(v)),
    'an env var name is not upper-case: ' + JSON.stringify(history.envVars));
  // It imports the unread proof, which is a real maintenance coupling.
  assert.ok(history.localImports.includes('proof-ccb-unread-r383.cjs'),
    'the import of proof-ccb-unread-r383 is no longer recorded');
});

test('the tool states that it records preconditions, not intent', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /records preconditions, not intent/,
    'the tool no longer disclaims recording intent');
  assert.match(source, /may still have requirements this scan cannot see/,
    'the tool no longer admits the scan can miss requirements');
});
