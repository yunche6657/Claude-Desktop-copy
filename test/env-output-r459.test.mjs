// R459: /env demonstrably prints ANTHROPIC_CUSTOM_HEADERS in full — measured on the real formatter.
//
// WHAT R458 HAD
//   A classification: ANTHROPIC_CUSTOM_HEADERS passes the allowlist and matches no secret pattern, so
//   it should be printed. That was an inference about two predicates.
//
// WHAT THIS ROUND DID
//   Extracted formatEnvVars() and its predicates VERBATIM from src/commands/env/index.ts, seeded a
//   realistic environment, and read the rendered string:
//
//       ANTHROPIC_API_KEY=sk-a…yz (32 chars)                                <- masked
//       ANTHROPIC_CUSTOM_HEADERS=Authorization: Bearer TOPSECRET_TOKEN_xyz  <- IN FULL
//       CLAUDE_CODE_TEST_MARKER=visible-ok                                  <- allowlisted, shown
//   and SOME_UNLISTED_VAR was absent entirely.
//
//   The controls matter: API_KEY masked and the unlisted var hidden prove the filter is doing its job
//   for those cases. Only the headers value comes through whole.
//
// WHY THAT VALUE MATTERS
//   src/services/api/client.ts:120 reads an Authorization header out of it:
//       `has Authorization header: ${!!customHeaders['Authorization']}`
//   and subprocessEnv.ts:21 lists it among the names to scrub from child processes — i.e. the same
//   codebase treats it as secret in one place and printable in another.
//
// NOT FIXED HERE
//   This is upstream code and the contract does not specify /env's output. Recorded as a demonstrated
//   inconsistency, not repaired: adding a pattern or removing the allowlist entry would be an
//   improvement to the software, not a fidelity fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const BUN = path.join(ROOT, 'agent-core', 'bun', 'bun.exe');
const CMD = path.join(SRC, 'src', 'commands', 'env', 'index.ts');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

/** The formatter and its predicates, sliced from the real file. */
function extractFormatter() {
  const src = read(CMD);
  const predStart = src.indexOf('const SECRET_KEY_PATTERNS');
  const fmtStart = src.indexOf('function formatEnvVars()');
  const fmtEnd = src.indexOf('function formatRuntime()');
  assert.ok(predStart >= 0 && fmtStart > predStart && fmtEnd > fmtStart,
    'the command file layout changed: re-derive the extraction');
  return { predicates: src.slice(predStart, fmtStart).trimEnd(), formatter: src.slice(fmtStart, fmtEnd).trimEnd() };
}

const SECRET = 'TOPSECRET_TOKEN_xyz';

test('/env prints ANTHROPIC_CUSTOM_HEADERS verbatim while masking ANTHROPIC_API_KEY', (t) => {
  if (!fs.existsSync(BUN)) {
    t.skip('bun not available');
    return;
  }
  const { predicates, formatter } = extractFormatter();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r459-'));
  const probe = `
${predicates}

process.env.ANTHROPIC_CUSTOM_HEADERS = "Authorization: Bearer ${SECRET}"
process.env.ANTHROPIC_API_KEY = "sk-ant-api03-${SECRET}"
process.env.SOME_UNLISTED_VAR = "${SECRET}"
process.env.CLAUDE_CODE_TEST_MARKER = "visible-ok"

${formatter}

console.log(formatEnvVars())
`;
  const p = path.join(dir, 'p.ts');
  fs.writeFileSync(p, probe);
  const r = spawnSync(BUN, [p], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  const rendered = r.stdout || '';
  assert.ok(rendered.includes('ANTHROPIC_CUSTOM_HEADERS'),
    'probe produced no output: ' + (r.stderr || '').slice(0, 300));

  // THE FINDING: the secret appears verbatim in the rendered string.
  assert.ok(rendered.includes(SECRET),
    'ANTHROPIC_CUSTOM_HEADERS is now masked: the leak is fixed, update R458/R459');

  // CONTROLS: the same secret must NOT survive through the masked path…
  assert.ok(!/ANTHROPIC_API_KEY=.*TOPSECRET/.test(rendered),
    'ANTHROPIC_API_KEY leaked too: the masking broke entirely, which is a different and worse defect');
  // …nor through the unlisted path.
  // The masked form uses a single U+2026 HORIZONTAL ELLIPSIS per maskValue(): `${slice(0,4)}…${slice(-2)} (N chars)`
  // A test for three ASCII dots fails against it — that was this test's own bug.
  assert.ok(/ANTHROPIC_API_KEY=\S*\u2026\S* \(\d+ chars\)/.test(rendered),
    'ANTHROPIC_API_KEY is no longer shown in masked form: ' + JSON.stringify(rendered.slice(0, 200)));

  // …nor through the unlisted path.
  assert.ok(!rendered.includes('SOME_UNLISTED_VAR'),
    'an unlisted variable was printed: the allowlist stopped filtering');

  // And a normal allowlisted variable still shows, so the test is not passing by rendering nothing.
  assert.ok(rendered.includes('CLAUDE_CODE_TEST_MARKER=visible-ok'),
    'a benign allowlisted variable disappeared');
}, { timeout: 150000 });

test('the same codebase treats that variable as secret elsewhere', () => {
  // The inconsistency is what makes this worth recording rather than dismissing as "designed".
  const subenv = read(SRC, 'src', 'utils', 'subprocessEnv.ts');
  assert.match(subenv, /'ANTHROPIC_CUSTOM_HEADERS'/,
    'the name is no longer in the scrub list: if it is considered non-secret there too, the /env '
    + 'behaviour becomes consistent and this finding is void');

  const client = read(SRC, 'src', 'services', 'api', 'client.ts');
  assert.match(client, /customHeaders\[['"]Authorization['"]\]/,
    'the Authorization-header usage is gone: ANTHROPIC_CUSTOM_HEADERS may no longer carry '
    + 'credentials, which would make printing it harmless');
});

test('the masking patterns do not cover it — the lexical reason', () => {
  const { predicates } = extractFormatter();
  // Reproduce the predicate locally so the gap is visible without running bun.
  const patterns = [/token/i, /secret/i, /password/i, /api[_-]?key/i, /auth/i, /private/i,
    /credential/i, /jwt/i, /session[_-]?id$/i];
  const isSecret = (k) => patterns.some((rx) => rx.test(k));

  for (const masked of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.ok(isSecret(masked), masked + ' should match a secret pattern');
  }
  assert.ok(!isSecret('ANTHROPIC_CUSTOM_HEADERS'),
    'ANTHROPIC_CUSTOM_HEADERS now matches a secret pattern: it would be masked, so the leak is '
    + 'fixed and this test should be updated');

  // The predicate source still declares those patterns.
  for (const token of ['/token/i', '/api[_-]?key/i', '/auth/i']) {
    assert.ok(predicates.includes(token), token + ' vanished from the source predicates');
  }
});
