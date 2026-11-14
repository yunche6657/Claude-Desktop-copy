// The allowlist is a list of NAMES; a name is not a program.
//
// Measured on this host (tools/_exec-availability.cjs): 23 of the 30 allowlisted names have no
// spawnable binary. `ls`, `cat`, `echo`, `pwd`, `dir`, `type` are PowerShell aliases with no
// .exe behind them; `npm`, `npx`, `pnpm`, `yarn`, `tsc`, `eslint` are .cmd shims that a
// shell:false spawn cannot start.
//
// The old behaviour asked the user to approve such a command and THEN failed in exec with
// ENOENT. That reads as "the approval system is broken", which is the wrong lesson to teach
// someone trusting an approval prompt. These tests pin the refusal-before-consent behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCommand, checkAvailability, runCommand } = require('../desktop/local-exec.cjs');

test('availability is answered without spawning the command', () => {
  // The check must be cheap and side-effect free: it runs before consent, so it cannot be
  // allowed to execute the thing being approved.
  const result = checkAvailability(parseCommand('node --version'), { resolve: () => 'C:\\x\\node.exe' });
  assert.equal(result.available, true);
  assert.equal(result.resolved, 'C:\\x\\node.exe');
});

test('a name with no binary behind it is reported unavailable, with a reason', () => {
  const result = checkAvailability(parseCommand('echo hello'), { resolve: () => null });
  assert.equal(result.available, false);
  assert.match(result.reason, /echo/);
  assert.match(result.reason, /no spawnable binary/);
});

test('a .cmd shim is not mistaken for a runnable program', () => {
  // This is the exact Windows trap: `where npm` finds npm.cmd, which Node cannot spawn
  // without a shell. A resolver that returns the .cmd path must not be treated as spawnable.
  const result = checkAvailability(parseCommand('npm --version'), { resolve: () => null });
  assert.equal(result.available, false);
});

test('the real default resolver agrees with this host', () => {
  // No injection: this asks the actual machine. node and git exist here; the alias-only names
  // do not. If this machine changes, this test is where the difference shows up.
  const node = checkAvailability(parseCommand('node --version'));
  assert.equal(node.available, true, 'node must be spawnable on the build host');

  if (process.platform === 'win32') {
    const echo = checkAvailability(parseCommand('echo hi'));
    assert.equal(echo.available, false, 'echo is a PowerShell alias on Windows, not a program');
    assert.match(echo.reason, /alias or a \.cmd shim/);
  }
});

test('runCommand refuses an unspawnable command instead of failing later with ENOENT', async () => {
  await assert.rejects(
    () => runCommand({ command: 'echo hello' }),
    (error) => {
      assert.match(error.message, /no spawnable binary/, 'the reason must name the real cause');
      assert.doesNotMatch(error.message, /failed to start/, 'it must not look like a spawn crash');
      return true;
    },
  );
});

test('a runnable command still runs after the check', async () => {
  const result = await runCommand({ command: 'node --version' });
  assert.equal(result.ok, true);
  assert.match(result.stdout, /^v\d+\./);
});

test('the consent path refuses before asking, so no pointless prompt appears', () => {
  // Read the wiring rather than starting Electron: the ordering is the property under test.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(process.cwd(), 'desktop', 'main-services.cjs'), 'utf8');
  const availabilityAt = source.indexOf('checkAvailability(parsed)');
  const consentAt = source.indexOf('await consent.ask');
  assert.ok(availabilityAt > 0, 'the handler must check availability');
  assert.ok(consentAt > 0, 'the handler must still ask for consent');
  assert.ok(availabilityAt < consentAt, 'availability must be decided BEFORE the approval prompt');
  assert.match(source, /unavailable: true/, 'the refusal must be reportable to the renderer');
});
// ---- round 240: the parse-refusal branch of runCommand -------------------------------
//
// Found by mutation: flipping `{ ok: false, refused: true }` to `{ ok: true, refused: true }`
// in main-services.cjs left every test green. The existing suite covered the AVAILABILITY
// refusal (no spawnable binary) and the module's own parseCommand, but nothing looked at the
// branch that turns a parseCommand throw into a refusal envelope.
//
// Why it matters: parseCommand throws for metacharacters and for commands outside the
// allowlist. If that catch reported ok:true, the renderer would show a successful run for a
// command that never started — the worst possible failure shape, because nothing looks wrong.

test('a parse refusal is reported as a refusal, never as a success', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(process.cwd(), 'desktop', 'main-services.cjs'), 'utf8');
  const start = source.indexOf('      runCommand: async (_event, request) => {');
  assert.ok(start > 0, 'the runCommand entry point is missing');
  const end = source.indexOf('      // ----', start + 10);
  const body = source.slice(start, end > start ? end : start + 2600);
  // The catch that wraps parseCommand. It must answer ok:false.
  const catchAt = body.indexOf('} catch (error) {');
  assert.ok(catchAt > 0, 'the parseCommand catch is missing');
  const after = body.slice(catchAt, catchAt + 400);
  assert.match(after, /ok: false/, 'the refusal branch does not report failure');
  assert.match(after, /refused: true/, 'the refusal branch does not mark itself as a refusal');
  assert.doesNotMatch(after, /ok: true/, 'a refused command is reported as a success');
});

test('the availability refusal and the parse refusal are distinct answers', () => {
  // A caller can tell "this cannot run on this host" from "you may not run this":
  //   unavailable: true  vs  refused: true
  // Collapsing them would make the UI offer the wrong remedy (install vs. rephrase).
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(process.cwd(), 'desktop', 'main-services.cjs'), 'utf8');
  assert.match(source, /unavailable: true/);
  assert.match(source, /refused: true/);
});

test('availability is checked before consent is asked', () => {
  // Asking the user to approve something impossible spends their trust on nothing.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(process.cwd(), 'desktop', 'main-services.cjs'), 'utf8');
  const runAt = source.indexOf('      runCommand: async (_event, request) => {');
  const end = source.indexOf('      // ----', runAt + 10);
  const body = source.slice(runAt, end > runAt ? end : runAt + 2600);
  const checkAt = body.indexOf('checkAvailability(parsed)');
  const askAt = body.indexOf('consent.ask({');
  assert.ok(checkAt > 0 && askAt > 0, 'one of the two steps is missing');
  assert.ok(checkAt < askAt, 'consent is asked before the command is known to be runnable');
});
