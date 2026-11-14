// Minimal MCP (Model Context Protocol) client.
//
// Implements the JSON-RPC 2.0 over newline-delimited stdio transport that the
// shipped app uses for `type: "stdio"` servers (observed in
// index.chunk-Bn6onBlX.js: a server entry is stdio when `type` is absent or
// "stdio", and a stdio entry requires a string `command`).
//
// Scope is deliberately the part that can be verified locally: spawn, framed
// request/response, notifications, initialization, tools and resources. HTTP
// supports request/response sessions; legacy SSE uses a persistent event stream.
//
// Framing note: MCP over stdio is one JSON object per line. A server that emits
// pretty-printed JSON would break that, so responses are accumulated and only
// parsed when a complete line arrives; an unparseable line is reported as a
// protocol error instead of being silently dropped.
'use strict';

const { spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_RESOURCE_PAGES = 64;

class McpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Native MCP Client.listResources collects all pages when no cursor is given.
async function listAllResources(connection) {
  if (!connection.serverCapabilities?.resources) return [];
  const resources = [];
  const seen = new Set();
  let cursor;
  let pages = 0;
  do {
    if (cursor !== undefined) {
      if (seen.has(cursor)) break;
      if (pages >= MAX_RESOURCE_PAGES) {
        throw new McpError('pagination-exceeded', `resources/list: exceeded listMaxPages (${MAX_RESOURCE_PAGES}); server pagination did not terminate`);
      }
      seen.add(cursor);
    }
    const result = await connection.request('resources/list', cursor === undefined ? {} : { cursor });
    if (!Array.isArray(result?.resources)) throw new McpError('protocol-error', 'resources/list did not return resources');
    resources.push(...result.resources);
    pages++;
    cursor = result.nextCursor;
    if (cursor !== undefined && typeof cursor !== 'string') throw new McpError('protocol-error', 'invalid resources cursor');
  } while (cursor !== undefined);
  return resources;
}

async function readResource(connection, uri) {
  const result = await connection.request('resources/read', { uri });
  if (!Array.isArray(result?.contents)) throw new McpError('protocol-error', 'resources/read did not return contents');
  return result.contents;
}

/** Validates one server entry from a config file. */
function normaliseServer(name, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new McpError('invalid-server', `server "${name}" is not an object`);
  }
  const type = entry.type === undefined ? 'stdio' : entry.type;
  if (!['stdio', 'sdk', 'http', 'sse'].includes(type)) {
    throw new McpError('invalid-transport', `server "${name}" has unknown type "${String(entry.type)}"`);
  }
  if (type === 'stdio') {
    if (typeof entry.command !== 'string' || !entry.command.trim()) {
      throw new McpError('invalid-server', `stdio server "${name}" requires a command string`);
    }
    const args = entry.args === undefined ? [] : entry.args;
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
      throw new McpError('invalid-server', `server "${name}" args must be a string array`);
    }
    if (entry.env !== undefined && (typeof entry.env !== 'object' || entry.env === null || Array.isArray(entry.env))) {
      throw new McpError('invalid-server', `server "${name}" env must be an object`);
    }
    return { name, type, command: entry.command, args: [...args], env: { ...(entry.env || {}) }, cwd: entry.cwd };
  }
  // `sdk` is a different client mode, not an HTTP variant: it has no url and no
  // command, so it is accepted as a known-but-unimplemented type.
  if (type === 'sdk') {
    return { name, type };
  }
  // http and sse both need a URL; extra headers let a server require an auth token.
  if (typeof entry.url !== 'string' || !entry.url.trim()) {
    throw new McpError('invalid-server', `${type} server "${name}" requires a url string`);
  }
  let headers;
  if (entry.headers !== undefined) {
    if (typeof entry.headers !== 'object' || entry.headers === null || Array.isArray(entry.headers)) {
      throw new McpError('invalid-server', `server "${name}" headers must be an object`);
    }
    headers = { ...entry.headers };
  }
  return { name, type, url: entry.url.trim(), headers };
}

/** One live stdio connection. */
class StdioConnection {
  constructor(server, { timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn } = {}) {
    this.server = server;
    this.timeoutMs = timeoutMs;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.stderr = '';
  }

  start() {
    if (this.child) return;
    const { command, args, env, cwd } = this.server;
    this.child = this.spawnImpl(command, args, {
      cwd: cwd || undefined,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.#onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      // Kept for diagnostics; never parsed as protocol data.
      if (this.stderr.length < 64 * 1024) this.stderr += chunk;
    });
    this.child.on('error', error => this.#failAll(new McpError('spawn-failed', `${this.server.name}: ${error.message}`)));
    this.child.on('close', code => {
      this.closed = true;
      this.#failAll(new McpError('disconnected', `${this.server.name} exited with code ${code}`));
      this.onClose?.();
    });
    this.child.stdin.on('error', () => { /* handled via close */ });
  }

  #onData(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.#failAll(new McpError('frame-too-large', `${this.server.name} exceeded the frame limit`));
      this.stop();
      return;
    }
    let at;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        this.#failAll(new McpError('protocol-error', `${this.server.name} sent a non-JSON line`));
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message) {
    if (message && typeof message.id === 'number' && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new McpError('rpc-error', message.error.message || 'server returned an error'));
      else resolve(message.result);
      return;
    }
    // A request from the server is not part of what this client supports; the
    // protocol allows ignoring notifications, so unknown ids are dropped.
  }

  #failAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  request(method, params) {
    if (this.closed || !this.child) {
      return Promise.reject(new McpError('disconnected', `${this.server.name} is not connected`));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError('timeout', `${this.server.name} did not answer ${method} within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(payload); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError('write-failed', error.message));
      }
    });
  }

  async initialise() {
    this.start();
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'code-desktop-reconstruction', version: '0.1.0' },
    });
    this.serverCapabilities = result?.capabilities;
    // The spec requires the client to acknowledge completion with a notification.
    this.notify('notifications/initialized');
    return result;
  }

  notify(method, params) {
    if (this.closed || !this.child) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n';
    try { this.child.stdin.write(payload); } catch { /* a dying child is caught by close */ }
  }

  async listTools() {
    const result = await this.request('tools/list');
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  listResources() { return listAllResources(this); }

  readResource(uri) { return readResource(this, uri); }

  async callTool(name, args) {
    return await this.request('tools/call', { name, arguments: args || {} });
  }

  stop() {
    if (this.child && !this.closed) {
      try { this.child.kill(); } catch { /* ignore */ }
    }
    this.closed = true;
    this.#failAll(new McpError('stopped', `${this.server.name} was stopped`));
  }
}

/** One live Streamable-HTTP connection.
 *
 * The protocol shape, per the MCP Streamable HTTP transport:
 *   - every message is a POST of one JSON-RPC object to a single endpoint;
 *   - the response to `initialize` may carry an `Mcp-Session-Id` header, which
 *     must be repeated on every later request;
 *   - a response body is either a single `application/json` message or a
 *     `text/event-stream` carrying one or more messages;
 *   - a session is closed with DELETE.
 *
 * Only the client half is implemented, and only the parts this app needs:
 * request/response and notifications. Server-initiated requests (sampling,
 * elicitation) are declined rather than ignored silently.
 */
class HttpConnection {
  constructor(server, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    this.server = server;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
    this.deletedSessionId = null;
    this.nextId = 1;
    this.closed = false;
    this.pendingRequests = new Set();
  }

  get endpoint() {
    return this.server.url;
  }

  #headers(extra = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extra,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.server.headers) Object.assign(headers, this.server.headers);
    return headers;
  }

  /** Extracts JSON-RPC messages from either a JSON body or an SSE body. */
  static parseBody(contentType, text) {
    if (!text || !text.trim()) return [];
    if (contentType.includes('text/event-stream')) {
      const messages = [];
      // SSE frames are separated by a blank line; only `data:` lines carry the
      // payload. A malformed frame is reported, not skipped.
      for (const frame of text.split(/\r?\n\r?\n/)) {
        const data = frame
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try { messages.push(JSON.parse(data)); }
        catch { throw new McpError('protocol-error', 'an SSE frame was not valid JSON'); }
      }
      return messages;
    }
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new McpError('protocol-error', 'the response body was not valid JSON');
    }
  }

  async #post(payload, { expectResponse = true } = {}) {
    if (this.closed) throw new McpError('disconnected', `${this.server.name} is not connected`);
    const controller = new AbortController();
    this.pendingRequests.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const assigned = response.headers?.get?.('mcp-session-id');
      if (assigned && !this.sessionId) this.sessionId = assigned;
      // The body can remain open after the response headers arrive. Keep the
      // deadline and stop signal in force until it has actually been consumed.
      const text = await response.text();
      if (this.closed) throw new McpError('disconnected', `${this.server.name} is not connected`);
      if (controller.signal.aborted) throw new McpError('timeout', `${this.server.name} did not answer within ${this.timeoutMs}ms`);
      if (!response.ok) {
        throw new McpError('http-error', `${this.server.name} responded ${response.status}: ${text.slice(0, 200)}`);
      }
      if (!expectResponse) return [];
      const contentType = response.headers?.get?.('content-type') || 'application/json';
      return HttpConnection.parseBody(contentType, text);
    } catch (error) {
      if (this.closed) throw new McpError('disconnected', `${this.server.name} is not connected`);
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new McpError('timeout', `${this.server.name} did not answer within ${this.timeoutMs}ms`);
      }
      if (error instanceof McpError) throw error;
      throw new McpError('network', `${this.server.name}: ${error.message}`);
    } finally {
      clearTimeout(timer);
      this.pendingRequests.delete(controller);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return this.#post(message).then(messages => {
      const answer = messages.find(m => m && m.id === id);
      if (!answer) {
        throw new McpError('protocol-error', `${this.server.name} did not answer ${method}`);
      }
      if (answer.error) throw new McpError('rpc-error', answer.error.message || 'server returned an error');
      return answer.result;
    });
  }

  async notify(method, params) {
    const message = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
    // A notification has no id and therefore no response body to read.
    await this.#post(message, { expectResponse: false });
  }

  async initialise() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'code-desktop-reconstruction', version: '0.1.0' },
    });
    this.serverCapabilities = result?.capabilities;
    await this.notify('notifications/initialized');
    return result;
  }

  async listTools() {
    const result = await this.request('tools/list');
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  listResources() { return listAllResources(this); }

  readResource(uri) { return readResource(this, uri); }

  async callTool(name, args) {
    return await this.request('tools/call', { name, arguments: args || {} });
  }

  stop() {
    this.closed = true;
    for (const controller of this.pendingRequests) controller.abort();
    // Terminate the session if the server issued one. The promise resolves once
    // the DELETE has been attempted, so a caller awaiting stop() knows the server
    // has been told; a failing DELETE is still not an error.
    if (!this.sessionId || this.deletedSessionId === this.sessionId) return Promise.resolve();
    this.deletedSessionId = this.sessionId;
    return Promise.resolve(
      this.fetchImpl(this.endpoint, { method: 'DELETE', headers: this.#headers() }),
    ).then(() => undefined, () => undefined);
  }
}

/** Legacy MCP SSE transport: one GET event stream and POST messages. */
class SseConnection {
  constructor(server, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    this.server = server;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.controllers = new Set();
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.rejectEndpoint?.(error);
    this.onClose?.();
  }

  async #start() {
    const controller = new AbortController();
    this.controllers.add(controller);
    const endpoint = new Promise((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });
    const timer = setTimeout(() => this.#close(new McpError('timeout', `${this.server.name} did not announce an endpoint`)), this.timeoutMs);
    this.#readStream(controller).catch(error => this.#close(error instanceof McpError ? error : new McpError('network', `${this.server.name}: ${error.message}`)));
    try { return await endpoint; }
    finally { clearTimeout(timer); }
  }

  async #readStream(controller) {
    const response = await this.fetchImpl(this.server.url, {
      method: 'GET', headers: { ...this.server.headers, accept: 'text/event-stream' },
      signal: controller.signal, redirect: 'error',
    });
    if (!response.ok) throw new McpError('http-error', `${this.server.name} responded ${response.status}`);
    if (!(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream') || !response.body) {
      throw new McpError('protocol-error', `${this.server.name} did not provide an event stream`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', event = '', data = [];
    const dispatch = () => {
      if (!data.length) { event = ''; return; }
      const value = data.join('\n');
      if (event === 'endpoint') {
        let url;
        try { url = new URL(value, this.server.url); }
        catch { throw new McpError('protocol-error', 'invalid SSE endpoint'); }
        const base = new URL(this.server.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password || url.hash) {
          throw new McpError('protocol-error', 'SSE endpoint must be same-origin');
        }
        if (this.endpoint && this.endpoint !== url.href) throw new McpError('protocol-error', 'SSE endpoint changed');
        this.endpoint = url.href;
        this.resolveEndpoint?.(this.endpoint);
        this.resolveEndpoint = this.rejectEndpoint = null;
      } else if (event === 'message' || event === '') {
        let message;
        try { message = JSON.parse(value); } catch { throw new McpError('protocol-error', 'invalid SSE JSON message'); }
        const pending = this.pending.get(message?.id);
        if (pending && !pending.message) {
          pending.message = message;
          if (pending.postDone) this.#complete(message.id, pending);
        }
      }
      event = ''; data = [];
    };
    const line = text => {
      if (!text) return dispatch();
      if (text.startsWith(':')) return;
      const i = text.indexOf(':');
      const field = i < 0 ? text : text.slice(0, i);
      let value = i < 0 ? '' : text.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
    };
    try {
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES || Buffer.byteLength(data.join('\n')) > MAX_FRAME_BYTES) throw new McpError('frame-too-large', 'SSE frame exceeded the limit');
        // Preserve a trailing CR until the next chunk, in case it begins CRLF.
        let match;
        while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
          line(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
      }
      if (!this.closed) throw new McpError('disconnected', `${this.server.name} event stream ended`);
    } finally { this.controllers.delete(controller); reader.releaseLock(); }
  }

  #complete(id, pending) {
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.message.error) pending.reject(new McpError('rpc-error', pending.message.error.message || 'server returned an error'));
    else pending.resolve(pending.message.result);
  }

  async #post(message, externalSignal) {
    if (this.closed || !this.endpoint) throw new McpError('disconnected', `${this.server.name} is not connected`);
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST', headers: { ...this.server.headers, 'content-type': 'application/json' },
        body: JSON.stringify(message), signal: controller.signal, redirect: 'error',
      });
      await response.text();
      if (!response.ok) throw new McpError('http-error', `${this.server.name} responded ${response.status}`);
      if (this.closed) throw new McpError('disconnected', `${this.server.name} is not connected`);
    } catch (error) {
      if (this.closed) throw new McpError('disconnected', `${this.server.name} is not connected`);
      if (controller.signal.aborted) throw new McpError('timeout', `${this.server.name} POST timed out`);
      if (error instanceof McpError) throw error;
      throw new McpError('network', `${this.server.name}: ${error.message}`);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }

  request(method, params) {
    if (this.closed || !this.endpoint) return Promise.reject(new McpError('disconnected', `${this.server.name} is not connected`));
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        controller.abort();
        reject(new McpError('timeout', `${this.server.name} did not answer ${method}`));
      }, this.timeoutMs);
      const pending = { resolve, reject, timer, postDone: false, message: null };
      this.pending.set(id, pending);
      this.#post(message, controller.signal).then(() => {
        if (this.pending.get(id) !== pending) return;
        pending.postDone = true;
        if (pending.message) this.#complete(id, pending);
      }, error => {
        if (this.pending.get(id) === pending) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  notify(method, params) { return this.#post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); }
  async initialise() {
    await this.#start();
    const result = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'code-desktop-reconstruction', version: '0.1.0' } });
    this.serverCapabilities = result?.capabilities;
    await this.notify('notifications/initialized');
    return result;
  }
  async listTools() { const result = await this.request('tools/list'); return Array.isArray(result?.tools) ? result.tools : []; }
  listResources() { return listAllResources(this); }
  readResource(uri) { return readResource(this, uri); }
  callTool(name, args) { return this.request('tools/call', { name, arguments: args || {} }); }
  stop() { this.#close(new McpError('stopped', `${this.server.name} was stopped`)); }
}

/** Holds every configured server and its connection state. */
class McpHost {
  constructor({ spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    // Injected so the HTTP transport can be exercised without network in tests.
    this.fetchImpl = fetchImpl;
    this.servers = new Map();
    this.pendingTeardowns = new Set();
  }

  /** Reconciles a complete `{ mcpServers: {...} }` snapshot synchronously. */
  load(config) {
    const entries = config && typeof config === 'object' && !Array.isArray(config) ? config.mcpServers : undefined;
    if (entries !== undefined && (typeof entries !== 'object' || entries === null || Array.isArray(entries))) {
      throw new McpError('invalid-config', 'mcpServers must be an object');
    }
    const accepted = [];
    const rejected = [];
    const next = new Map();
    for (const [name, raw] of Object.entries(entries || {})) {
      try {
        const server = normaliseServer(name, raw);
        // SDK entries are not handled by this host.
        if (server.type !== 'stdio' && server.type !== 'http' && server.type !== 'sse') {
          const error = `transport "${server.type}" is not implemented`;
          next.set(name, {
            server,
            connection: null,
            status: 'unsupported',
            tools: [],
            error,
          });
          rejected.push({ name, error });
          continue;
        }
        next.set(name, {
          server,
          connection: null,
          status: 'disconnected',
          tools: [],
          error: null,
        });
        accepted.push(name);
      } catch (error) {
        next.set(name, {
          server: { name, type: raw?.type ?? 'stdio' },
          connection: null,
          status: 'invalid',
          tools: [],
          error: error.message,
        });
        rejected.push({ name, error: error.message });
      }
    }
    const previous = this.servers;
    for (const [name, candidate] of next) {
      const old = previous.get(name);
      if (old && old.status !== 'invalid' && candidate.status !== 'invalid' && isDeepStrictEqual(old.server, candidate.server)) {
        next.set(name, old);
      }
    }
    // Swap first so a late completion or close cannot mutate a replacement.
    this.servers = next;
    for (const [name, old] of previous) {
      if (next.get(name) !== old) this.retire(old);
    }
    return { accepted, rejected };
  }

  retire(state) {
    let stopping;
    try { stopping = state.connection?.stop?.(); }
    catch (error) { stopping = Promise.reject(error); }
    const stopPromise = Promise.resolve(stopping);
    // The connect task includes any second stop needed for a late HTTP session.
    const teardown = Promise.allSettled([stopPromise, state.connectPromise]);
    this.pendingTeardowns.add(teardown);
    teardown.then(() => this.pendingTeardowns.delete(teardown));
    return stopPromise;
  }

  list() {
    return [...this.servers.entries()].map(([name, state]) => ({
      name,
      type: state.server.type,
      status: state.status,
      toolCount: state.tools.length,
      error: state.error,
    }));
  }

  async connect(name) {
    const state = this.servers.get(name);
    if (!state) throw new McpError('not-found', `no server named "${name}"`);
    if (state.server.type !== 'stdio' && state.server.type !== 'http' && state.server.type !== 'sse') {
      throw new McpError('unsupported-transport', `transport "${state.server.type}" is not implemented`);
    }
    if (state.status === 'connected') return this.list().find(entry => entry.name === name);
    if (state.connectPromise) return state.connectPromise;

    const connection = state.server.type === 'http'
      ? new HttpConnection(state.server, { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
      : state.server.type === 'sse'
      ? new SseConnection(state.server, { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
      : new StdioConnection(state.server, { timeoutMs: this.timeoutMs, spawnImpl: this.spawnImpl });
    // A late close from an earlier process must not invalidate its replacement.
    connection.onClose = () => {
      if (this.servers.get(name) !== state || state.connection !== connection || state.status !== 'connected') return;
      state.connection = null;
      state.tools = [];
      state.status = 'disconnected';
    };
    state.connection = connection;
    state.status = 'connecting';
    const current = () => this.servers.get(name) === state && state.connection === connection && !connection.closed;
    const requireCurrent = () => {
      if (!current()) throw new McpError('disconnected', `${name} disconnected during connection`);
    };
    const task = (async () => {
      try {
        const info = await connection.initialise();
        requireCurrent();
        const tools = await connection.listTools();
        requireCurrent();
        state.tools = tools;
        state.status = 'connected';
        state.error = null;
        state.serverInfo = info?.serverInfo ?? null;
        return this.list().find(entry => entry.name === name);
      } catch (error) {
        if (this.servers.get(name) === state && state.connection === connection) {
          state.status = 'failed';
          state.error = error.message;
          state.connection = null;
        }
        await connection.stop();
        throw error;
      }
    })();
    state.connectPromise = task;
    try { return await task; }
    finally { if (state.connectPromise === task) state.connectPromise = null; }
  }

  async callTool(name, toolName, args) {
    const state = this.servers.get(name);
    if (!state) throw new McpError('not-found', `no server named "${name}"`);
    if (state.status !== 'connected' || !state.connection) {
      throw new McpError('not-connected', `server "${name}" is ${state.status}`);
    }
    return await state.connection.callTool(toolName, args);
  }

  async disconnect(name) {
    const state = this.servers.get(name);
    if (!state) throw new McpError('not-found', `no server named "${name}"`);
    // Invalidate first: delayed initialization must not restore this connection.
    const retired = { connection: state.connection, connectPromise: state.connectPromise };
    state.connection = null;
    state.connectPromise = null;
    state.tools = [];
    state.status = state.server.type === 'stdio' || state.server.type === 'http' || state.server.type === 'sse'
      ? 'disconnected'
      : 'unsupported';
    // An HTTP connection ends its session with DELETE.
    await this.retire(retired);
    return { name, status: state.status };
  }

  async restart(name) {
    await this.disconnect(name);
    return await this.connect(name);
  }

  /** Tears down every connection. Returns a promise that resolves once each has
   *  had its teardown attempt (stdio kills synchronously, http sends DELETE). */
  async stopAll() {
    const states = [...this.servers.values()];
    this.servers.clear();
    for (const state of states) this.retire(state);
    await Promise.all([...this.pendingTeardowns]);
  }
}

module.exports = {
  McpError,
  McpHost,
  StdioConnection,
  HttpConnection,
  SseConnection,
  normaliseServer,
  PROTOCOL_VERSION,
  DEFAULT_TIMEOUT_MS,
};

