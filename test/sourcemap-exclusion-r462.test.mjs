// R462: dropping .map at PACKAGE time — and the discovery that R460's installer was incomplete.
//
// THE PROPOSAL
//   R461 found 735 .map files against 737 .js: 57.4 MB of the 202 MB agent-core payload, 28.4% by
//   bytes. Dropping them at package time should shrink the installer.
//
// WHY IT MUST BE DONE AT PACKAGE TIME, NOT IN agent-core
//   tools/setup-agent-core.cjs digestBundle() hashes every file's RELATIVE PATH and BYTES, sorted,
//   into one sha256. Deleting a .map from agent-core changes that digest, breaks --verify, and makes
//   the pinned-fetch drift check fire. Verified by reading digestBundle and by the fact that
//   --verify reports fileCount 1479 / treeSha256 e7808bc2… — both would move.
//   So the filter belongs in electron-builder.json's extraResources entry.
//
// IS IT SAFE AT RUNTIME
//   735 of 737 chunks end with `//# sourceMappingURL=chunk-…js.map`, so the references exist. But:
//     - cli-bun.js is a 37-byte shim: `#!/usr/bin/env bun\nimport "./cli.js"\n` — it carries no maps
//     - desktop/main.cjs, session-kernel.cjs, ccb-runtime-paths.cjs contain zero source-map,
//       NODE_OPTIONS or --enable-source-maps references
//     - Bun does not read .map files unless stack traces are enabled
//   So the cost is debuggability of stack traces inside the bundle, not functionality.
//
// MEASURED RESULT
//     agent-core in the package : 748 files, 144.9 MB, 0 maps   (was 1483 / 202.2 MB / 735 maps)
//     installer                 : 195.1 MB
//
// THE NUMBER THAT LOOKS WRONG UNTIL YOU CHECK
//   195.1 MB is LARGER than R460's 153.8 MB. That is not a regression: R460 used --prepackaged and
//   so never re-packed app.asar, which came out at 4.7 MB instead of 187.6 MB. The 183 MB difference
//   is resources/ion-dist — 4458 files, 181.7 MB, a JUNCTION to D:\CodexArtifacts\…\pinned-ion-r372
//   that app-protocol.cjs serves the frontend from.
//
//   So R460's installer shipped WITHOUT the frontend. R462's is the first complete one:
//     app.asar 187.6 MB (resources/ion-dist 181.7 + i18n-overlay 2.6 + bootstrap-3p 0.1 + desktop 1.9)
//     agent-core 144.9 MB (maps excluded)
//     electron runtime ~356 MB
//
//   This is why comparing installer sizes across rounds without checking what went into them is
//   worthless — and why R461's "1483 == 1483" check was the right kind of check while R460's
//   staging-dir-only check was not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(ROOT, 'release', 'Code Desktop (Reconstruction)-0.1.0-x64.exe');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let cached = null;
function installerEntries() {
  if (cached) return cached;
  if (!fs.existsSync(EXE)) return null;
  const r = spawnSync('tar', ['-tf', EXE], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, 'bsdtar failed: ' + String(r.stderr || '').slice(0, 300));
  // Windows tar emits CRLF — R461's lesson.
  cached = r.stdout.split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .filter((l) => l.trim());
  return cached;
}

test('agent-core still contains every .map file — the source is untouched', () => {
  // The filter must live in packaging, never here: digestBundle hashes paths+bytes, so removing a
  // file from agent-core changes treeSha256 and breaks --verify.
  const ac = path.join(ROOT, 'agent-core');
  if (!fs.existsSync(ac)) return;
  let maps = 0;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        total += 1;
        if (e.name.endsWith('.map')) maps += 1;
      }
    }
  };
  walk(ac);
  assert.equal(maps, 735,
    'agent-core no longer has 735 .map files: they were deleted from the SOURCE, which changes '
    + 'treeSha256 and breaks the pinned bundle. The exclusion belongs in electron-builder.json');
  assert.equal(total, 1483, 'agent-core file count changed (was 1483)');
});

test('the packaging filter excludes maps and nothing else', () => {
  const cfg = JSON.parse(read(ROOT, 'electron-builder.json'));
  const entry = (cfg.extraResources || []).find((e) => e && e.from === 'agent-core');
  assert.ok(entry, 'agent-core is no longer in extraResources');
  assert.equal(entry.to, 'agent-core');
  const filter = entry.filter;
  assert.ok(Array.isArray(filter), 'the filter is gone: the installer would carry 57.4 MB of maps');
  assert.ok(filter.includes('!**/*.map'), 'the .map exclusion is gone: ' + JSON.stringify(filter));
  // A bare '**/*' alongside the negation excluded EVERYTHING in one attempt — the target directory
  // came out empty. Keep the list negation-only.
  assert.deepEqual(filter, ['!**/*.map'],
    'the filter gained a positive pattern: a positive glob plus a negation was measured to drop the '
    + 'entire payload once already');
});

test('the installer ships no .map files', (t) => {
  const entries = installerEntries();
  if (!entries) {
    t.skip('installer not present');
    return;
  }
  const maps = entries.filter((e) => e.endsWith('.map'));
  assert.deepEqual(maps, [],
    `the installer still carries ${maps.length} .map files: the exclusion did not take effect`);
});

test('the installer carries the full agent payload after filtering', (t) => {
  const entries = installerEntries();
  if (!entries) {
    t.skip('installer not present');
    return;
  }
  const acFiles = entries.filter((e) => e.startsWith('resources/agent-core/') && !e.endsWith('/'));
  // 1483 - 735 maps = 748.
  assert.equal(acFiles.length, 748,
    `agent-core has ${acFiles.length} files in the installer, expected 748 (1483 - 735 maps)`);
  for (const need of ['resources/agent-core/bun/bun.exe',
                      'resources/agent-core/claude-code/dist/cli-bun.js',
                      'resources/agent-core/manifest.json']) {
    assert.ok(entries.includes(need), 'missing ' + need);
  }
});

test('app.asar carries the frontend — the defect R460 shipped', (t) => {
  // R460 used --prepackaged, so app.asar was never rebuilt and stayed at 4.7 MB with no ion-dist.
  // The frontend is served from resources/ion-dist via app.asar, so that installer had no UI.
  const asar = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asar)) {
    // win-unpacked lives in the staging dir (C:\ccd-build-r460 after a space-free build), so the
    // workspace copy may be absent. Fall back to checking the archive entry exists.
    //
    // THE FALLBACK MUST ITSELF ASSERT SOMETHING
    //   `if (entries) { assert… }` meant that when the installer could not be listed — a harness failure, not an
    //   absence of subject matter — the function still returned and the test PASSED having checked neither the asar
    //   nor the archive. That is two independent ways to reach green with nothing verified, in the one test that
    //   documents the R460 defect.
    const entries = installerEntries();
    assert.ok(entries, 'win-unpacked has no app.asar AND the installer could not be listed: '
      + 'nothing was verified, which is not the same as passing');
    assert.ok(entries.includes('resources/app.asar'), 'app.asar is absent from the installer');
    return;
  }
  const size = fs.statSync(asar).size;
  assert.ok(size > 100 * 1024 * 1024,
    `app.asar is ${(size / 1048576).toFixed(1)} MB — that is the R460 stub. A complete asar is `
    + '~187 MB because resources/ion-dist (181.7 MB) is packed into it. Build WITHOUT --prepackaged '
    + 'after changing electron-builder.json, or the new config never takes effect.');
});

test('the frontend source is a junction, which is why --prepackaged hid it', () => {
  // resources/ion-dist is a junction to the pinned copy outside this repo. electron-builder follows
  // it when packing app.asar. A --prepackaged build skips that step entirely, which is exactly how
  // R460 produced a 4.7 MB asar while the tree looked correct.
  const ionDist = path.join(ROOT, 'resources', 'ion-dist');
  if (!fs.existsSync(ionDist)) return;
  const link = await_link(ionDist);
  if (!link) return; // not a junction on this filesystem; nothing to assert
  assert.ok(fs.existsSync(path.join(ionDist, 'index.html')),
    'the junction target lost index.html: resolveFrontendRoot would fall back to an installed '
    + 'Claude package or fail to boot');
});

function await_link(p) {
  try {
    // fs.lstatSync reports a symlink for junctions on Windows.
    return fs.lstatSync(p).isSymbolicLink() ? p : null;
  } catch {
    return null;
  }
}
