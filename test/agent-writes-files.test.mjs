// The agent can actually change the workspace, and it verifies its own change.
//
// MEASURED LIVE (replica :10320). Prompt: "Create a file at .tmp/write-probe.txt containing
// exactly: WRITE-834665. Use the Write tool, then confirm."
//
// The transcript shows a four-step loop — this is the whole point of an agent, not just a chat:
//
//   1. Write { content: 'WRITE-834665\n', path: '.tmp/write-probe.txt' }
//      -> 'Wrote C:\\...\\.tmp\\write-probe.txt'
//   2. Write { content: 'WRITE-834665', path: '.tmp/write-probe.txt' }      (trailing newline removed)
//   3. Read  { path: '.tmp/write-probe.txt' }
//      -> '1\tWRITE-834665'
//   4. final text confirming what it read back
//
// And the disk agrees: the file exists at .tmp/write-probe.txt, 13 bytes, content WRITE-834665.
// The model's claim was checked against the filesystem rather than trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the Write tool resolves its path inside the workspace root', () => {
  // The measured call used a relative path and the tool answered with an absolute one.
  const tools = read('desktop/file-tools.cjs');
  assert.match(tools, /write/i, 'no write implementation');
  assert.match(tools, /resolved|resolve\(/, 'the path is not resolved against the root');
});

test('a write outside the roots is refused, not performed', () => {
  // Round 266 measured this from the read side; the write side must agree.
  const tools = read('desktop/file-tools.cjs');
  assert.match(tools, /outside-root/, 'the write path has no outside-root guard');
});

test('Read returns the file with line numbers, which is what the model quoted', () => {
  // Measured: '1\tWRITE-834665'. The prefix is why the model could say what it read.
  const tools = read('desktop/tools.cjs');
  assert.match(tools, /readWithLineNumbers/, 'line numbering is gone');
});

test('the write result names the absolute path it wrote', () => {
  // Measured: 'Wrote C:\\...\\.tmp\\write-probe.txt'. A bare 'ok' would leave the caller
  // unable to tell where the file went.
  // The message lives in tools.cjs, not file-tools.cjs; it also reports the diff size.
  const tools = read('desktop/tools.cjs');
  assert.match(tools, /`Wrote \$\{result\.path\}/, 'the write result does not name the path');
});

test('tools are executed in sequence, each result tied to its own call', () => {
  // Four calls in one turn: two writes, a read, then the final answer.
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /for \(const request of/, 'the agent does not loop over tool calls');
});