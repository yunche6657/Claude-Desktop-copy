import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRequestUsageTracker } = require('../desktop/context-usage.cjs');
const core = process.env.CCD_CCB_CORE || 'D:\\CodexArtifacts\\claude-code-desktop\\R378-NOTIFICATION-RELAY-HISTORY-ASAR\\resources\\agent-core';
const bun = path.join(core, 'bun/bun.exe');
const cli = path.join(core, 'claude-code/dist/cli-bun.js');

test('real CCB emits complete per-request usage from synthetic API', { skip: process.env.CCD_REAL_USAGE_PROOF !== '1' || !fs.existsSync(bun) || !fs.existsSync(cli), timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-usage-'));
  for (const dir of ['work', 'home', 'appdata', 'localappdata']) fs.mkdirSync(path.join(root, dir));
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: 'msg_usage_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 17, cache_read_input_tokens: 23, cache_creation_input_tokens: 11, output_tokens: 0 } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture' } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
    send('message_stop', {}); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), TEMP: process.env.TEMP, TMP: process.env.TMP, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'synthetic-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  const child = spawn(bun, [cli, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--model', 'claude-sonnet-4-5'], { cwd: path.join(root, 'work'), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const completed = []; const tracker = createRequestUsageTracker(value => completed.push(value));
  let buffer = '', stderr = '';
  child.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { tracker.observe(JSON.parse(line)); } catch {} } });
  child.stderr.on('data', chunk => stderr += chunk);
  try {
    child.stdin.end(JSON.stringify({ type: 'user', session_id: 'fixture', parent_tool_use_id: null, message: { role: 'user', content: 'fixture' } }) + '\n');
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, stderr.slice(-1000));
    assert.deepEqual(completed.map(x => x.usage), [{ input_tokens: 17, output_tokens: 7, cache_read_input_tokens: 23, cache_creation_input_tokens: 11 }]);
  } finally { if (child.exitCode === null) child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
