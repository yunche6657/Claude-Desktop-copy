'use strict';

// Local dev-server supervision. Browser views, tabs and screenshot capture are a
// separate host: a reachable URL is not evidence that such a view exists.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

function readConfigurations(cwd) {
  try {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return [];
    const root = fs.realpathSync(cwd);
    const file = fs.realpathSync(path.join(root, '.claude', 'launch.json'));
    if (!inside(root, file) || fs.statSync(file).size > 1024 * 1024) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed?.configurations;
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => row && typeof row === 'object').map(row => ({
      name: typeof row.name === 'string' && row.name ? row.name : 'dev server',
      runtimeExecutable: typeof row.runtimeExecutable === 'string' ? row.runtimeExecutable : '',
      runtimeArgs: Array.isArray(row.runtimeArgs) ? row.runtimeArgs.filter(arg => typeof arg === 'string') : [],
      ...(Number.isInteger(row.port) && row.port >= 0 && row.port <= 65535 ? { port: row.port } : {}),
    }));
  } catch { return []; }
}

function buildLaunchCommand(executable, args, env, platform = process.platform) {
  if (typeof executable !== 'string' || !executable || [executable, ...args].some(value => /[\0\r\n]/.test(value)))
    throw new Error('Invalid executable or argument in launch configuration');
  if (platform !== 'win32') return { executable, args, windowsVerbatimArguments: false };
  let resolved = executable;
  if (!path.win32.isAbsolute(executable) && !/[\\/]/.test(executable)) {
    const dirs = String(env.PATH || env.Path || '').split(';');
    const extensions = path.win32.extname(executable) ? [''] : ['', '.exe', '.com', '.cmd', '.bat'];
    for (const directory of dirs) {
      const candidate = extensions.map(extension => path.win32.join(directory, executable + extension)).find(file => {
        try { return fs.statSync(file).isFile(); } catch { return false; }
      });
      if (candidate) { resolved = candidate; break; }
    }
  }
  if (!/\.(cmd|bat)$/i.test(resolved)) return { executable: resolved, args, windowsVerbatimArguments: false };
  // Batch launchers need cmd.exe. Restrict batch arguments to literal tokens;
  // commands needing shell operators must use an executable script instead.
  if ([resolved, ...args].some(value => /["%!&|<>^]/.test(value)))
    throw new Error('Batch launch arguments contain unsupported shell characters');
  const command = '"' + [resolved, ...args].map(value => `"${value}"`).join(' ') + '"';
  return { executable: env.ComSpec || env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', command], windowsVerbatimArguments: true };
}

function portOpen(port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = result => { if (done) return; done = true; socket.destroy(); resolve(result); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function probeHttp(url, timeoutMs) {
  return new Promise(resolve => {
    const request = http.get(url, { agent: false }, response => {
      const usable = response.statusCode >= 200 && response.statusCode < 500;
      response.destroy();
      resolve(usable);
    });
    request.once('error', () => resolve(false));
    request.setTimeout(timeoutMs, () => { request.destroy(); resolve(false); });
  });
}

function createPreviewLaunch({ isTrusted = () => false, emit = () => {}, baseEnv = process.env,
  startTimeoutMs = 15000, probeTimeoutMs = 500, pollIntervalMs = 100,
  stopTimeoutMs = 3000, maxLogLines = 1000, maxLogBytes = 256 * 1024 } = {}) {
  for (const value of [startTimeoutMs, probeTimeoutMs, pollIntervalMs, stopTimeoutMs, maxLogLines, maxLogBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid launch supervision limit');
  }
  const servers = new Map();
  const launches = new Map();
  let disposed = false;
  let disposal;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const snapshot = () => [...servers.values()].map(entry => ({ ...entry.public }));
  const notify = () => { try { emit('activeServers', snapshot()); } catch { /* renderer teardown */ } };
  function status(entry, value) { if (entry.public.status !== value) { entry.public.status = value; notify(); } }
  function log(entry, line, stream) {
    if (!line) return;
    if (Buffer.byteLength(line) > 16384) line = Buffer.from(line).subarray(0, 16384).toString('utf8') + ' [truncated]';
    const record = { line, stream, timestamp: new Date().toISOString() };
    entry.logs.push(record);
    entry.logBytes += Buffer.byteLength(line);
    while (entry.logs.length > maxLogLines || entry.logBytes > maxLogBytes) entry.logBytes -= Buffer.byteLength(entry.logs.shift().line);
    if (!entry.url) {
      const match = line.match(/http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?:\/[^\s\u001b]*)?/i);
      if (match) {
        const candidate = new URL(match[0].replace('0.0.0.0', '127.0.0.1').replace('localhost', '127.0.0.1'));
        const port = Number(candidate.port);
        if (port > 0 && port <= 65535) { entry.url = candidate.toString(); entry.public.port = port; }
      }
    }
  }
  function capture(entry, readable, stream) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const consume = text => {
      pending += text;
      const lines = pending.split(/\r\n|\n|\r/);
      pending = lines.pop();
      for (const line of lines) log(entry, line, stream);
      if (Buffer.byteLength(pending) > 16384) { log(entry, pending, stream); pending = ''; }
    };
    readable.on('data', chunk => consume(decoder.write(chunk)));
    readable.once('end', () => { consume(decoder.end()); log(entry, pending, stream); pending = ''; });
  }
  async function terminate(entry, finalStatus = 'stopped') {
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopping = true;
    entry.stopPromise = (async () => {
      const child = entry.child;
      if (child?.pid && !entry.closed) {
        if (process.platform === 'win32') {
          await new Promise(resolve => {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
            const timer = setTimeout(() => { killer.kill(); resolve(); }, stopTimeoutMs);
            const done = () => { clearTimeout(timer); resolve(); };
            killer.once('error', done); killer.once('exit', done);
          });
        } else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
        }
        await Promise.race([entry.whenClosed, pause(stopTimeoutMs)]);
        if (!entry.closed) {
          try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill(); } catch {}
          await Promise.race([entry.whenClosed, pause(stopTimeoutMs)]);
        }
      }
      if (child && !entry.closed) {
        entry.reason = 'Could not confirm that the dev server stopped';
        status(entry, 'error'); return false;
      }
      status(entry, finalStatus);
      return true;
    })();
    return entry.stopPromise;
  }
  async function start(cwd, name, sessionId) {
    if (disposed) return { error: 'Launch supervisor is closed' };
    let realCwd;
    try { realCwd = fs.realpathSync(cwd); if (!fs.statSync(realCwd).isDirectory()) throw new Error(); }
    catch { return { error: 'Project directory is unavailable' }; }
    try { if (!await isTrusted(realCwd)) return { refused: true, error: 'Project is not trusted for running dev servers' }; }
    catch { return { refused: true, error: 'Project trust could not be verified' }; }
    if (disposed) return { error: 'Launch supervisor is closed' };
    const configs = readConfigurations(realCwd);
    const config = name === undefined ? configs[0] : configs.find(row => row.name === name);
    if (!config) return {};
    const key = realCwd + '\0' + config.name;
    const running = [...servers.values()].find(entry => entry.key === key && !entry.stopping && ['starting', 'running'].includes(entry.public.status));
    if (running) return running.startPromise || { serverId: running.public.serverId };
    if (launches.has(key)) return launches.get(key);
    const pending = (async () => {
      if (config.port > 0 && await portOpen(config.port, probeTimeoutMs)) return { error: `Port ${config.port} is already in use` };
      if (disposed) return { error: 'Launch supervisor is closed' };
      let command;
      try { command = buildLaunchCommand(config.runtimeExecutable, config.runtimeArgs, baseEnv); }
      catch (error) { return { error: error.message }; }
      const serverId = randomUUID();
      const entry = { key, logs: [], logBytes: 0, child: null, closed: false, stopping: false,
        url: config.port > 0 ? `http://127.0.0.1:${config.port}/` : null,
        public: { serverId, name: config.name, port: config.port || 0, status: 'starting', startedAt: new Date().toISOString(), cwd: realCwd,
          ...(typeof sessionId === 'string' ? { sessionId } : {}) } };
      servers.set(serverId, entry); notify();
      let close;
      entry.whenClosed = new Promise(resolve => { close = resolve; });
      try {
        entry.child = spawn(command.executable, command.args, { cwd: realCwd, env: { ...baseEnv },
          windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments,
          detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        entry.closed = true; close(); entry.reason = `Could not start dev server (${error.code || 'spawn_failed'})`; status(entry, 'error');
        return { error: entry.reason };
      }
      const child = entry.child;
      capture(entry, child.stdout, 'stdout'); capture(entry, child.stderr, 'stderr');
      child.once('error', error => { entry.reason = `Could not start dev server (${error.code || 'spawn_failed'})`; log(entry, entry.reason, 'stderr'); status(entry, 'error'); });
      child.once('exit', (code, signal) => {
        if (!entry.stopping && entry.public.status !== 'error') {
          entry.reason = `Dev server exited (${code === null ? signal : code})`; log(entry, entry.reason, 'stderr'); status(entry, 'error');
        }
      });
      child.once('close', () => { entry.closed = true; close(); });
      const ready = (async () => {
        const deadline = Date.now() + startTimeoutMs;
        while (!disposed && !entry.stopping && !entry.closed && entry.public.status === 'starting' && Date.now() < deadline) {
          if (entry.url && await probeHttp(entry.url, Math.min(probeTimeoutMs, Math.max(1, deadline - Date.now())))) {
            if (disposed || entry.stopping || entry.closed || entry.public.status !== 'starting') break;
            status(entry, 'running');
            try { emit('previewUrlChanged', serverId, entry.url); } catch {}
            return { serverId };
          }
          await pause(pollIntervalMs);
        }
        const reason = entry.reason || (entry.stopping || disposed ? 'Dev server start was cancelled' : 'Dev server did not become reachable before the startup timeout');
        entry.reason = reason;
        await terminate(entry, entry.stopping || disposed ? 'stopped' : 'error');
        return { error: reason };
      })();
      entry.startPromise = ready;
      return ready;
    })();
    launches.set(key, pending);
    try { return await pending; } finally { if (launches.get(key) === pending) launches.delete(key); }
  }
  return {
    getConfiguredServices: readConfigurations,
    startFromConfig: start,
    getActiveServers: snapshot,
    getLogs(serverId) { return (servers.get(serverId)?.logs || []).map(record => ({ ...record })); },
    getPreviewUrl(serverId) { const entry = servers.get(serverId); return entry?.public.status === 'running' && !entry.stopping ? entry.url : null; },
    async stopServer(serverId) { const entry = servers.get(serverId); return entry ? terminate(entry) : false; },
    dispose() {
      if (!disposal) { disposed = true; disposal = Promise.all([...servers.values()].map(entry => terminate(entry))).then(() => undefined); }
      return disposal;
    },
  };
}

module.exports = { createPreviewLaunch, readConfigurations, buildLaunchCommand };
