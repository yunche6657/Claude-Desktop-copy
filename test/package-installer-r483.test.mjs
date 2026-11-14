// R483: packaging has one entry point that refuses to produce the two historical failures.
//
// THE GAP
//   package.json had no installer script. `build` and `build:asar` both call build/build.cjs, which only
//   stages a directory or an asar — neither produces an NSIS installer. Every installer so far came from
//   an electron-builder command typed by hand, and that failed twice:
//
//     R460 #1  spaced path. The project lives under "注册号 逆向"; electron-builder passes output paths
//              into NSIS and the spaces were mis-quoted. The run reported success and produced a
//              0.18 MB stub instead of ~195 MB.
//     R460 #2  --prepackaged. Reusing an existing win-unpacked with that flag skips the rebuild, so
//              resources/ion-dist — a JUNCTION — was never re-read. The installer's app.asar was 4.7 MB
//              instead of 187.6 MB: an agent with no UI.
//
//   Both share a shape: success was reported for a wrong artifact. Nothing checked the output.
//
// THE FIX — tools/package-installer.cjs, wired as `npm run package`
//   1. Stages into a directory that MUST NOT contain spaces (throws otherwise, naming the R460 stub).
//      Staging is a copy, so resources/ion-dist's junction is dereferenced into real files and cannot be
//      skipped the way --prepackaged skipped it.
//   2. Builds app.asar from the STAGED tree, so a stale release/app.asar cannot be packaged.
//   3. Runs electron-builder for real. --prepackaged is never passed.
//   4. Verifies the result on two independent axes, because the two failures were different things:
//        - size floor: catches the stub
//        - required asar entries, including resources/ion-dist: catches the large-but-empty app
//      A failure exits non-zero and leaves the artifact for inspection rather than copying it to
//      release/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tools', 'package-installer.cjs');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const runScript = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 60000,
});

test('npm run package exists and points at the packaging script', () => {
  const pkg = JSON.parse(read(ROOT, 'package.json'));
  assert.equal(pkg.scripts.package, 'node tools/package-installer.cjs',
    'the package script is missing or points elsewhere; without it packaging is hand-typed again');
  assert.equal(pkg.scripts['package:check'], 'node tools/package-installer.cjs --dry-run',
    'no dry-run script, so preconditions cannot be checked without a full build');
  assert.ok(fs.existsSync(SCRIPT), 'tools/package-installer.cjs is missing');
});

test('the script never passes --prepackaged', () => {
  const source = read(SCRIPT);
  // The flag may be named in prose (it is, in the header explaining the failure), but it must never
  // appear in an argument array. Look for it as a quoted argument.
  const asArgument = /['"]--prepackaged['"]/.test(source);
  assert.equal(asArgument, false,
    '--prepackaged is back as an argument: that flag skips the rebuild and shipped a UI-less installer');
});

test('a staging directory with spaces is refused, naming the failure', () => {
  // This is the first historical failure. The script must not try to quote its way out.
  const result = runScript(['--dry-run', '--stage', 'C:\\has spaces here\\stage']);
  assert.notEqual(result.status, 0,
    'a spaced staging directory was accepted; the R460 quoting failure can recur');
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.match(output, /must not contain spaces/,
    'the refusal does not say what is wrong: ' + output.slice(0, 300));
  assert.match(output, /stub/,
    'the refusal does not connect to the concrete failure mode (the 0.18 MB stub)');
});

test('the dry run reports the checks it would perform', () => {
  const result = runScript(['--dry-run']);
  assert.equal(result.status, 0, 'dry run failed: ' + (result.stderr || '').slice(0, 400));
  const out = result.stdout || '';

  // Preconditions actually checked, not merely described.
  assert.match(out, /preconditions:.*agent-core/, 'the dry run does not report the agent-core check');
  assert.match(out, /installer floor:/, 'the dry run does not report the size floor');
  assert.match(out, /required asar entries:/, 'the dry run does not report the asar entry checks');
  // The space-free staging plan is stated when the project path has spaces.
  if (/\s/.test(ROOT)) {
    assert.match(out, /staged into a space-free directory/,
      'the project path has spaces but the script does not say it stages elsewhere');
    assert.match(out, /R460/, 'the note does not reference the recorded failure');
  }
});

test('verification covers both historical failure modes', () => {
  const source = read(SCRIPT);

  // (a) the size floor, which catches a stub
  assert.match(source, /MIN_INSTALLER_BYTES\s*=\s*100\s*\*\s*1024\s*\*\s*1024/,
    'the size floor changed: re-derive whether a stub would still be caught');
  // (b) required asar entries, which catch a large-but-empty app
  assert.match(source, /resources\/ion-dist/,
    'the asar check does not require resources/ion-dist, so a UI-less installer would pass');
  assert.match(source, /desktop\/main\.cjs/,
    'the asar check does not require the main process entry');

  // The asar is built from the staged tree, which is what makes the shortcut unnecessary.
  assert.match(source, /--target',\s*'asar'/,
    'the script no longer builds the asar itself, so it would package whatever release/ holds');
  // And electron-builder runs for real, with its flags as separate argv elements.
  assert.match(source, /'--win',\s*'--x64'/,
    'the electron-builder flags changed shape');
});

test('staging dereferences the ion-dist junction and keeps sourcemaps for manifest verification', () => {
  // The junction is the mechanism by which --prepackaged silently omitted the frontend. Copying with
  // statSync (not lstat / isDirectory on the Dirent) is what makes a junction look like a directory.
  const source = read(SCRIPT);
  assert.match(source, /fs\.statSync\(src\)/,
    'staging no longer stats link targets, so a junction would be handled as a file or skipped');
  assert.match(source, /copyTreeDereferenced/,
    'the dereferencing copy helper is gone');

  // Maps must NOT be filtered at staging time. build.cjs verifies the staged tree against manifest.json,
  // which hashes the complete bundle (1479 files); dropping .map here changes the tree hash and the build
  // aborts with "agent-core bundle differs from pinned manifest". Measured, not assumed — that is what
  // the first run of this script hit. The exclusion belongs to extraResources.filter at package time.
  assert.ok(!/!name\.endsWith\('\.map'\)/.test(source),
    'staging filters sourcemaps again: build.cjs will reject the tree against the pinned manifest');
  assert.match(source, /sourcemaps kept for manifest verification/,
    'the reason for keeping maps is no longer recorded next to the copy call');
});

test('external commands are passed as argv, never through a shell', () => {
  // The first working draft used shell:true to reach electron-builder's .cmd shim, and the run died with
  //     'C:\Program' is not recognized as an internal or external command
  // because the node path contains a space. That is the same lost-argument-boundary failure as R460's
  // NSIS quoting. The script must invoke processes with argv arrays and electron-builder's JS entry.
  const source = read(SCRIPT);
  assert.match(source, /shell:\s*options\.shell === true/,
    'run() no longer defaults to no shell, so a spaced executable path will split again');
  assert.ok(!/shell:\s*process\.platform === 'win32'/.test(source),
    'run() defaults to a shell on Windows again');
  assert.match(source, /electron-builder', 'cli\.js'/,
    'electron-builder is no longer invoked through its cli.js; the .cmd shim needs a shell');
});

test('an unreadable entry is skipped and reported, not fatal', () => {
  // resources/ion-dist.broken-r373 is a dangling junction into WindowsApps. The first run crashed with a
  // bare ENOENT; it must instead be recorded and the build continue.
  const source = read(SCRIPT);
  assert.match(source, /state\.skipped\.push/, 'unreadable entries are no longer recorded');
  assert.match(source, /skipped \$\{skipped\.length\} unreadable entries/,
    'the skip count is not reported, so a genuinely missing input could hide behind the mechanism');
  // The staged frontend is still required in full.
  assert.match(source, /staged resources\/ion-dist is missing or empty/,
    'the post-staging check on ion-dist is gone: that is the exact thing --prepackaged omitted');
});

test('the stage is kept on failure and removed only on success', () => {
  // The first failed run deleted its stage, which was the only evidence of what went wrong.
  const source = read(SCRIPT);
  assert.match(source, /if \(succeeded && !options\.keepStage\)/,
    'stage cleanup is no longer conditional on success');
  assert.match(source, /stage kept for inspection/,
    'a failed run does not say where its stage went');
});
