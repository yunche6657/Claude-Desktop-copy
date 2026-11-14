// R450 (v2): the other three checkable claims — all three hold.
//
// 1. RemoteTrigger: "the OAuth token is added automatically in-process and never reaches the shell"
//    -> TRUE. The token is read via getClaudeAIOAuthTokens(), placed in a `headers` object, and sent
//       with axios.request({ headers }). No spawn/exec/execFile anywhere in the file, so no shell is
//       involved at all.
//
//       A first pass got this WRONG: the check regex looked for `headers: {` and the code says
//       `const headers = {`, so it reported "token in HTTP header: false" and then "claim holds:
//       false". Reading the file settled it. That is the same lesson as R447's misaligned parser and
//       R449's missed untracked files: a negative result from a pattern match means the pattern is
//       wrong until proven otherwise.
//
// 2. FileReadTool: "It is okay to read a file that does not exist; an error will be returned."
//    -> TRUE, and deliberately so: the ENOENT path is caught and allowed through so that call()
//       can offer findSimilarFile suggestions. It returns a friendly error, not a crash. The source
//       comment says exactly that (upstream's own Chinese comment, R424's note).
//
// 3. BashTool: "The working directory persists between commands, but shell state does not."
//    -> NOT VERIFIED. The claim is about persistent-shell behaviour across invocations;
//       ShellCommand.ts holds only an error message mentioning a deleted cwd. The mechanism lives in
//       code this round did not locate, and runtime testing is blocked (R444/R445). Recording it as
//       unverified rather than assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const RT = path.join(TOOLS, 'RemoteTriggerTool', 'RemoteTriggerTool.ts');
const FR = path.join(TOOLS, 'FileReadTool', 'FileReadTool.ts');

test('RemoteTrigger puts the token in an HTTP header and never spawns a process', () => {
  const t = read(RT);

  // The token reaches a headers object.
  assert.match(t, /Authorization:\s*`Bearer \$\{accessToken\}`/,
    'the bearer header pattern changed: re-derive where the token goes');

  // And that headers object is what axios is given — the two facts together are the whole claim.
  assert.match(t, /const headers = \{[\s\S]{0,200}?Authorization/,
    'headers is no longer the object that carries the token');
  assert.match(t, /axios\.request\(\{[\s\S]{0,200}?headers/,
    'axios no longer receives the headers object');

  // No process is spawned, which is why "never reaches the shell" is literally true.
  assert.ok(!/\b(spawn|execFile|execSync|exec)\s*\(/.test(t),
    'a process spawn appeared: the token could now leave the process, so the claim needs re-checking');
  assert.ok(!/\bshell\s*:\s*true/.test(t), 'a shell option appeared');
});

test('the token is never placed in argv or env', () => {
  // Both would be shell-visible. Checked separately from the spawn test because a spawn could be
  // added later without those words appearing.
  const t = read(RT);
  assert.ok(!/(?:args|argv|command)\s*:[^;\n]{0,200}accessToken/.test(t),
    'the token is being passed as a command argument');
  assert.ok(!/env:\s*\{[\s\S]{0,300}?accessToken/.test(t),
    'the token is being passed through the environment');
});

test('FileRead allows ENOENT through on purpose, to offer suggestions', () => {
  const t = read(FR);
  // The catch branch must NOT rethrow ENOENT; it lets call() produce a helpful error.
  assert.match(t, /if \(!isENOENT\(e\)\) throw e/,
    'the ENOENT carve-out changed: a missing file may now crash instead of erroring cleanly');
  assert.match(t, /findSimilarFile/,
    'the suggestion helper is gone: the "okay to read a missing file" behaviour loses its point');
});

test('cwd persistence remains UNVERIFIED — recorded, not assumed', () => {
  // The claim: "working directory persists between commands, but shell state does not."
  // This round did not locate the persistent-shell mechanism. The test asserts only that the claim
  // text exists, so a future round can find it and verify properly.
  const prompt = read(TOOLS, 'BashTool', 'prompt.ts');
  assert.match(prompt, /working directory persists between commands/i,
    'the claim is gone: if the description was corrected, this note should be updated');
  // And it is genuinely not verifiable from ShellCommand.ts, which only mentions cwd in an error.
  const shell = path.join(SRC, 'src', 'utils', 'ShellCommand.ts');
  assert.ok(fs.existsSync(shell), 'ShellCommand.ts is gone');
  const shellText = read(shell);
  assert.ok(!/persistentShell|shellState|restoreCwd/i.test(shellText),
    'ShellCommand.ts now holds the persistence mechanism this test said was elsewhere — verify the '
    + 'claim properly and delete this note');
});
