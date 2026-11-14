// What the model is told about the tools must be true, and its errors must be actionable.
//
// Measured this round by capturing the request body the real agent loop sends:
//
//   request keys: model, max_tokens, messages, system, tools
//   7 tools declared: Skill, Read, Write, Edit, List, Glob, Bash
//   every one carries an input schema with correct required fields
//   Bash description (316 chars) still contains the "NO shell" warning
//
// and the documented behaviours were checked against the implementation:
//   List() lists the workspace root, Read offset=1 starts at line 2,
//   Glob '**/*.txt' finds nested files, Edit replaces the match.
//
// One defect found and fixed: Edit failures said "oldText was not found", naming an internal
// variable the model never passed. A model reading that has no argument to correct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
const { defineTools, definitionsFor } = require(path.join(ROOT, 'desktop', 'tools.cjs'));
const { createApprovalExecutor } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));
const { replaceInFile } = require(path.join(ROOT, 'desktop', 'file-tools.cjs'));

/** Capture the first request body the agent sends to the model. */
async function firstModelRequest(workspace) {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(String(init && init.body ? init.body : '{}')));
    const body = JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
    return { ok: true, status: 200, async text() { return body; } };
  };
  try {
    const tools = defineTools({ workspaceRoot: workspace, allowedRoots: [workspace], execRoots: [workspace] });
    const execute = createApprovalExecutor({ mode: 'bypassPermissions', ask: async () => 'allow', tools, onEvent: () => {} });
    await runAgent({
      baseUrl: 'http://unused', apiKey: 'k', model: 'm', system: 'SYS-MARKER',
      messages: [{ role: 'user', content: 'hi' }],
      tools: definitionsFor(tools),
      execute,
      onEvent: () => {},
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies[0] || {};
}

test('every tool reaches the model with an input schema', async () => {
  // A tool with no schema leaves the model guessing argument names, and it retries.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-'));
  try {
    const request = await firstModelRequest(dir);
    assert.ok(Array.isArray(request.tools) && request.tools.length > 0, 'no tools were declared');
    for (const tool of request.tools) {
      const schema = tool.input_schema || tool.inputSchema;
      assert.ok(schema && schema.properties, tool.name + ' has no input schema');
      // `required` is legitimately absent when every argument is optional (Skill, List), so the
      // assertion is written without a guard: either it is an array, or the key is genuinely
      // absent (undefined). Anything else — a string, an object — is a schema bug.
      const required = schema.required;
      assert.ok(required === undefined || Array.isArray(required),
        tool.name + ' declares a non-array required: ' + JSON.stringify(required));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the required fields match what the handler needs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-req-'));
  try {
    const request = await firstModelRequest(dir);
    const byName = Object.fromEntries(request.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(byName.Read.input_schema.required, ['path']);
    assert.deepEqual(byName.Write.input_schema.required, ['path', 'content']);
    assert.deepEqual(byName.Edit.input_schema.required, ['path', 'old_string', 'new_string']);
    assert.deepEqual(byName.Glob.input_schema.required, ['pattern']);
    assert.deepEqual(byName.Bash.input_schema.required, ['command']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the system prompt is sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-'));
  try {
    const request = await firstModelRequest(dir);
    assert.ok(String(JSON.stringify(request.system || '')).includes('SYS-MARKER'),
      'the system prompt never reached the model');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Bash description warns that there is no shell', async () => {
  // Round 174: the model retried `node -e` repeatedly. A description that says what the tool
  // cannot do is the cheapest way to stop that.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desc-'));
  try {
    const request = await firstModelRequest(dir);
    const bash = request.tools.find((tool) => tool.name === 'Bash');
    assert.ok(bash, 'Bash was not declared');
    assert.match(bash.description, /NO shell/i, 'the no-shell warning was dropped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an Edit failure names the parameter the caller actually passed', async () => {
  // "oldText was not found" refers to a variable the model never sent; it cannot act on it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-msg-'));
  try {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'abc');
    assert.throws(
      () => replaceInFile(file, 'zzz', 'q', { allowedRoots: [dir] }),
      (error) => {
        assert.equal(error.code, 'no-match');
        assert.match(error.message, /old_string/, 'the message does not name old_string');
        assert.equal(/oldText/.test(error.message), false, 'the message leaks an internal name');
        assert.match(error.message, /read the file first/i, 'the message gives no next step');
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
