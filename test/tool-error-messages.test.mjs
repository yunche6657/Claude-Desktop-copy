// Every tool error must let its reader change the next call — the second half of round 215.
//
// Round 215 fixed four messages in file-tools.cjs (not-found, outside-root, not-a-file,
// too-large) and round 218 added the alternative for too-large. This file covers the rest of
// the inventory: the same judge is applied to every remaining fail()/throw in
// desktop/file-tools.cjs, tools.cjs, local-exec.cjs and workspace-tree.cjs, and each message
// below was triggered live before it was edited.
//
// What "actionable" means here, concretely. The caller cannot widen the approved roots, install
// a binary, or open a folder picker; it can only change its OWN arguments or call another tool.
// So an actionable message must name one of those two repairs. Examples of messages that failed
// that test and were rewritten:
//
//   "a path is required"                       -> which argument? what form?
//   "command is empty"                         -> what do I send instead?
//   "executable "powershell" is not in the allowlist" -> what IS allowed?
//   "directory does not exist: <path>"         -> how do I find the right path?
//   "path escapes the workspace: <path>"       -> how do I phrase a path that stays inside?
//   "file is N bytes" (write path)             -> Read/Edit fail the same way; what CAN patch it?
//
// Messages deliberately left alone, with the reason:
//   "old_string must be a non-empty string"  — names the argument and the constraint; the
//                                              repair (send the text) is the whole message.
//   "old_string was not found in the file; read the file first and copy the text exactly"
//   "old_string occurs N times; include more surrounding context to make it unique"
//   "new_string must be a string"            — same shape as old_string's; both name themselves.
//   "no workspace is selected; pass an absolute path" — names the repair already.
//   tool-approval.cjs's "Unknown tool: <name>" is out of scope: another module owns it and it
//   was not in this task's write scope.
//
// Each message was triggered live before and after the edit (a probe that prints the real text,
// not the source). 25 message sites were changed and 26 tests cover them: the unknown-skill
// message has two branches (a non-empty catalogue and an empty one) and each needs its own
// answer, because "pass one of those names" is unfollowable when there are none.
//
// Every test was then checked against a mutation that deletes its advice clause: 26 mutations,
// 26 tests went red — exactly one each, and the file went green again when the source was
// restored. A test that stayed green would be measuring the diagnosis instead of the repair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fileTools = require(path.join(ROOT, 'desktop', 'file-tools.cjs'));
const exec = require(path.join(ROOT, 'desktop', 'local-exec.cjs'));
const tree = require(path.join(ROOT, 'desktop', 'workspace-tree.cjs'));
const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));

/** Run a call that must fail and return the text the caller would read. */
function messageOf(run) {
  try {
    run();
  } catch (error) {
    return String(error.message);
  }
  throw new Error('the call was expected to fail but succeeded');
}

async function asyncMessageOf(run) {
  try {
    await run();
  } catch (error) {
    return String(error.message);
  }
  throw new Error('the call was expected to fail but succeeded');
}

/** A temp workspace, plus the tool set bound to it. */
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg2-'));
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: dir, allowedRoots: [dir], execRoots: [dir] }).map((t) => [t.name, t]),
  );
  return { dir, byName, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---- file-tools.cjs -------------------------------------------------------------------

test('invalid-path names the argument and the form it wants', () => {
  // Before: "a file path is required" — a caller that DID send the key (as "", null or a
  // number) could not tell what was wrong with it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-path-'));
  try {
    for (const bad of ['', '   ', 42, null]) {
      const message = messageOf(() => fileTools.resolveInsideRoots(bad, [dir]));
      assert.match(message, /a file path is required/, 'the diagnosis is gone for ' + JSON.stringify(bad));
      assert.match(message, /"path"/, 'the argument name is not given: ' + message);
      assert.match(message, /non-empty string/, 'the expected form is not given: ' + message);
      assert.match(message, /\{path: "/, 'no example value is given: ' + message);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no-root says that a path cannot fix it and names the tool that still works', () => {
  // Before: "no workspace root is approved; select a folder first" — the second half is an
  // instruction for a HUMAN. The model has no folder picker, so it retries with other paths.
  const message = messageOf(() => fileTools.resolveInsideRoots('x.txt', []));
  assert.match(message, /no workspace root is approved/, 'the diagnosis is gone');
  assert.match(message, /Ask the user to open a folder/, 'no repair is named for the caller');
  assert.match(message, /a different path cannot help/, 'it does not say that path juggling is futile');
  assert.match(message, /Skill tool still works/, 'no tool is named that still works without a root');
});

test('invalid-content says which argument and which value shapes are wrong', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-content-'));
  try {
    const message = messageOf(() => fileTools.previewWrite(path.join(dir, 'a.txt'), 123, { allowedRoots: [dir] }));
    assert.match(message, /content must be a string/, 'the diagnosis is gone');
    assert.match(message, /"content"/, 'the argument name is not given');
    assert.match(message, /empty string is allowed/, 'the boundary case is not stated');
    assert.match(message, /not a number, null, object or array/, 'the wrong shapes are not listed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the write-path too-large refusal names a tool that can still touch the file', () => {
  // This is a DIFFERENT statement from the read-path one fixed in round 218: it was a bare
  // "file is N bytes" with no code and no next step, and it is what a Write against a large
  // file hits. Read/Edit/Write all go through the same 2 MB read, so pointing at them would
  // be a circle; the honest repair is a command.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-bigwrite-'));
  try {
    const big = path.join(dir, 'big.json');
    fs.writeFileSync(big, Buffer.alloc(fileTools.MAX_READ_BYTES + 1, 0x78));
    const message = messageOf(() => fileTools.previewWrite(big, 'x', { allowedRoots: [dir] }));
    assert.match(message, /^file is \d+ bytes/, 'the size is no longer reported');
    assert.match(message, /diff limit is \d+/, 'the limit is no longer reported');
    assert.match(message, /Read and Edit refuse it for the same reason/,
      'it does not warn that the obvious alternatives fail the same way');
    assert.match(message, /Bash/, 'no tool that can actually patch the file is named');
    assert.match(message, /Glob/, 'no alternative for finding a smaller file is named');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- local-exec.cjs -------------------------------------------------------------------

test('an unbalanced quote says how to close or drop it', () => {
  // Before: "unbalanced quote in command". The caller knows what it sent; it needs to know
  // whether to add a character or remove one.
  const message = messageOf(() => exec.parseCommand('node -e "console.log(1)'));
  assert.match(message, /unbalanced quote in command/, 'the diagnosis is gone');
  assert.match(message, /opened and never closed/, 'the cause is not explained');
  assert.match(message, /close it|remove both/, 'no repair is offered');
  assert.match(message, /same quote character/, 'the repair is not specific enough to apply');
});

test('an empty command says what a valid command looks like', () => {
  const message = messageOf(() => exec.parseCommand('   '));
  assert.match(message, /command is empty/, 'the diagnosis is gone');
  assert.match(message, /"command"/, 'the argument name is not given');
  assert.match(message, /\{command: "/, 'no example value is given');
});

test('a non-string command names the argument and rules out an argv array', () => {
  // "command must be a string" leaves the likely mistake — sending ["git","status"] — open.
  const message = messageOf(() => exec.parseCommand(['git', 'status']));
  assert.match(message, /command must be a string/, 'the diagnosis is gone');
  assert.match(message, /"command"/, 'the argument name is not given');
  assert.match(message, /not an argv array/, 'the likely mistake is not ruled out');
});

test('an oversized command reports both numbers and where to put the content instead', () => {
  const message = messageOf(() => exec.parseCommand('git ' + 'a'.repeat(5000)));
  assert.match(message, /command is too long/, 'the diagnosis is gone');
  assert.match(message, /5004 characters/, 'the actual length is missing');
  assert.match(message, /limit is 4096/, 'the limit is missing');
  assert.match(message, /Write a script/, 'no way to send a long program is named');
});

test('a shell-operator refusal names the drop-the-operator repair and a no-approval alternative', () => {
  const message = messageOf(() => exec.parseCommand('ls -1 | wc -l'));
  assert.match(message, /shell operators/, 'the diagnosis is gone');
  assert.match(message, /no shell/, 'the reason is gone');
  assert.match(message, /drop the pipe or redirection/, 'no repair is offered');
  assert.match(message, /Read \/ List \/ Glob/, 'no tool that avoids the problem is named');
});

test('an unlisted executable is answered with the list of listed ones', () => {
  // Before: 'executable "powershell" is not in the allowlist'. The caller's only move was to
  // guess another name; each guess is a round trip.
  const message = messageOf(() => exec.parseCommand('powershell -c whoami'));
  assert.match(message, /executable "powershell" is not in the allowlist/, 'the diagnosis is gone');
  assert.match(message, /the accepted names are:/, 'the accepted set is not introduced');
  // Assert the LIST is actually present, not that the words node/git appear somewhere: both
  // are named again in the fixed tail sentence ("node and git are the safest"), so matching
  // them alone left this test green when the entire list was removed — found by mutation.
  const listed = [...exec.ALLOWED_EXECUTABLES].filter((name) => message.includes(name));
  assert.equal(listed.length, exec.ALLOWED_EXECUTABLES.size,
    'the refusal does not list every accepted name (' + listed.length + ' of ' + exec.ALLOWED_EXECUTABLES.size + ')');
  assert.match(message, /Read \/ List \/ Glob/, 'no non-command alternative is named');
  // The list is names, not programs: several are absent on Windows. Claiming they all start
  // would send the caller into the availability refusal, which is a different message.
  assert.match(message, /some accepted names are absent/, 'the message over-promises that every name runs');
});

test('an unspawnable-but-allowlisted name says not to retry it', () => {
  // Injected resolver, so this is the same answer on every host: the failure being described
  // is "the name is allowlisted and still cannot run", not "this machine lacks node".
  const verdict = exec.checkAvailability(exec.parseCommand('echo hi'), { resolve: () => null });
  assert.equal(verdict.available, false);
  assert.match(verdict.reason, /allowlisted but this machine has no spawnable binary/, 'the diagnosis is gone');
  assert.match(verdict.reason, /do not retry it/, 'nothing tells the caller that retrying is futile');
  assert.match(verdict.reason, /node and git/, 'no replacement program is named');
  assert.match(verdict.reason, /Read \/ List \/ Glob/, 'no non-command alternative is named');
});

test('a missing working directory says to omit cwd or list for a real one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-cwd-'));
  try {
    const message = messageOf(() => exec.resolveCwd(path.join(dir, 'nope'), [dir]));
    assert.match(message, /working directory does not exist/, 'the diagnosis is gone');
    assert.match(message, /omit cwd/, 'the caller\'s own parameter is not offered as the repair');
    assert.match(message, /workspace root/, 'the fallback behaviour is not stated');
    assert.match(message, /List to find a directory/, 'no way to find a real directory is named');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file used as a working directory says cwd must be a folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-cwdfile-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const message = messageOf(() => exec.resolveCwd(path.join(dir, 'a.txt'), [dir]));
    assert.match(message, /working directory is not a directory/, 'the diagnosis is gone');
    assert.match(message, /cwd must be a folder/, 'the constraint on the argument is not stated');
    assert.match(message, /parent directory|omit cwd/, 'no repair is offered');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an out-of-root working directory says to stay inside or omit cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-cwdroot-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-cwdout-'));
  try {
    const message = messageOf(() => exec.resolveCwd(outside, [dir]));
    assert.match(message, /working directory is outside the approved roots/, 'the diagnosis is gone');
    assert.match(message, /inside the workspace/, 'the boundary is not restated as a rule');
    assert.match(message, /omit cwd/, 'the caller\'s own parameter is not offered as the repair');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ---- workspace-tree.cjs ---------------------------------------------------------------

test('a missing workspace root says a retry cannot fix it and who can', () => {
  // The root is the user's choice; the caller cannot repair it by trying another path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-tree-'));
  try {
    const message = messageOf(() => tree.listTree(path.join(dir, 'gone')));
    assert.match(message, /workspace does not exist/, 'the diagnosis is gone');
    assert.match(message, /ask the user to open a folder/, 'no repair is named');
    assert.match(message, /moved or been deleted/, 'the likely cause is not stated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a workspace root that is a file says the same thing, in its own words', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-treefile-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const message = messageOf(() => tree.listTree(path.join(dir, 'a.txt')));
    assert.match(message, /workspace is not a directory/, 'the diagnosis is gone');
    assert.match(message, /ask the user to open the containing folder/, 'no repair is named');
    assert.notEqual(message, messageOf(() => tree.listTree(path.join(dir, 'gone'))),
      'a missing root and a file root report the same text, so one of them is wrong');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an escaping path says to pass a root-relative one', () => {
  // "path escapes the workspace" states the rule; it does not tell the caller that its
  // argument is interpreted as root-relative, which is the only detail that fixes it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-escape-'));
  try {
    const message = messageOf(() => tree.listDirectory(dir, '../etc'));
    assert.match(message, /path escapes the workspace/, 'the diagnosis is gone');
    assert.match(message, /relative to the workspace root/, 'the argument\'s basis is not stated');
    assert.match(message, /drop the leading "\.\."/, 'no concrete repair is offered');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing directory says to list the parent or glob for the path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-nodir-'));
  try {
    const message = messageOf(() => tree.listDirectory(dir, 'nope'));
    assert.match(message, /directory does not exist/, 'the diagnosis is gone');
    assert.match(message, /List "\." lists the workspace root/, 'no listing step is named');
    assert.match(message, /Glob/, 'no way to find the path is named');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file where a directory was meant points at Read and at the parent listing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-notdir-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const message = messageOf(() => tree.listDirectory(dir, 'a.txt'));
    assert.match(message, /not a directory/, 'the diagnosis is gone');
    assert.match(message, /use Read to read it/, 'the tool for the actual intent is not named');
    assert.match(message, /List its parent directory/, 'no way to find the intended folder is named');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- tools.cjs ------------------------------------------------------------------------

test('Read with no path names the argument it needs', async () => {
  const w = workspace();
  try {
    for (const input of [{}, { path: '' }, { path: null }]) {
      const message = await asyncMessageOf(() => w.byName.Read.handler(input));
      assert.match(message, /a path is required/, 'the diagnosis is gone for ' + JSON.stringify(input));
      assert.match(message, /"path"/, 'the argument name is not given');
      assert.match(message, /\{path: "/, 'no example value is given');
    }
  } finally { w.cleanup(); }
});

test('List with no workspace says the argument cannot fix it and names a tool that can', async () => {
  const byName = Object.fromEntries(
    defineTools({ allowedRoots: [] }).map((t) => [t.name, t]),
  );
  const message = await asyncMessageOf(() => byName.List.handler({}));
  assert.match(message, /no workspace is selected/, 'the diagnosis is gone');
  assert.match(message, /ask the user to open a folder/, 'no repair is named');
  assert.match(message, /Skill tool still works/, 'no tool is named that works without a root');
});

test('Glob with no workspace gives its own answer, not List\'s', async () => {
  // The two tools fail for the same reason but leave different options: a pattern is matched
  // against workspace-relative paths, so a pattern is not a repair either.
  const byName = Object.fromEntries(
    defineTools({ allowedRoots: [] }).map((t) => [t.name, t]),
  );
  const message = await asyncMessageOf(() => byName.Glob.handler({ pattern: '*' }));
  assert.match(message, /no workspace is selected/, 'the diagnosis is gone');
  assert.match(message, /no tree to search/, 'Glob does not say what is missing, unlike List');
  assert.match(message, /ask the user to open a folder/, 'no repair is named');
});

/** A fake installation shipping the given skills, plus a workspace store. */
function skillFixture(skills) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-skill-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-skill-ws-'));
  for (const [name, files] of Object.entries(skills)) {
    // The directory is created even with no files: a listed-but-unreadable skill is a real
    // shape (an empty folder dropped into the store), not a fixture accident.
    fs.mkdirSync(path.join(ws, '.data', 'skills', name), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(ws, '.data', 'skills', name, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, 'utf8');
    }
  }
  return { home, ws };
}

function withSkillEnv(fixture) {
  const saved = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    CLAUDE_WORKSPACE: process.env.CLAUDE_WORKSPACE,
  };
  process.env.USERPROFILE = fixture.home;
  process.env.HOME = fixture.home;
  process.env.CLAUDE_WORKSPACE = fixture.ws;
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: fixture.ws, allowedRoots: [fixture.ws] }).map((t) => [t.name, t]),
  );
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(fixture.home, { recursive: true, force: true });
    fs.rmSync(fixture.ws, { recursive: true, force: true });
  };
}

const SKILL_MD = (name) => '---\nname: ' + name + '\ndescription: A fixture skill.\n---\n\nBody.\n';

test('an unknown skill name says which names exist and how to list them', async () => {
  const fixture = skillFixture({ docx: { 'SKILL.md': SKILL_MD('docx') } });
  const restore = withSkillEnv(fixture);
  try {
    const tools = defineTools({ workspaceRoot: fixture.ws, allowedRoots: [fixture.ws] });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const message = await asyncMessageOf(() => byName.Skill.handler({ name: 'nope' }));
    assert.match(message, /No skill named "nope"/, 'the diagnosis is gone');
    assert.match(message, /Installed: docx/, 'the real names are not listed');
    assert.match(message, /pass one of those names exactly/, 'no repair is named');
    assert.match(message, /Skill with no argument/, 'the listing call is not named');
  } finally { restore(); }
});

test('an unknown skill name with nothing installed does not send the caller in a circle', async () => {
  // With an empty catalogue the old shape read "Installed: ; pass one of those names" — advice
  // that cannot be followed. This branch must say that no name can work.
  const fixture = skillFixture({});
  const restore = withSkillEnv(fixture);
  try {
    const tools = defineTools({ workspaceRoot: fixture.ws, allowedRoots: [fixture.ws] });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const message = await asyncMessageOf(() => byName.Skill.handler({ name: 'docx' }));
    assert.match(message, /No skill named "docx"/, 'the diagnosis is gone');
    assert.match(message, /no skills are installed/, 'the empty catalogue is not mentioned');
    assert.match(message, /do the task without a skill/, 'no repair is offered');
  } finally { restore(); }
});

test('a skill with no readable files says the attempt is closed and what to do instead', async () => {
  // An empty directory is a skill the catalogue lists and nothing can open; retrying with a
  // file argument would fail identically, so the message must say so.
  const fixture = skillFixture({ 'empty-skill': {} });
  const restore = withSkillEnv(fixture);
  try {
    const tools = defineTools({ workspaceRoot: fixture.ws, allowedRoots: [fixture.ws] });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const message = await asyncMessageOf(() => byName.Skill.handler({ name: 'empty-skill' }));
    assert.match(message, /has no readable files/, 'the diagnosis is gone');
    assert.match(message, /do not retry it with a file argument/, 'it does not close the dead end');
    assert.match(message, /other installed skills/, 'no alternative is named');
  } finally { restore(); }
});

test('a missing file inside a skill lists the real paths and the default', async () => {
  const fixture = skillFixture({
    docx: { 'SKILL.md': SKILL_MD('docx'), 'REFERENCE.md': 'ref\n' },
  });
  const restore = withSkillEnv(fixture);
  try {
    const tools = defineTools({ workspaceRoot: fixture.ws, allowedRoots: [fixture.ws] });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const message = await asyncMessageOf(() => byName.Skill.handler({ name: 'docx', file: 'MISSING.md' }));
    assert.match(message, /has no file "MISSING\.md"/, 'the diagnosis is gone');
    assert.match(message, /REFERENCE\.md/, 'the real file names are not listed');
    assert.match(message, /pass one of those paths exactly/, 'no repair is named');
    assert.match(message, /omit file to read SKILL\.md/, 'the default is not stated');
  } finally { restore(); }
});