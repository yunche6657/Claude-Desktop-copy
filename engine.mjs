import {spawn} from 'node:child_process';

// Observed in the real 2.1.299 CLI: the authentication failure arrives as an
// assistant message with error:"authentication_failed" plus a result with
// is_error:true and exit code 1. Those are reported as actionable errors rather
// than as assistant prose, so the UI never presents them as model output.
const AUTH_HINT = 'Claude CLI 未登录：请先在终端运行 claude 并执行 /login，或为本服务设置显式 API 凭据。';

export function parseClaudeEvent(event, state, emit) {
  if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
    state.partial = true;
    emit({type: 'text', text: event.event.delta.text});
  }
  if (event.type === 'assistant') {
    if (event.error === 'authentication_failed') { state.auth = true; throw new Error(AUTH_HINT); }
    if (event.is_api_error_message) { state.apiError = true; throw new Error('Claude API 返回错误，请检查登录状态或凭据。'); }
    if (!state.partial) for (const block of event.message?.content || []) if (block.type === 'text') emit({type: 'text', text: block.text});
  }
  if (event.type === 'result') {
    state.result = true;
    if (event.is_error) throw new Error(state.auth ? AUTH_HINT : 'Claude 报告本轮执行失败。');
  }
}

export function startClaude({executable, prompt, onEvent, onFinish, timeoutMs = 120000, spawnImpl = spawn}) {
  let child, ended = false, buffer = '', state = {}, timer;
  const finish = (status, message) => { if (ended) return; ended = true; clearTimeout(timer); if (message) onEvent({type: 'error', message}); onFinish(status); };
  const stop = (status, message) => { child?.kill(); finish(status, message); };
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--bare', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--permission-prompts', 'none', '--setting-sources', ''];
  // A .js entrypoint runs on this Node runtime; any other path is executed directly.
  const nodeScript = /\.(?:c|m)?js$/i.test(executable);
  try {
    child = spawnImpl(nodeScript ? process.execPath : executable, nodeScript ? [executable, ...args] : args, {shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    timer = setTimeout(() => stop('error', 'Claude response timed out'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (ended) return;
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return stop('error', 'Claude output exceeded buffer limit');
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { return stop('error', 'Claude 返回了无法解析的数据流。'); }
        try { parseClaudeEvent(event, state, onEvent); } catch (error) { return stop('error', error.message); }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish('error', 'Claude 可执行文件无法启动。'));
    child.on('close', code => finish(code === 0 && state.result ? 'completed' : 'error', code === 0 && state.result ? undefined : (state.auth ? AUTH_HINT : 'Claude 未返回成功结果。')));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  } catch { finish('error', 'Claude 可执行文件无法启动。'); }
  return {cancel: () => stop('cancelled')};
}
