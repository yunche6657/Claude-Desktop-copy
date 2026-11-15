// Shell sessions for the terminal pane.
//
// The renderer's terminal asks for a shell and then reads its output from the
// `onShellPtyEvent` channel:
//
//   startShellPty(sessionId, cols, rows, spawnReason, cwd, linkAware, options)
//     -> { ok: true, shell: <id>, buffered?: string, waiting?: boolean }
//   events: { type: "shell_pty_data", sessionId, data }
//           { type: "shell_pty_close", sessionId, reason? }
//           { type: "shell_pty_link", sessionId, link, shell }
//
// An earlier version answered a made-up handle with no `ok` field, so the caller's
// `if (!t || !t.ok) { startFailed }` path fired and the pane showed
// "Failed to start shell". Answering a *fake* success would be worse: the terminal
// would render and then silently ignore every keystroke.
//
// What this module actually does: it spawns a real child process per session and
// pipes bytes both ways. It is not a PTY — there is no ConPTY binding in this
// project (node-pty is not a dependency) — so programs that require a terminal
// (full-screen TUIs, interactive prompts) will not behave correctly, and the child
// sees pipes rather than a console. Plain commands, the shell itself, and anything
// line-oriented work. `isPty: false` states that honestly rather than implying
// terminal semantics.
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const path = require('node:path');

// CMD writes pipe output in its console code page, not necessarily UTF-8. Keep
// that code page: changing it with chcp also changes how CMD reads piped input.
// Query once per shell executable; chcp's final number is locale-independent.
const cmdEncodings = new Map();
function defaultOutputEncoding(shellPath) {
  if (process.platform !== 'win32' || !/^cmd(?:\.exe)?$/i.test(path.win32.basename(shellPath))) return 'utf-8';
  if (cmdEncodings.has(shellPath)) return cmdEncodings.get(shellPath);
  const result = spawnSync(shellPath, ['/d', '/c', 'chcp'], {
    windowsHide: true, encoding: 'ascii', timeout: 3000,
  });
  const codePage = result.status === 0 && /([0-9]+)\s*$/.exec(result.stdout || '');
  const labels = {
    65001: 'utf-8', 936: 'gbk', 54936: 'gb18030', 950: 'big5',
    932: 'shift_jis', 949: 'euc-kr', 866: 'ibm866', 874: 'windows-874',
    1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252',
    1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255',
    1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  };
  const encoding = labels[codePage && codePage[1]] || 'utf-8';
  cmdEncodings.set(shellPath, encoding);
  return encoding;
}

/** Default shell for the host platform. */
function defaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/sh';
}

/**
 * @param {{
 *   emit: (event: object) => void,       // pushes to the onShellPtyEvent channel
 *   log?: (msg: string) => void,
 *   spawnImpl?: Function,                // injectable for tests
 *   outputEncoding?: string,             // explicit stream encoding for tests/hosts
 * }} opts
 */
function createShellSessions({ emit, log = () => {}, spawnImpl, outputEncoding } = {}) {
  const doSpawn = spawnImpl || spawn;
  /** sessionId -> { child, shell, cols, rows, cwd, closed, buffer } */
  const sessions = new Map();
  // Output produced before the renderer attached is replayed on the next start,
  // which is what `buffered` is for.
  const BUFFER_LIMIT = 64 * 1024;

  const send = (event) => {
    try { emit(event); } catch { /* window tearing down */ }
  };

  const appendBuffer = (entry, chunk) => {
    entry.buffer = (entry.buffer + chunk).slice(-BUFFER_LIMIT);
  };

  /**
   * Start (or reuse) a shell for a session.
   * @returns {{ok: boolean, shell?: string, buffered?: string, isPty: boolean, error?: string}}
   */
  function start(sessionId, cols, rows, spawnReason, cwd, linkAware, options) {
    const existing = sessions.get(sessionId);
    if (existing && !existing.closed) {
      // Already running: hand back the same shell id and replay what it printed,
      // which is what a reopened pane expects.
      const buffered = existing.buffer;
      existing.buffer = '';
      return { ok: true, shell: existing.shell, buffered, isPty: false, reused: true };
    }

    const shellPath = defaultShell();
    const workingDirectory = typeof cwd === 'string' && cwd ? cwd
      : (options && typeof options.cwd === 'string' ? options.cwd : undefined);

    let child;
    let stdoutDecoder;
    let stderrDecoder;
    try {
      const encoding = outputEncoding || (spawnImpl ? 'utf-8' : defaultOutputEncoding(shellPath));
      stdoutDecoder = new TextDecoder(encoding);
      stderrDecoder = new TextDecoder(encoding);
      child = doSpawn(shellPath, [], {
        cwd: workingDirectory,
        env: process.env,
        // Pipes, not a console: see the module comment. This is stated to callers
        // through `isPty: false` rather than silently pretending otherwise.
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      log(`shell spawn failed: ${error && error.message}`);
      return { ok: false, error: String(error && error.message), isPty: false };
    }

    const shellId = `shell_${require('node:crypto').randomUUID()}`;
    const entry = {
      child,
      shell: shellId,
      cols: typeof cols === 'number' ? cols : 80,
      rows: typeof rows === 'number' ? rows : 24,
      cwd: workingDirectory || null,
      spawnReason: spawnReason || 'pane_open',
      closed: false,
      buffer: '',
    };
    sessions.set(sessionId, entry);

    // A spawn that fails asynchronously (missing binary, bad cwd) arrives as
    // 'error', not as a throw; report it the way the renderer expects.
    child.on('error', (error) => {
      entry.closed = true;
      log(`shell error: ${error && error.message}`);
      send({ type: 'shell_pty_close', sessionId, reason: String(error && error.message) });
      sessions.delete(sessionId);
    });

    const publish = (text) => {
      if (!text) return;
      appendBuffer(entry, text);
      send({ type: 'shell_pty_data', sessionId, data: text });
    };
    // Decoders belong to individual streams and sessions. A byte sequence may
    // span data events, and stderr must never complete a stdout character.
    child.stdout.on('data', (chunk) => {
      publish(typeof chunk === 'string' ? chunk : stdoutDecoder.decode(chunk, { stream: true }));
    });
    child.stderr.on('data', (chunk) => {
      publish(typeof chunk === 'string' ? chunk : stderrDecoder.decode(chunk, { stream: true }));
    });
    child.on('close', (code, signal) => {
      publish(stdoutDecoder.decode());
      publish(stderrDecoder.decode());
      entry.closed = true;
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      send({ type: 'shell_pty_close', sessionId, reason });
      sessions.delete(sessionId);
    });

    log(`shell started ${shellId} (${spawnReason || 'pane_open'}) pid=${child.pid}`);
    return { ok: true, shell: shellId, isPty: false, pid: child.pid ?? null };
  }

  /**
   * Write user input to the shell.
   *
   * A terminal emulator sends a BARE CR (0x0D) when Enter is pressed -- that is the
   * byte a real terminal transmits, and xterm does exactly that. A pipe is not a
   * terminal: cmd.exe reading from a pipe treats a bare CR as part of the line and
   * never executes it. Measured directly, no project code involved:
   *
   *   stdin bytes                 cmd.exe output
   *   "echo MARKER73\r"           banner only, command never runs
   *   "echo MARKER73\r\n"         echoes the command and prints MARKER73
   *   "echo MARKER73\n"           same as CRLF
   *
   * So every keystroke reached this function and was forwarded correctly, but pressing
   * Enter produced no visible effect: the terminal pane stayed on the banner forever and
   * looked broken even though the shell was alive. Translating a lone CR into CRLF here
   * is what makes Enter work over a pipe; a genuine CR followed by LF is left alone so a
   * renderer that already sends CRLF is not turned into CR CR LF.
   */
  function normaliseInput(data) {
    if (typeof data !== 'string') return data;
    // "\r" not followed by "\n" -> "\r\n". Done in one pass so "a\rb" becomes "a\r\nb".
    return data.replace(/\r(?!\n)/g, '\r\n');
  }

  /** Write user input to the shell. */
  function write(sessionId, data) {
    const entry = sessions.get(sessionId);
    if (!entry || entry.closed) return { ok: false, error: 'no shell' };
    if (typeof data !== 'string' || data === '') return { ok: true };
    try {
      entry.child.stdin.write(normaliseInput(data));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error && error.message) };
    }
  }

  /** Stop the shell for a session. */
  function stop(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return { ok: true };
    entry.closed = true;
    try { entry.child.kill(); } catch { /* already gone */ }
    sessions.delete(sessionId);
    return { ok: true };
  }

  /** Resize. A pipe has no window size, so this records the value and reports it. */
  function resize(sessionId, cols, rows) {
    const entry = sessions.get(sessionId);
    if (!entry) return { ok: false, error: 'no shell' };
    entry.cols = typeof cols === 'number' ? cols : entry.cols;
    entry.rows = typeof rows === 'number' ? rows : entry.rows;
    // No SIGWINCH equivalent over pipes; stated rather than faked.
    return { ok: true, applied: false, cols: entry.cols, rows: entry.rows };
  }

  /**
   * Record a title for a shell, so the terminal tab can show it.
   *
   * The renderer calls this whenever it derives a label (c9ddef367, fn r):
   *   for (const shell of shells) bridge.setShellPtyTitle(key(session, shell.id), label)
   * and cccc2cf0a calls it again once the shell reports its name. The bridge answered
   * { ok: true } without storing anything, so every tab kept its placeholder label forever.
   *
   * A title is metadata about a live shell, so an unknown id is refused rather than invented.
   */
  function setTitle(sessionId, title) {
    const entry = sessions.get(sessionId);
    if (!entry) return { ok: false, error: 'no shell' };
    if (typeof title !== 'string') return { ok: false, error: 'invalid title' };
    entry.title = title;
    return { ok: true, title: entry.title };
  }

  /** The recorded title for a shell, or null. Used by list() and by tests. */
  function title(sessionId) {
    const entry = sessions.get(sessionId);
    return entry && typeof entry.title === 'string' ? entry.title : null;
  }

  /** The shells this build knows about, in the shape getTerminalShells returns. */
  function list() {
    return [...sessions.entries()].map(([sessionId, entry]) => ({
      sessionId,
      shell: entry.shell,
      cols: entry.cols,
      rows: entry.rows,
      cwd: entry.cwd,
      spawnReason: entry.spawnReason,
      ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
      isPty: false,
    }));
  }

  /** Kill every shell (used on shutdown). */
  function dispose() {
    for (const [sessionId] of sessions) stop(sessionId);
  }

  return {
    start,
    write,
    stop,
    resize,
    list,
    setTitle,
    title,
    dispose,
    has: (id) => sessions.has(id),
  };
}

module.exports = { createShellSessions, defaultShell };
