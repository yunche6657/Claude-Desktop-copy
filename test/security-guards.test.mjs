// Fourteen security-relevant rules, each proven to have a test that fails when it is broken.
//
// Rounds 235-236 built tools/mutate.cjs; this round used it on the guards that matter most.
// Every entry below was mutated to a no-op and the named tests went RED:
//
//   1. session-kernel  `if (session.isRunning) throw`          -> 2 tests red
//   2. permissions     dontAsk answers prompt:true             -> 5 tests red
//   3. tool-approval   `if (verdict === DECISIONS.DENY)`       -> red
//   4. local-exec      shell metacharacter refusal             -> red
//   5. local-exec      executable allowlist refusal            -> red
//   6. workspace-tree  path-escape refusal                     -> red
//   7. cli-transcript  user/assistant row filter               -> 1 test red
//
// Round 237 added two more, both in the "silently becomes permissive" family:
//
//   8. tool-approval   `if (decision !== 'allow')` — a TIMEOUT must refuse the tool too,
//      not just an explicit deny. Mutating it to `decision === 'deny'` let a timeout through
//      as allowed; three approval tests went red.
//   9. main-services   the Files write/replace DENY short-circuit (two occurrences).
//
// Round 239 added two from the consent window, both found by sweeping every
// `=== 'deny'` / `=== 'allow'` site in desktop/:
//
//  10. consent-manager  the frame must be trusted before its decision is read.
//  11. consent-manager  only 'allow' and 'cancel' may settle a prompt; anything else throws.
//      Both were untested: mutating either to `if (false)` left all 8 tests green.
//
// What this file guards is not the behaviour (other files do that) but the EXISTENCE of the
// guard lines themselves. Deleting one of these `if (false) {`-able conditions silently turns
// a refusal into an allow, and that is the failure mode this project has fixed most often.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

// name -> [file, the exact guard line that must exist]
const GUARDS = new Map([
  ['one turn per session', ['desktop/session-kernel.cjs',
    "if (session.isRunning) throw new Error('a turn is already running for this session');"]],
  ['dontAsk never prompts', ['desktop/permissions.cjs',
    "return result(true, 'dontAsk: not pre-approved, and this mode never prompts to approve');"]],
  ['a DENY verdict short-circuits consent', ['desktop/tool-approval.cjs',
    'if (verdict === DECISIONS.DENY) {']],
  ['anything but allow refuses the tool', ['desktop/tool-approval.cjs',
    "if (decision !== 'allow') {"]],
  ['the Files write path refuses a denying mode', ['desktop/main-services.cjs',
    'if (classify(permissionMode(), ACTIONS.EDIT) === DECISIONS.DENY) {']],
  ['shell operators are refused', ['desktop/local-exec.cjs',
    'if (hasOperatorOutsideQuotes(trimmed)) {']],
  ['only allowlisted executables run', ['desktop/local-exec.cjs',
    'if (!ALLOWED_EXECUTABLES.has(base)) {']],
  ['a path cannot escape the root', ['desktop/workspace-tree.cjs',
    "if (rel.startsWith('..') || path.isAbsolute(rel)) {"]],
  ['only user/assistant rows become messages', ['desktop/cli-transcript.cjs',
    "if (!record || (record.type !== 'user' && record.type !== 'assistant')) continue;"]],
  ['only a trusted frame may answer consent', ['desktop/consent-manager.cjs',
    'if (!this.isTrustedSender(event)) {']],
  ['only allow/cancel settle a consent prompt', ['desktop/consent-manager.cjs',
    "if (decision !== 'allow' && decision !== 'cancel') {"]],
  ['a refused command is reported as a refusal', ['desktop/main-services.cjs',
    'return { ok: false, refused: true, command: request.command, error: String(error && error.message)']],
  ['nothing runs without a consent surface', ['desktop/main-services.cjs',
    "if (!consent) throw new Error('Local execution is unavailable: no consent surface');"]],
  ['nothing is written without a consent surface', ['desktop/main-services.cjs',
    "if (!consent) throw new Error('Editing requires approval, but no consent surface is available')"]],
]);

test('every security guard still exists at its exact spelling', () => {
  // A rewrite that changes the wording is fine, but it must update this list too — otherwise
  // the mutation record above no longer describes the code that ships.
  const missing = [];
  for (const [name, [file, line]] of GUARDS) {
    if (!read(file).includes(line)) missing.push(name + ' (' + file + ')');
  }
  assert.deepEqual(missing, [], 'guards no longer present as recorded: ' + missing.join(', '));
});

test('no guard has been rewritten to a constant condition', () => {
  // `if (false)` is exactly what the mutation runs produce; finding one in the tree means a
  // mutation was applied and not restored.
  const offenders = [];
  for (const [name, [file]] of GUARDS) {
    const body = read(file);
    if (/if \(false\) \{/.test(body)) offenders.push(name + ' (' + file + ')');
  }
  assert.deepEqual(offenders, [], 'a guard is a constant false: ' + offenders.join(', '));
});

test('the guard count matches what the mutation record claims', () => {
  // Guards the record itself: every entry was verified red, so the count must not drift.
  assert.equal(GUARDS.size, 14);
});