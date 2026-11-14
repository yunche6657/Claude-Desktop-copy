// R438: `treeSha256` is a content digest, NOT a "did the source change" check.
//
// WHAT WENT WRONG THIS ROUND
//   I reverted two experimental edits (adding `fable` to Agent.model and MODEL_ALIASES), confirmed
//   the source was back to baseline, rebuilt — and treeSha256 differed from the pre-experiment
//   value. Three builds of identical source produced three different digests:
//       474d3f60  -> 7c44e0d7  ->  f650a3bb
//
//   That undermined a check used across dozens of previous rounds. Diffing two consecutive builds
//   of the SAME source showed why:
//       added   : 868 files   (chunk-XXXX.js and friends, new names)
//       removed : 868 files   (the same files under old names)
//       changed : 1 file      (cli.js, which embeds the chunk names)
//       fileCount: 1479 in both
//
//   Chunk filenames are content hashes. If chunk CONTENT varies between builds, every name changes
//   and cli.js must be rewritten to match. So treeSha256 changes on every build regardless of source.
//
// THE CORRECT READING
//   treeSha256 is still useful — it detects that the ADOPTED bundle matches the BUILT one in a given
//   moment (setup-agent-core's --verify recomputes and compares). It is NOT evidence that source
//   changed, and it must never be cited as "the fix landed". The source diff is the evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'dist');
const MANIFEST = path.join(ROOT, 'agent-core', 'manifest.json');

test('chunk files are named by content hash, so any content change renames them', () => {
  const chunks = fs.readdirSync(DIST).filter((f) => /^chunk-[a-z0-9]+\.js$/.test(f));
  assert.ok(chunks.length > 100, 'the chunk layout changed: re-derive this analysis');
  // Names look like content hashes (short base36/hex), not sequential ids.
  const sample = chunks.slice(0, 30);
  for (const c of sample) {
    assert.match(c, /^chunk-[a-z0-9]{7,10}\.js$/,
      'a chunk filename no longer looks like a content hash: ' + c);
  }
});

test('cli.js references chunk names, so it changes whenever they do', () => {
  // This is the mechanism: renaming a chunk forces a rewrite of the file that imports it.
  const cli = fs.readFileSync(path.join(DIST, 'cli.js'), 'utf8');
  const refs = [...cli.matchAll(/chunk-[a-z0-9]{7,10}/g)].map((m) => m[0]);
  assert.ok(refs.length > 10, 'cli.js no longer embeds chunk names: re-derive the instability claim');

  // Every referenced chunk must exist — a stale reference would be a real bug, not churn.
  const missing = [...new Set(refs)].filter((r) => !fs.existsSync(path.join(DIST, r + '.js')));
  assert.deepEqual(missing, [], 'cli.js references chunks that were not emitted');
});

test('the manifest digest matches the adopted bundle right now', () => {
  // The one claim treeSha256 DOES support: the adopted copy equals what digestBundle computes from
  // it. Verified here independently of setup-agent-core so a mismatch is visible in the suite.
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const bundleDir = path.join(ROOT, 'agent-core', 'claude-code', 'dist');
  assert.ok(fs.existsSync(bundleDir), 'the adopted bundle directory moved');

  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(path.relative(bundleDir, full).split(path.sep).join('/'));
    }
  };
  walk(bundleDir);
  files.sort();

  const combined = crypto.createHash('sha256');
  for (const rel of files) {
    combined.update(rel + '\u0000');
    combined.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(bundleDir, rel))).digest('hex'));
    combined.update('\n');
  }
  assert.equal(combined.digest('hex'), manifest.bundle.treeSha256,
    'the adopted bundle no longer matches its recorded digest');
  assert.equal(files.length, manifest.bundle.fileCount,
    'the adopted bundle file count no longer matches the manifest');
});

test('nothing in this suite cites treeSha256 as source-change evidence', () => {
  // A regression guard on the note-taking itself: if a future round starts treating the digest as a
  // change signal again, that reasoning is wrong for the reason documented above.
  //
  // Lines carrying the exemption marker are skipped: prose that QUOTES a forbidden phrasing in order
  // to forbid it necessarily contains that phrasing.
  const EXEMPT = 'treeSha256-misuse-exempt';
  const evidenceDir = path.join(ROOT, 'evidence');
  const offenders = [];
  for (const f of fs.readdirSync(evidenceDir)) {
    if (!f.endsWith('.md')) continue;
    // STATUS.md is an append-only round log. It necessarily QUOTES past mistakes while recording
    // them ("I wrote X before, and X was wrong"), so scanning it flags the correction, not the error.
    if (f === 'STATUS.md') continue;
    for (const line of fs.readFileSync(path.join(evidenceDir, f), 'utf8').split('\n')) {
      if (line.includes(EXEMPT)) continue;
      // Look for the specific misuse: claiming the digest PROVES the source changed.
      if (/treeSha256[^.\n]{0,80}(证明|说明|意味着)[^.\n]{0,40}(源码|改动|修复)/.test(line)) {
        offenders.push(f + ': ' + line.trim().slice(0, 80));
      }
    }
  }
  assert.deepEqual(offenders, [],
    'an evidence file claims treeSha256 proves source change; it does not — chunk names cascade '
    + 'and vary per build');
});
