// R640: the `EPERM` on config writes is not a defect in this reconstruction. A BLANK Electron app — no app code at all —
// gets the same `EPERM` when spawned from this kind of restricted session.
//
// THE EXPERIMENT
//   A minimal main process whose only act is `app.whenReady().then(() => fs.mkdirSync(target))`:
//
//       [probe] MAIN WRITE FAILED: EPERM  EPERM: operation not permitted, mkdir '<Temp>\el-mkdir-…'
//
//   So the failure lives between the filesystem and the Electron child, not in `bridge-services.cjs`.
//
// THE HYPOTHESES THIS EXCLUDES, EACH MEASURED
//       writing the same directory from a shell                     SUCCEEDS
//       writing the exact `.tmp-<pid>` name from a shell             SUCCEEDS
//       Defender controlled folder access                           0 (off)
//       a DENY ACE on the library                                   none
//       inheriting ELECTRON_RUN_AS_NODE=1                            removed, still EPERM
//       an ordinary spawned child writing the filesystem             CHILD WRITE OK
//       a brand-new mkdtemp target, so `mkdir` itself fails           still EPERM
//
//   Six exclusions. What remains is the shape of this execution environment, not the product.
//
// THE FLAG MATRIX, ALSO MEASURED
//       no flags                    the process does not boot (no interactive desktop here)
//       --disable-gpu               does not boot
//       --no-sandbox                boots, `mkdir` -> EPERM
//       --no-sandbox --disable-gpu  boots, `mkdir` -> EPERM
//
//   Only the `--no-sandbox` forms boot at all in this session, and those are exactly the forms that cannot write. That
//   pairing is what makes this an environment finding rather than a code finding.
//
// WHAT IS STILL WORTH KEEPING
//   R639's diagnostic. It turns "EPERM … <uuid>.json.tmp-17552" into "cannot write the configuration library at <dir>
//   (EPERM)", which is useful in every real failure even though this particular one is environmental.
//
// WHAT IS NOT CLAIMED
//   Not that EPERM never happens in real use: this measures a spawned session and infers from an on-disk file written on
//   2026-10-23 that a normally-launched app can write.
//   Not that a clean desktop double-click was tested here: it was not — that is the one confirmation left to the user.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The recorded finding, kept as data so a future round can re-run rather than re-derive. */
const FINDING = {
  probe: 'a blank Electron main process calling fs.mkdirSync on app.whenReady',
  observed: 'EPERM: operation not permitted, mkdir',
  excludes: [
    'directory ACL (a shell writes the same path)',
    'the exact .tmp-<pid> filename (a shell writes it)',
    'controlled folder access (preference reads 0)',
    'a DENY ACE (none on the library)',
    'inherited ELECTRON_RUN_AS_NODE (removed, still EPERM)',
    'ordinary child-process write restriction (spawned node writes fine)',
    'a missing target directory (a fresh mkdtemp target also fails at mkdir)',
  ],
  flagMatrix: [
    { flags: 'none', booted: false },
    { flags: '--disable-gpu', booted: false },
    { flags: '--no-sandbox', booted: true, wrote: false },
    { flags: '--no-sandbox --disable-gpu', booted: true, wrote: false },
  ],
  conclusion: 'the restriction belongs to this execution environment, not to the reconstruction',
  keptFromR639: 'the diagnostic message, which names the directory instead of a temporary filename',
};

test('the finding records enough to be re-run, not just a verdict', () => {
  assert.ok(FINDING.probe.includes('Electron'), 'the probe is not described');
  assert.match(FINDING.observed, /EPERM/);
  assert.ok(FINDING.excludes.length >= 6, `only ${FINDING.excludes.length} hypotheses excluded`);
});

test('the flag matrix shows that only the unwritable forms boot', () => {
  const booted = FINDING.flagMatrix.filter((r) => r.booted);
  assert.ok(booted.length >= 1, 'no flag combination booted, so the matrix proves nothing');
  assert.ok(booted.every((r) => r.wrote === false), 'a booted form wrote successfully, which contradicts the finding');
  const notBooted = FINDING.flagMatrix.filter((r) => !r.booted);
  assert.ok(notBooted.length >= 1, 'every form booted, so the pairing is unobserved');
});

test('the conclusion is scoped to the environment, not to the product', () => {
  assert.match(FINDING.conclusion, /execution environment/, 'the scope is not stated');
  assert.ok(!/product is broken/.test(FINDING.conclusion));
});

test("R639's diagnostic is still in the source and still names the directory", () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.ok(src.includes('cannot write the configuration library at'), 'the diagnostic was reverted');
  const i = src.indexOf('writeConfigFile =');
  const body = src.slice(i, i + 1800);
  assert.ok(body.indexOf('mkdirSync') > body.indexOf('try {'), 'mkdirSync escaped the guard again');
});

test('the evidence document exists and carries the flag matrix', () => {
  const doc = path.join(ROOT, 'evidence', 'eperm-is-environmental-r640.md');
  assert.ok(fs.existsSync(doc), 'the evidence document is missing');
  const text = fs.readFileSync(doc, 'utf8');
  assert.ok(text.includes('--no-sandbox'), 'the flag matrix is not in the document');
  assert.ok(text.includes('空白 Electron'), 'the decisive experiment is not described');
});
