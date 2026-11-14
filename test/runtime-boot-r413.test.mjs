// R413: the vendored dist actually EXECUTES.
//
// WHY THIS FILE EXISTS
//   Twelve rounds of changes had only static verification — "the string is in the bundle",
//   "the source matches the artifact". None of that proves the bundle runs. This file executes
//   the vendored CLI and asserts on real process output, which is a strictly stronger claim.
//
// WHAT IT DOES *NOT* PROVE
//   `--help` shows the module graph loads. It does NOT show that any tool definition is correct,
//   and it does NOT exercise the six behaviour changes made in R399-R412 — those need real API
//   credentials, which this environment does not have. Do not let a green run here be read as
//   "the changes are runtime-verified".
//
// THE SILENT-SUBCOMMAND FINDING
//   `doctor`, `auth status`, `mcp list` and even a bogus subcommand all exit 0 with zero bytes on
//   stdout. Root cause: their handlers render through Ink's `createRoot()` rather than writing to
//   stdout, so with no TTY the output has nowhere to land. That is normal for a TUI product, and
//   this file asserts the OBSERVED behaviour rather than demanding a change — matching the
//   project's rule of not "fixing" what the official product also does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'agent-core', 'manifest.json'), 'utf8'),
);
const BUN = path.join(ROOT, MANIFEST.bun.path);
const CLI = path.join(ROOT, 'agent-core', MANIFEST.bundle.entry);
const DIST = path.dirname(CLI);

/** Run the vendored CLI with stdin closed, capturing stdout and stderr separately. */
function run(args, opts = {}) {
  const r = spawnSync(BUN, [CLI, ...args], {
    cwd: DIST,
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Keep the environment minimal but not empty: the CLI reads HOME and platform details.
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return {
    code: r.status,
    signal: r.signal,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
    error: r.error?.message,
  };
}

test('the vendored bun binary and entry exist where the manifest says', () => {
  assert.ok(fs.existsSync(BUN), 'bun missing at manifest path: ' + BUN);
  assert.ok(fs.existsSync(CLI), 'entry missing at manifest path: ' + CLI);
});

test('the CLI actually runs and reports its version', () => {
  const r = run(['--version']);
  assert.equal(r.error, undefined, 'spawn failed: ' + r.error);
  assert.equal(r.code, 0, '--version exited ' + r.code + '; stderr: ' + r.err.slice(0, 400));
  // An emitted version string is the difference between "the file exists" and "the file runs".
  assert.match(r.out, /\d+\.\d+\.\d+/,
    'no version string on stdout: ' + JSON.stringify(r.out.slice(0, 200)));

  // And it must agree with the manifest, which is how the vendored tree is identified.
  const pinned = JSON.parse(
    fs.readFileSync(path.join(ROOT, '..', '.tmp', 'ccb-src', 'package.json'), 'utf8'),
  ).version;
  assert.ok(r.out.includes(pinned),
    'the running CLI reports a different version than the pinned source tree (' + pinned + '): '
    + JSON.stringify(r.out.trim()));
});

test('the full module graph loads — --help reaches the command registry', () => {
  // Stronger than --version: --help walks commander's registrations and dynamically imports
  // dozens of chunks before it can print. If a chunk were broken, this is where it surfaces.
  const r = run(['--help']);
  assert.equal(r.code, 0, '--help exited ' + r.code + '; stderr: ' + r.err.slice(0, 400));
  assert.ok(r.out.split('\n').length > 40,
    '--help printed suspiciously little: ' + r.out.split('\n').length + ' lines');

  // Spot-check that real options were registered rather than a stub help text.
  for (const flag of ['--print', '--model', '--add-dir']) {
    assert.ok(r.out.includes(flag), 'registered option missing from --help: ' + flag);
  }
  // Subcommands come from separate registrations; seeing them proves more of main.tsx ran.
  for (const cmd of ['doctor', 'mcp']) {
    assert.ok(r.out.includes(cmd), 'registered subcommand missing from --help: ' + cmd);
  }
});

test('a subcommand that renders through Ink is silent without a TTY — observed, not endorsed', () => {
  // This is the behaviour R413 documented, pinned so a future change is noticed either way.
  // The handler does `createRoot()` then `doctorHandler(root)`: output goes to the Ink tree,
  // not stdout, so with no TTY there is nothing to print. Exit code stays 0 because nothing
  // failed — which is exactly why it looked like a hang or a broken build at first.
  const r = run(['doctor']);
  assert.equal(r.error, undefined, 'spawn failed: ' + r.error);
  assert.equal(r.code, 0,
    'doctor changed its exit behaviour; re-derive whether it now writes to stdout');
  assert.equal(r.out, '',
    'doctor produced stdout without a TTY: re-derive whether the Ink path changed');
  assert.equal(r.err, '',
    'doctor produced stderr without a TTY: re-derive the silent-exit finding');
});

test('option errors DO reach stderr, unlike subcommand output', () => {
  // The contrast that made the silent-subcommand finding legible. commander writes option
  // errors directly, bypassing the Ink path entirely.
  const r = run(['doctor', '--bogus-option-for-the-test']);
  assert.notEqual(r.code, 0, 'an unknown option should be a non-zero exit');
  assert.match(r.err, /unknown option/i,
    'the option error did not reach stderr: ' + JSON.stringify(r.err.slice(0, 200)));
});

test('an unknown subcommand is silent too — so silence is not "command not implemented"', () => {
  // The decisive control. If silence meant "not implemented", a bogus name would differ from a
  // real one. It does not: both produce nothing, because both go down the Ink path.
  const r = run(['definitely-not-a-real-subcommand']);
  assert.equal(r.code, 0, 'an unknown subcommand changed its exit code; re-derive §2');
  assert.equal(r.out, '', 'an unknown subcommand produced stdout; re-derive §2');
});
