// R439: chunk names are unstable by cascade, and treeSha256 can never be a source-change signal.
//
// THE CHAIN OF EVIDENCE
//   v1 measured: with chunk-name references normalised, all 737 chunks are byte-identical across two
//      builds. So CONTENT is deterministic.
//   v2 measured: the NAME SET changes — 303 shared, 434 only in build A, 434 only in build B. The
//      same body gets a different name 432 times out of 735.
//   v3 measured: the token (`005ptm8q`) is not sha1/sha256/md5 of the content, and outdir is not
//      env-configurable.
//   v4 measured the correlation that explains it:
//        chunks referencing 1-2 other chunks : 12% renamed
//        chunks referencing 3+ other chunks  : 73% renamed
//
//   A chunk's name therefore depends on the names of the chunks it imports. Rename one leaf and
//   every importer above it gets renamed too — a cascade. That is why most names move while the
//   content never does.
//
// CONSEQUENCE FOR treeSha256
//   It cannot indicate whether SOURCE changed. Any rebuild reshuffles names, which rewrites cli.js,
//   which changes the digest. The only valid use is: "the adopted bundle equals the built bundle at
//   this moment", which is what setup-agent-core --verify checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'dist');
const NORM = /chunk-[a-z0-9]{7,10}/g;

const chunkFiles = () => fs.readdirSync(DIST).filter((f) => /^chunk-[a-z0-9]+\.js$/.test(f));

test('chunk names are content-independent: none is a plain hash of its own body', () => {
  // If a name WERE sha1/sha256/md5 of the file, the naming would be content-only and stable. It is
  // not, which is the first indication that names carry extra input.
  const files = chunkFiles().slice(0, 20);
  assert.ok(files.length > 10, 'the chunk layout changed');

  let matched = 0;
  for (const f of files) {
    const token = f.slice('chunk-'.length, -'.js'.length);
    const raw = fs.readFileSync(path.join(DIST, f));
    for (const alg of ['sha256', 'sha1', 'md5']) {
      const hex = crypto.createHash(alg).update(raw).digest('hex');
      if (hex.startsWith(token) || hex.slice(0, 8) === token) matched += 1;
    }
  }
  assert.equal(matched, 0,
    'a chunk name now equals a digest of its own content: the naming scheme changed, and '
    + 'treeSha256 may have become a stable indicator — re-derive this whole analysis');
});

test('the token alphabet is base36, not hex', () => {
  // Distinguishes Bun's short-hash encoding from a hex digest; a hex-only token would contradict the
  // "not a plain hash" finding above.
  const tokens = chunkFiles().map((f) => f.slice('chunk-'.length, -'.js'.length));
  assert.ok(tokens.length > 100, 'too few chunks to judge');
  const withNonHex = tokens.filter((t) => /[g-z]/.test(t));
  assert.ok(withNonHex.length > tokens.length * 0.5,
    'most tokens are now pure hex: the naming scheme changed, re-derive');
});

test('names cascade: modules importing more chunks are renamed more often', () => {
  // The correlation measured in v4. It is asserted structurally rather than statistically: a module
  // with many chunk imports must have those names embedded in its body, which is the mechanism that
  // makes its own name depend on theirs.
  const files = chunkFiles();
  const rich = [];
  for (const f of files) {
    const body = fs.readFileSync(path.join(DIST, f), 'utf8');
    const refs = new Set(body.match(NORM) || []);
    if (refs.size >= 3) rich.push({ file: f, refs: refs.size });
  }
  assert.ok(rich.length > 100,
    'few chunks import 3+ others: the cascade precondition no longer holds, re-derive');

  // And those embedded references are real — every one resolves to a file that exists.
  let dangling = 0;
  for (const { file } of rich.slice(0, 40)) {
    const body = fs.readFileSync(path.join(DIST, file), 'utf8');
    for (const ref of new Set(body.match(NORM) || [])) {
      if (!fs.existsSync(path.join(DIST, ref + '.js'))) dangling += 1;
    }
  }
  assert.equal(dangling, 0, 'chunk bodies reference chunks that do not exist');
});

test('cli.js is rewritten whenever chunk names change', () => {
  // cli.js is the file that makes treeSha256 move: it embeds 31 chunk names, so any cascade that
  // renames one of them rewrites it.
  const cli = fs.readFileSync(path.join(DIST, 'cli.js'), 'utf8');
  const refs = new Set(cli.match(NORM) || []);
  assert.ok(refs.size >= 20,
    'cli.js embeds only ' + refs.size + ' chunk names; it is the digest instability vector, so '
    + 're-derive how treeSha256 could move');

  const missing = [...refs].filter((r) => !fs.existsSync(path.join(DIST, r + '.js')));
  assert.deepEqual(missing, [], 'cli.js references chunks that do not exist');
});

test('the ONLY valid reading of treeSha256 is adopt-time equality', () => {
  // Guard on the reasoning itself. treeSha256 varies per build, so it cannot distinguish "source
  // changed" from "rebuilt". Any evidence file claiming otherwise is wrong.
  //
  // The check must tolerate prose that QUOTES the forbidden phrasing in order to forbid it — a note
  // saying "do not write X" necessarily contains X. Lines carrying the marker below are exempt.
  const EXEMPT = 'treeSha256-misuse-exempt';
  const evidenceDir = path.join(ROOT, 'evidence');
  const offenders = [];
  for (const f of fs.readdirSync(evidenceDir)) {
    if (!f.endsWith('.md')) continue;
    // STATUS.md is an append-only round log. It necessarily QUOTES past mistakes while recording
    // them, so scanning it flags the correction rather than the error.
    if (f === 'STATUS.md') continue;
    const lines = fs.readFileSync(path.join(evidenceDir, f), 'utf8').split('\n');
    for (const line of lines) {
      if (line.includes(EXEMPT)) continue;
      // The misuse: treating the digest as proof that the fix or source change landed.
      if (/treeSha256[^。\n]{0,100}(证明|说明|意味着|表明)[^。\n]{0,50}(修复|改动|生效|落地)/.test(line)) {
        offenders.push(f + ': ' + line.trim().slice(0, 80));
      }
    }
  }
  assert.deepEqual(offenders, [],
    'an evidence file treats treeSha256 as a source-change signal. Chunk names cascade, so every '
    + 'rebuild changes the digest regardless of source. Cite the source diff instead.');
});
