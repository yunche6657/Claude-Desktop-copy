import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeToolDisplayInput, projectToolDisplayEvent, projectTranscriptEntry } = require('../desktop/tool-display.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

test('command rows expose actual multiline command despite a generic description', () => {
  const raw = { description: '运行命令', command: 'Get-Location\nGet-ChildItem', timeout_ms: 1200 };
  const input = normalizeToolDisplayInput('PowerShell', raw);
  assert.equal(input.command, raw.command);
  assert.equal(input.description, `运行命令 — ${raw.command}`);
  assert.equal(input.timeout_ms, 1200);
  assert.equal(raw.description, '运行命令');
  assert.deepEqual(normalizeToolDisplayInput('PowerShell', input), input);
  assert.equal(normalizeToolDisplayInput('Bash', '{"cmd":"pwd"}').command, 'pwd');
});

test('file input aliases and agent parameters match the shipped renderer keys', () => {
  for (const name of ['Read', 'Write', 'Edit']) {
    assert.equal(normalizeToolDisplayInput(name, { path: 'C:\\work\\fixture.txt' }).file_path, 'C:\\work\\fixture.txt');
    assert.equal(normalizeToolDisplayInput(name, { file_path: 'canonical', path: 'legacy' }).file_path, 'canonical');
  }
  const input = normalizeToolDisplayInput('Agent', {
    description: 'Inspect the fixture', subagent_type: 'Explore', model: 'fixture-model', effort: 'high', prompt: 'Read fixture.txt',
  });
  assert.equal(input.description, 'Inspect the fixture — agent: Explore — model: fixture-model — effort: high — prompt: Read fixture.txt');
  assert.equal(input.prompt, 'Read fixture.txt');
  assert.deepEqual(normalizeToolDisplayInput('Agent', input), input,
    'repeated UI projection must not append agent details again');
  const noLabel = normalizeToolDisplayInput('Task', { model: 'fixture', prompt: 'inspect' });
  assert.deepEqual(normalizeToolDisplayInput('Task', noLabel), noLabel);
});

test('display parameters redact secret fields, commands, URLs and headers without changing raw input', () => {
  const raw = {
    description: 'run',
    command: 'API_KEY=fixture-key curl "https://u:fixture-pass@example.test/?token=fixture-query" --password fixture-flag -H "Authorization: Bearer fixture-bearer"',
    apiKey: 'fixture-object', env: { ACCESS_TOKEN: 'fixture-nested', PATH: 'C:\\bin' },
    headers: { Authorization: 'Bearer fixture-header', Cookie: 'session=fixture-cookie' },
  };
  const input = normalizeToolDisplayInput('Bash', raw);
  const display = JSON.stringify(input);
  for (const secret of ['fixture-key', 'fixture-pass', 'fixture-query', 'fixture-flag', 'fixture-bearer', 'fixture-object', 'fixture-nested', 'fixture-header', 'fixture-cookie']) {
    assert.ok(!display.includes(secret), `display leaked ${secret}`);
  }
  assert.match(display, /REDACTED/);
  assert.equal(input.env.PATH, 'C:\\bin');
  assert.equal(raw.apiKey, 'fixture-object');
  assert.ok(raw.command.includes('fixture-key'));
});

test('UI projections preserve block ids, envelopes and tool-result pairing', () => {
  const raw = { uuid: 'a', parentUuid: 'u', type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'r', name: 'Read', input: { path: 'fixture.txt' } },
    { type: 'text', text: 'preserved' },
  ] } };
  const projected = projectTranscriptEntry(raw);
  assert.equal(projected.uuid, 'a');
  assert.equal(projected.parentUuid, 'u');
  assert.equal(projected.message.content[0].id, 'r');
  assert.equal(projected.message.content[0].input.file_path, 'fixture.txt');
  assert.deepEqual(raw.message.content[0].input, { path: 'fixture.txt' });
  assert.deepEqual(projectToolDisplayEvent({ type: 'message', message: raw }).message, projected);
  const result = { type: 'tool_result', tool_use_id: 'r', content: 'preserved' };
  const row = { message: { content: [result] } };
  assert.deepEqual(projectTranscriptEntry(row), row);
});

test('live and reopened CCB rows are normalized while persisted replay stays verbatim', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-display-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, 'sessions.json');
  const events = [];
  let listener;
  const tool = { type: 'tool_use', id: 'shell-1', name: 'Bash', input: { command: 'echo visible --token fixture-secret', description: '运行命令' } };
  const backend = { id: 'fixture', start() {}, cancel() {}, dispose() {},
    onEvent(fn) { listener = fn; return () => {}; },
    async sendMessage(sessionId) {
      listener({ sessionId, type: 'raw', frame: { type: 'assistant', message: { role: 'assistant', id: 'a', content: [tool] } } });
      return { text: 'done' };
    },
  };
  const kernel = createSessionKernel({ backend, storePath, emit: event => events.push(event) });
  t.after(() => kernel.dispose());
  const { sessionId } = kernel.start({});
  assert.equal((await kernel.sendMessage(sessionId, 'inspect')).ok, true);
  const streamed = events.filter(event => event.type === 'message').map(event => event.message);
  assert.deepEqual(streamed, kernel.getTranscript(sessionId));
  const liveInput = events.find(event => event.type === 'tool_request').input;
  assert.match(liveInput.description, /echo visible --token \[REDACTED\]/);
  assert.ok(!JSON.stringify(streamed).includes('fixture-secret'));
  const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const storedUse = persisted.transcripts[sessionId].flatMap(row => row.message?.content || []).find(block => block.type === 'tool_use');
  assert.deepEqual(storedUse, tool);
  assert.equal(tool.input.description, '运行命令');
  const reopened = createSessionKernel({ backend, storePath, emit() {} });
  t.after(() => reopened.dispose());
  assert.deepEqual(reopened.getTranscript(sessionId), kernel.getTranscript(sessionId));
});
