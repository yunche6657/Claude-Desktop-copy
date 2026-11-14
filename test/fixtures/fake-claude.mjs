// Synthetic stream-json CLI used to exercise the adapter over a real child process.
// It never contacts a network or a model; it only emulates the documented line protocol.
const chunks = [
  { type: 'system', subtype: 'init', session_id: 'fixture' },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '真实子进程' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '流式片段' } } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '真实子进程流式片段' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
];
process.stdin.resume();
process.stdin.on('data', () => {});
setTimeout(() => {
  for (const chunk of chunks) process.stdout.write(JSON.stringify(chunk) + '\n');
  process.exitCode = 0;
}, 30);
