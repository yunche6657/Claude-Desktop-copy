// What the executor accepts, and what it still refuses.
//
// Measured this round through the Bash tool:
//
//   node --version              -> v24.19.0            accepted
//   node -e console.log(42)     -> 42                  accepted
//   node -e "console.log(6*7)"  -> refused: quoting unsupported (says so, with advice)
//   node -v; rm -rf /           -> refused: shell operators
//   node -v | cat               -> refused: shell operators
//   echo $(whoami)              -> refused: shell operators
//
// The first refusal used to be silent: the quotes stayed in the argument, node printed
// nothing, and the model could only guess why. It then proposed writing a script file -
// a working detour the allowlist was never meant to force.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseCommand } = require(path.join(ROOT, 'desktop', 'local-exec.cjs'));

test('parentheses and braces no longer block an ordinary command', () => {
  // shell: false means these bytes reach the program verbatim; refusing them only stopped
  // legitimate node -e / python -c calls.
  const parsed = parseCommand('node -e console.log(42)');
  assert.equal(parsed.executable, 'node');
  assert.deepEqual(parsed.args, ['-e', 'console.log(42)']);
});

test('command substitution is still refused', () => {
  // $(...) and backticks are the classic injection pattern and stay blocked.
  for (const command of ['echo $(whoami)', 'echo `id`']) {
    assert.throws(() => parseCommand(command), /shell operators/, JSON.stringify(command));
  }
});

test('paired quotes are stripped so an inline program survives', () => {
  // Quoting used to be refused outright. Measured: the model asked for
  // node -e "console.log(6*7)", was refused, and retried the same shape of command
  // repeatedly because nothing told it why. stripQuotes removes the quote characters the
  // child never sees; there is still no shell, so nothing is expanded.
  const parsed = parseCommand('node -e "console.log(6*7)"');
  assert.equal(parsed.executable, 'node');
  assert.deepEqual(parsed.args, ['-e', 'console.log(6*7)']);
});

test('an operator inside quotes is data, not a separator', () => {
  // node -e "a; b" is an ordinary inline program; the semicolon belongs to the source.
  const parsed = parseCommand('node -e "const a=1; console.log(a)"');
  assert.deepEqual(parsed.args, ['-e', 'const a=1; console.log(a)']);
});

test('an unbalanced quote is refused rather than guessed at', () => {
  // Unlike a shell, this never tries to recover: a half-open string is a mistake.
  assert.throws(() => parseCommand('node -e "console.log(1)'), /unbalanced quote/);
});

test('the refusal message names the operators it blocks', () => {
  // A bare 'metacharacters' left the caller guessing which character was the problem.
  try {
    parseCommand('node -v; rm -rf /');
    assert.fail('a chained command was accepted');
  } catch (error) {
    assert.match(error.message, /shell operators/);
    assert.match(error.message, /no shell/);
  }
});
