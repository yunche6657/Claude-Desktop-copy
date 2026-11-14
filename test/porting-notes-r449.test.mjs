// R449: porting notes must not survive in shipped source — and a scan that proves it.
//
// HOW THIS WAS FOUND
//   Auditing tool-level descriptions for self-consistency turned up
//   RefreshMcpToolsTool's comment:
//
//       // WHY THIS TOOL IS POSSIBLE (unlike §3.2 ProposeSkills and §2 ReadMcpResourceDir)
//       //   The mechanism already exists; only the model-facing entry point was missing:
//
//   `§3.2` and `§2` name a design document that is not in this repository. The comment explains the
//   PORT, not the tool.
//
// THE SCAN TOOK THREE REFINEMENTS, EACH REMOVING FALSE POSITIVES
//   whole tree          -> 2913 hits, almost all upstream (claude-code-best ships its own Chinese
//                          comments and its own `§N.M` ACP audit notes). Accusing those would be a
//                          false correction of someone else's code.
//   git diff added lines -> 1 hit, and it was benign (a quoted contract sentence plus "R406 killed
//                          the task", which is a change rationale, not a doc reference).
//   untracked files      -> 10 hits in 4 directories THIS SESSION CREATED. `git diff` cannot see
//                          untracked files, which is exactly where the notes were.
//
//   That progression matters: the first scan would have produced 2913 false positives, and the second
//   would have found nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

/** Files this session created: untracked per git. */
function untrackedSourceDirs() {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: SRC, encoding: 'utf8' });
  return out.split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter((p) => /\.(ts|tsx)$/.test(p) || p.endsWith('/'));
}

const PORTING_VOCABULARY = [
  [/\u00a7\s*\d+\.\d+/, 'section reference to a design document'],
  [/WHY THIS (TOOL|SECTION|IS) IS POSSIBLE/i, 'feasibility note'],
  [/\bR\d{3}\b/, 'session round number'],
  // `faithfully` alone is ordinary English ("report the flag faithfully") and must not be flagged.
  // Only flag it when used as the reconstruction's self-description.
  [/\b(reconstruction|our port|faithful reconstruction|faithfully reconstruct)/i,
    'reconstruction vocabulary'],
  [/the official contract (itself )?(says|has|asks)/i, 'official-comparison framing'],
];

test('no porting notes survive in the files this session created', () => {
  // The four directories are untracked, so `git diff` never showed them. This test reads them whole.
  const dirs = untrackedSourceDirs();
  assert.ok(dirs.length >= 4,
    'expected the session-created directories to still be untracked, found ' + dirs.length);

  const offenders = [];
  for (const rel of dirs) {
    const abs = path.join(SRC, rel);
    if (!fs.existsSync(abs)) continue;
    const files = fs.statSync(abs).isDirectory()
      ? fs.readdirSync(abs).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')).map((f) => path.join(abs, f))
      : [abs];
    for (const f of files) {
      const text = read(f);
      for (const [re, label] of PORTING_VOCABULARY) {
        const m = re.exec(text);
        if (m) {
          const ln = text.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(SRC, f)}:${ln} ${label}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    'porting notes are back in session-created source. They explain how the code was ported, not what '
    + 'it does, and the section/round numbers they cite do not resolve inside this repository.');
});

test('the four directories this session created are still identifiable as untracked', () => {
  // If they ever get committed, the scan above loses its target and needs a different basis.
  const dirs = untrackedSourceDirs().join('\n');
  for (const expected of ['ProposeGoalTool', 'RefreshMcpToolsTool', 'SendFeedbackTool', 'feedback']) {
    assert.ok(dirs.includes(expected),
      expected + ' is no longer untracked: the note-scan basis changed, re-derive how to find '
      + 'session-created source');
  }
});

test('the cleaned comments still explain the mechanism, not just the history', () => {
  // Removing notes must not strip the useful part: the call chain and where it lives.
  const refresh = read(TOOLS, 'RefreshMcpToolsTool', 'RefreshMcpToolsTool.ts');
  assert.match(refresh, /clearServerCache/,
    'the cache-invalidation call chain was removed along with the notes');
  assert.match(refresh, /client\.ts:\d+/,
    'the file:line reference was removed: those resolve, unlike the section numbers');
  assert.match(refresh, /scopedMcpServerConfig|ScopedMcpServerConfig/i,
    'the reason serverRef works was removed');

  // And the note framing is gone.
  assert.ok(!/WHY THIS TOOL IS POSSIBLE/.test(refresh), 'the feasibility heading is back');
  assert.ok(!/\u00a7\s*\d+\.\d+/.test(refresh), 'a design-document section number is back');
});

test('upstream comments were NOT touched by the cleanup', () => {
  // The scan found 2913 hits across the whole tree, nearly all upstream. Correcting those would be a
  // false accusation against someone else's code. Verify a known upstream note survives.
  const forwarding = path.join(SRC, 'src', 'services', 'acp', 'bridge', 'forwarding.ts');
  assert.ok(fs.existsSync(forwarding), 'the upstream ACP bridge file is gone');
  const text = read(forwarding);
  assert.match(text, /audit \u00a7/,
    'upstream section references disappeared: the cleanup reached outside this session\'s files');

  // And upstream Chinese comments, which are not this session's doing either.
  const mainTsx = path.join(SRC, 'src', 'main.tsx');
  assert.ok(fs.existsSync(mainTsx), 'src/main.tsx is gone');
  assert.match(read(mainTsx), /[\u4e00-\u9fff]/,
    'upstream Chinese comments disappeared: the cleanup over-reached');
});

test('the description audit itself found no self-contradicting read-only tools', () => {
  // The original goal of this round. Seven read-only tools were checked; none describes writing
  // while declaring isReadOnly=true.
  const readOnlyTools = [
    ['ReadMcpResourceTool', 'ReadMcpResourceTool.ts'],
    ['ListMcpResourcesTool', 'ListMcpResourcesTool.ts'],
    ['GlobTool', 'GlobTool.ts'],
    ['GrepTool', 'GrepTool.ts'],
    ['FileReadTool', 'FileReadTool.ts'],
  ];
  const WRITE_CLAIM = /\b(writes?|overwrites?|deletes?|removes?|modifies?)\b/i;
  for (const [dir, file] of readOnlyTools) {
    const p = path.join(TOOLS, dir, file);
    if (!fs.existsSync(p)) continue;
    const text = read(p);
    assert.match(text, /isReadOnly\(\)\s*\{\s*return\s+true/,
      dir + ' is no longer declared read-only');
    // Its description must not promise a mutation. Look only at the description() return.
    //
    // A NON-MATCH IS THE CASE THE CHECK EXISTS FOR, NOT A REASON TO SKIP IT
    //   The guard used to be `if (m) { assert… }`. The tool was already confirmed to exist and to declare itself
    //   read-only on the line above, so a `description()` that this regex cannot find means the SHAPE CHANGED — a
    //   reformatting, a rename, a move to a getter. That is exactly when "does the text promise a write" needs asking,
    //   and the old guard stopped asking.
    const m = /async description\([^)]*\)\s*\{[\s\S]{0,400}?\}/.exec(text);
    assert.ok(m, dir + ': a read-only tool has no `async description() { … }` block for the write-claim check to read; '
      + 'find the new shape rather than letting the check disappear');
    assert.ok(!WRITE_CLAIM.test(m[0]),
      dir + ' is read-only but its description promises a write: ' + m[0].slice(0, 100));
  }
});
