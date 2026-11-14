// R458: envOverrides cannot undo the scrub — but /env prints one secret in full.
//
// THE ORIGINAL QUESTION
//   Shell.ts spreads envOverrides AFTER ...subprocessEnv(), so any key an override returns would win
//   over a scrubbed name. R457 named this as its only remaining gap. Answer: no collision.
//
//     bashProvider.getEnvironmentOverrides     -> TMUX, TMPDIR, CLAUDE_CODE_TMPDIR, TMPPREFIX
//     powershellProvider.getEnvironmentOverrides -> same family
//     Shell.ts's own post-spread literals      -> SHELL, GIT_EDITOR, CLAUDECODE, CLAUDE_CODE_SESSION_ID
//     intersection with the 23 scrub names     -> EMPTY
//
// A PATH I EXPECTED AND DID NOT FIND
//   Both providers end with:
//       for (const [key, value] of getSessionEnvVars()) { env[key] = value }
//   and the comment calls it "/env vars". That looks like an unfiltered injection of arbitrary names
//   into the child env — a genuine bypass. It is not, because NOTHING WRITES THE MAP:
//       setSessionEnvVar       1 mention, declaration only, 0 callers
//       deleteSessionEnvVar    1 mention, declaration only, 0 callers
//       clearSessionEnvVars    1 caller (commands/clear/caches.ts), clears a map nobody fills
//       getSessionEnvVars      2 callers, both the provider loops above
//   So the loop always iterates zero times. The mechanism is latent: one implementation away from
//   defeating the scrub, with no name filter to stop it.
//
// AND /env IS NOT A SETTER
//   src/commands/env/index.ts is a VIEWER: it prints runtime info plus process.env entries filtered by
//   an allowlist, masking values whose KEY matches token|secret|password|api_key|auth|private|
//   credential|jwt|session_id. So "vars set via /env" in the provider comment describes a producer that
//   does not exist here.
//
// THE ONE REAL FINDING
//   Running all 23 scrub names through /env's OWN predicates:
//       hidden          18
//       masked           4   (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN,
//                             ANTHROPIC_FOUNDRY_API_KEY)
//       PRINTED IN FULL  1   ANTHROPIC_CUSTOM_HEADERS
//
//   ANTHROPIC_CUSTOM_HEADERS is allowlisted (ANTHROPIC_ prefix) and matches none of the secret
//   patterns — no "token", no "key", no "auth". Its own consumer proves it carries credentials:
//   src/services/api/client.ts:120 logs `has Authorization header: ${!!customHeaders['Authorization']}`.
//   And subprocessEnv lists it as secret enough to scrub.
//
//   So a command whose output the user (and the model) can read prints a header string that commonly
//   contains `Authorization: Bearer ...`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

function scrubList() {
  const m = /const GHA_SUBPROCESS_SCRUB = \[([\s\S]*?)\] as const/.exec(
    read(SRC, 'src', 'utils', 'subprocessEnv.ts'));
  assert.ok(m, 'the scrub list is gone');
  return [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]);
}

/** The two predicates from /env, transcribed. */
const SECRET_PATTERNS = [/token/i, /secret/i, /password/i, /api[_-]?key/i, /auth/i, /private/i,
  /credential/i, /jwt/i, /session[_-]?id$/i];
const ALLOW_PREFIXES = ['CLAUDE_', 'FEATURE_', 'ANTHROPIC_', 'BUN_', 'NODE_', 'GEMINI_', 'OPENAI_',
  'GROK_', 'CCR_', 'KAIROS_', 'BUGHUNTER_'];
const isSecret = (k) => SECRET_PATTERNS.some((r) => r.test(k));
const isShown = (k) => ALLOW_PREFIXES.some((p) => k.startsWith(p));

test('no provider override collides with a scrubbed name', () => {
  // The gap R457 named. Verified by reading both implementations' returned keys.
  const bash = read(SRC, 'src', 'utils', 'shell', 'bashProvider.ts');
  const ps = read(SRC, 'src', 'utils', 'shell', 'powershellProvider.ts');
  const shell = read(SRC, 'src', 'utils', 'Shell.ts');

  const assigned = new Set();
  for (const body of [bash, ps]) {
    for (const m of body.matchAll(/env\.([A-Z_][A-Z0-9_]*)\s*=/g)) assigned.add(m[1]);
    for (const m of body.matchAll(/env\[['"]([A-Z_][A-Z0-9_]*)['"]\]\s*=/g)) assigned.add(m[1]);
  }
  // The four literals Shell.ts sets after the spread.
  for (const m of shell.matchAll(/^\s{8}([A-Z_][A-Z0-9_]*)\s*:/gm)) assigned.add(m[1]);

  const collision = [...assigned].filter((k) => scrubList().includes(k));
  assert.deepEqual(collision, [],
    'an override now sets a scrubbed name: envOverrides CAN undo the scrub for ' + collision.join(', '));
});

test('the sessionEnvVars injection loop has no producer', () => {
  // Both providers loop over it, which reads like an unfiltered injection path. It is empty because
  // nothing writes the map. If that changes, the bypass becomes real — and there is no name filter.
  const files = ['src/utils/shell/bashProvider.ts', 'src/utils/shell/powershellProvider.ts'];
  for (const f of files) {
    assert.match(read(SRC, ...f.split('/')),
      /for \(const \[key, value\] of getSessionEnvVars\(\)\)/,
      f + ' no longer consumes session env vars');
  }

  // Count real callers of the writer outside its own module.
  let writerCalls = 0;
  const walk = (root) => {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
      const p = path.join(root, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
      const rel = path.relative(SRC, p);
      if (rel.includes('sessionEnvVars')) continue;
      const body = fs.readFileSync(p, 'utf8');
      writerCalls += (body.match(/\bsetSessionEnvVar\s*\(/g) || []).length;
    }
  };
  walk(path.join(SRC, 'src'));
  walk(path.join(SRC, 'packages'));
  assert.equal(writerCalls, 0,
    'something now SETS a session env var: the injection loop can carry arbitrary names into the '
    + 'child env, AFTER the scrub, with no filter — that is a real bypass');
});

test('/env is a viewer, not a setter', () => {
  const cmd = read(SRC, 'src', 'commands', 'env', 'index.ts');
  assert.match(cmd, /name: 'env'/, 'the command name changed');
  assert.match(cmd, /Show current environment/,
    'the description no longer says it only shows the environment');
  assert.ok(!cmd.includes('setSessionEnvVar'),
    '/env now sets session env vars: the comment in bashProvider would finally be accurate, and the '
    + 'scrub bypass above becomes reachable');
  // It reads process.env and filters.
  assert.match(cmd, /Object\.entries\(process\.env\)/, '/env no longer reads process.env');
});

test('exactly one scrub-list name is printed in full, and it carries credentials', () => {
  // The finding. Assert the set is exactly this one, so a new leak or a fix both surface.
  const leaked = scrubList().filter((k) => isShown(k) && !isSecret(k));
  assert.deepEqual(leaked, ['ANTHROPIC_CUSTOM_HEADERS'],
    'the set of scrub-list names printed unmasked by /env changed: ' + leaked.join(', '));

  // And prove this file is not a false positive: its consumer reads an Authorization header from it.
  const client = read(SRC, 'src', 'services', 'api', 'client.ts');
  assert.match(client, /ANTHROPIC_CUSTOM_HEADERS present[\s\S]{0,120}customHeaders\[['"]Authorization['"]\]/,
    'the Authorization-header usage is gone: ANTHROPIC_CUSTOM_HEADERS may no longer carry credentials, '
    + 'which would make this finding moot');
});

test('the masking list covers the other Anthropic secrets but not that one', () => {
  // Makes the gap legible: three of the four Anthropic names are caught, the fourth is not, and the
  // difference is purely lexical (no token/key/auth substring).
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.ok(isSecret(k), k + ' is no longer masked: the masking list regressed');
  }
  assert.ok(!isSecret('ANTHROPIC_CUSTOM_HEADERS'),
    'ANTHROPIC_CUSTOM_HEADERS is now masked: the leak is fixed, update R458');
});
