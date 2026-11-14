import http from 'node:http';
import { startClaude } from './engine.mjs';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 32 * 1024;
const MAX_TEXT = 8000;
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/eipc-client.js', ['eipc-client.js', 'text/javascript; charset=utf-8']],
  ['/icons.js', ['icons.js', 'text/javascript; charset=utf-8']],
  ['/mark-path.js', ['mark-path.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'Expected application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  }
  if (size > MAX_BODY) fail(413, 'Request body too large');
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected JSON object');
  return value;
}
function textField(value, name, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(400, `Invalid ${name}`);
  return value.trim();
}

export function createApp({
  dataDir = path.join(ROOT, 'data'),
  mode = 'demo',
  executable = process.env.CLAUDE_EXECUTABLE,
  engine = startClaude,
  // Agent mode: drives a real tool-use loop against an Anthropic-compatible
  // endpoint. `approve` is supplied by the desktop shell so the consent window
  // gates tool calls; the browser host passes one that always denies.
  agent = null,
} = {}) {
  if (!['demo', 'claude', 'agent'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  if (mode === 'claude' && !executable) throw new Error('claude mode needs an explicit CLAUDE_EXECUTABLE');
  if (mode === 'agent' && !agent) throw new Error('agent mode needs an agent configuration');
  mkdirSync(dataDir, { recursive: true });
  const storage = path.join(dataDir, 'sessions.json');
  let sessions = [];
  if (existsSync(storage)) {
    const saved = JSON.parse(readFileSync(storage, 'utf8'));
    if (!Array.isArray(saved) || saved.some(s => !s || typeof s.id !== 'string' || typeof s.title !== 'string' || typeof s.projectPath !== 'string' || !Array.isArray(s.messages))) {
      throw new Error('Invalid sessions.json: expected a session array');
    }
    sessions = saved;
  }
  const runs = new Map();
  const active = new Map();
  function persist() {
    const temp = `${storage}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(sessions, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temp, storage);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  function emit(run, event) {
    run.events.push(event);
    // An out-of-process sink (the Electron main process) receives the same
    // frames the SSE clients get, so both hosts observe one event stream.
    if (run.sink) { try { run.sink(event); } catch { /* a dead sink must not break SSE */ } }
    const frame = `id: ${run.events.length}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of run.clients) {
      // Disconnect slow readers; retained history permits a clean reconnect.
      if (!client.write(frame)) { client.end(); run.clients.delete(client); }
    }
  }
  function finish(run, status) {
    if (run.done) return;
    clearInterval(run.timer);
    run.done = true;
    if (status === 'cancelled') run.controller?.cancel();
    run.assistant.status = status;
    active.delete(run.sessionId);
    try { persist(); }
    catch { emit(run, { type: 'error', message: 'Failed to persist conversation' }); status = 'error'; }
    emit(run, { type: 'status', status });
    emit(run, { type: 'done' });
    for (const client of run.clients) client.end();
    run.clients.clear();
  }
  // Single entry point for starting a run, shared by the HTTP route and the
  // Electron main process so both hosts drive one implementation.
  function startRun(session, text, sink) {
    if (active.has(session.id)) fail(409, 'This session already has an active run');
    const createdAt = new Date().toISOString();
    const assistant = { id: randomUUID(), role: 'assistant', content: '', text: '', createdAt, status: 'running' };
    session.messages.push({ id: randomUUID(), role: 'user', content: text, text, createdAt }, assistant);
    try { persist(); } catch (error) { session.messages.splice(-2); throw error; }
    const run = { id: randomUUID(), sessionId: session.id, assistant, events: [], clients: new Set(), done: false, sink };
    runs.set(run.id, run);
    active.set(session.id, run.id);
    emit(run, { type: 'status', status: 'running' });

    if (mode === 'agent') {
      // A real tool-use loop. The transcript is converted to API turns once, then
      // the loop appends assistant/tool_result turns as it goes.
      const controller = new AbortController();
      run.controller = { cancel: () => controller.abort() };
      const history = session.messages
        .filter(message => message !== assistant)
        .map(message => ({
          role: message.role === 'user' ? 'user' : 'assistant',
          content: String(message.content ?? message.text ?? ''),
        }))
        // A trailing empty assistant turn would be rejected by the API.
        .filter(message => message.content !== '' || message.role !== 'assistant');

      (async () => {
        try {
          const result = await agent.run({
            messages: history,
            signal: controller.signal,
            onEvent(event) {
              if (run.done) return;
              if (event.type === 'text') {
                assistant.content += event.text;
                assistant.text = assistant.content;
              }
              if (event.type === 'tool_request') {
                assistant.tools = assistant.tools || [];
                assistant.tools.push({ id: event.id, name: event.name, input: event.input, status: 'requested' });
              }
              if (event.type === 'tool_result') {
                const entry = (assistant.tools || []).find(tool => tool.id === event.id);
                if (entry) { entry.status = event.isError ? 'failed' : 'done'; entry.preview = event.preview; }
              }
              if (event.type === 'tool_denied') {
                const entry = (assistant.tools || []).find(tool => tool.name === event.name && tool.status === 'requested');
                if (entry) entry.status = 'denied';
              }
              emit(run, event);
            },
          });
          if (!assistant.content && result?.text) {
            assistant.content = result.text;
            assistant.text = result.text;
          }
          finish(run, 'completed');
        } catch (error) {
          if (run.done) return;
          if (error?.code === 'aborted') return finish(run, 'cancelled');
          assistant.error = error.message;
          emit(run, { type: 'error', message: error.message });
          finish(run, 'error');
        }
      })();
      return run;
    }

    if (mode === 'claude') {
      const prompt = session.messages.filter(m => m !== assistant).map(m => `${m.role}: ${m.content}`).join('\n\n');
      run.controller = engine({ executable, prompt,
        onEvent(event) { if (run.done) return; if (event.type === 'text') { assistant.content += event.text; assistant.text = assistant.content; } if (event.type === 'error') assistant.error = event.message; emit(run, event); },
        onFinish(status) { finish(run, status); }
      });
      return run;
    }
    const chunks = ['【Demo 演示模式】\n', '这是一段本地模拟回复，', '未调用真实 Claude CLI，', '未执行任何 shell 命令。\n\n', '你发送的内容是：\n', ...text.match(/[^]{1,160}/g), '\n\n此结果仅用于演示会话、流式输出与取消操作。'];
    let index = 0;
    run.timer = setInterval(() => {
      const chunk = chunks[index++];
      assistant.content += chunk;
      assistant.text = assistant.content;
      emit(run, { type: 'text', text: chunk });
      if (index === chunks.length) finish(run, 'completed');
    }, 35);
    return run;
  }

  // Programmatic session facade. The Electron main process binds this onto the
  // EIPC bus; the HTTP routes below use the same functions.
  const sessionsApi = {
    list: () => sessions.map(s => ({ ...s, messages: s.messages.map(m => ({ ...m })) })),
    create(input = {}) {
      const title = textField(input.title, 'title', 200, '新会话');
      const projectPath = input.projectPath === '' ? '' : textField(input.projectPath, 'projectPath', 4096, '');
      const session = { id: randomUUID(), title, projectPath, messages: [], createdAt: new Date().toISOString() };
      sessions.push(session);
      try { persist(); } catch (error) { sessions.pop(); throw error; }
      return { ...session };
    },
    get(id) {
      const session = sessions.find(s => s.id === id);
      if (!session) fail(404, 'Session not found');
      return { ...session, messages: session.messages.map(m => ({ ...m })) };
    },
    remove(id) {
      const at = sessions.findIndex(s => s.id === id);
      if (at < 0) fail(404, 'Session not found');
      const activeRun = active.get(id);
      if (activeRun) finish(runs.get(activeRun), 'cancelled');
      const [removed] = sessions.splice(at, 1);
      try { persist(); } catch (error) { sessions.splice(at, 0, removed); throw error; }
      return { ok: true, id };
    },
    send(id, text, sink) {
      const session = sessions.find(s => s.id === id);
      if (!session) fail(404, 'Session not found');
      const run = startRun(session, textField(text, 'text', MAX_TEXT), sink);
      return { runId: run.id };
    },
    cancel(id) {
      const runId = active.get(id);
      if (!runId) return { ok: true, status: 'idle' };
      const run = runs.get(runId);
      finish(run, 'cancelled');
      return { ok: true, runId, status: run.assistant.status };
    },
  };

  function guard(req) {
    const host = req.headers.host;
    const port = server.address()?.port;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) fail(403, 'Invalid Host');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) fail(403, 'Invalid Origin');
    if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site request blocked');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      guard(req);
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = url.pathname;
      if (req.method === 'GET' && route === '/api/config') return json(res, 200, {
        mode,
        // Demo answers locally; claude is a bare single-shot CLI call; agent runs
        // a real tool-use loop and can therefore change files and run commands.
        tools: mode === 'agent' ? 'enabled' : 'disabled',
        authentication: mode === 'demo' ? 'none' : 'explicit-environment',
        model: agent?.model || null,
        // The account row shows who the session belongs to. It is read from the
        // environment rather than hardcoded, so the label reflects the account
        // that actually ran the process.
        account: {
          name: process.env.USERNAME || process.env.USER || 'local',
          kind: mode === 'agent' ? 'Agent' : mode === 'claude' ? 'CLI' : 'Demo',
        },
      });
      // Local execution needs the desktop consent window. A plain browser has no
      // such surface, so the capability is reported as unavailable rather than
      // silently running commands without an approval step.
      if (route === '/api/exec' && req.method === 'POST') return json(res, 501, { error: '本地执行仅在桌面宿主中可用（需要确认窗口）。' });
      if (route === '/api/sessions' && req.method === 'GET') return json(res, 200, { sessions });
      if (route === '/api/sessions' && req.method === 'POST') {
        const input = await body(req);
        const title = textField(input.title, 'title', 200, '新会话');
        const projectPath = input.projectPath === '' ? '' : textField(input.projectPath, 'projectPath', 4096, '');
        const session = { id: randomUUID(), title, projectPath, messages: [], createdAt: new Date().toISOString() };
        sessions.push(session);
        try { persist(); } catch (error) { sessions.pop(); throw error; }
        return json(res, 201, session);
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)(\/messages)?$/.exec(route);
      if (sessionMatch) {
        const session = sessions.find(s => s.id === sessionMatch[1]);
        if (!session) fail(404, 'Session not found');
        if (!sessionMatch[2] && req.method === 'GET') return json(res, 200, session);
        if (sessionMatch[2] && req.method === 'POST') {
          const input = await body(req);
          const text = textField(input.text, 'text', MAX_TEXT);
          const run = startRun(session, text);
          return json(res, 202, { runId: run.id });
        }
        fail(405, 'Method not allowed');
      }
      const runMatch = /^\/api\/runs\/([^/]+)\/(events|cancel)$/.exec(route);
      if (runMatch) {
        const run = runs.get(runMatch[1]);
        if (!run) fail(404, 'Run not found');
        if (runMatch[2] === 'cancel' && req.method === 'POST') {
          finish(run, 'cancelled');
          return json(res, 200, { runId: run.id, status: run.assistant.status });
        }
        if (runMatch[2] === 'events' && req.method === 'GET') {
          const rawCursor = req.headers['last-event-id'];
          const cursor = rawCursor === undefined ? 0 : Number(rawCursor);
          if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > run.events.length) fail(400, 'Invalid Last-Event-ID');
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.flushHeaders();
          for (let i = cursor; i < run.events.length; i++) res.write(`id: ${i + 1}\ndata: ${JSON.stringify(run.events[i])}\n\n`);
          if (run.done) return res.end();
          run.clients.add(res);
          res.on('close', () => run.clients.delete(res));
          return;
        }
        fail(405, 'Method not allowed');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC.has(route)) {
        const [file, type] = STATIC.get(route);
        let bytes;
        try { bytes = readFileSync(path.join(ROOT, 'renderer', file)); }
        catch (error) { if (error.code === 'ENOENT') fail(404, 'Renderer file not found'); throw error; }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      if (route === '/api/sessions' || route === '/api/config' || STATIC.has(route)) fail(405, 'Method not allowed');
      fail(404, 'Not found');
    } catch (error) {
      if (res.headersSent) return res.end();
      json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const originalClose = server.close.bind(server);
  server.close = (...args) => {
    for (const run of runs.values()) if (!run.done) finish(run, 'cancelled');
    return originalClose(...args);
  };
  // Exposed so the Electron main process can bind the same store onto its EIPC
  // bus without a second persistence implementation.
  server.sessions = sessionsApi;
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT || 19420);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createApp({ dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'), mode: process.env.MODE || 'demo' });
  server.listen(port, '127.0.0.1', () => console.log(`Demo server: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
