// Tests for the shell sessions behind the terminal pane.
//
// The renderer's terminal checks `if (!t || !t.ok) { startFailed }`, so an answer
// without `ok` rendered "Failed to start shell" on every open. Answering a fake
// {ok:true} would be worse — the pane would look alive and drop every keystroke.
// These tests pin both the reply shape and the fact that a real child process runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShellSessions, defaultShell } = require('../desktop/shell-sessions.cjs');

/** A fake child that records stdin and can emit output on demand. */
function fakeChild() {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const written = [];
  child.stdin = { write: (d) => { written.push(d); return true; } };
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', 0, null); };
  child.written = written;
  return child;
}

function makeSessions() {
  const events = [];
  const children = [];
  const sessions = createShellSessions({
    emit: (e) => events.push(e),
    spawnImpl: () => { const c = fakeChild(); children.push(c); return c; },
  });
  return { sessions, events, children };
}

test('start answers {ok:true, shell} — the shape the pane checks', () => {
  const { sessions } = makeSessions();
  const res = sessions.start('local_a', 80, 24, 'pane_open', 'C:\\work');
  assert.equal(res.ok, true, 'without ok the pane shows "Failed to start shell"');
  assert.equal(typeof res.shell, 'string');
  assert.match(res.shell, /^shell_/);
});

test('start reports isPty:false rather than implying terminal semantics', () => {
  // This build pipes a child process; it is not a PTY. Saying so is what keeps a
  // caller from expecting full-screen TUI behaviour.
  const { sessions } = makeSessions();
  const res = sessions.start('local_a', 80, 24, 'pane_open', 'C:\\work');
  assert.equal(res.isPty, false);
});

test('start spawns a real child and reports its pid', () => {
  const { sessions, children } = makeSessions();
  const res = sessions.start('local_a', 80, 24, 'pane_open', 'C:\\work');
  assert.equal(children.length, 1);
  assert.equal(res.pid, 4242);
});

test('child output is streamed as shell_pty_data', () => {
  const { sessions, events, children } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open');
  children[0].stdout.emit('data', Buffer.from('hello\n'));
  const evt = events.find((e) => e.type === 'shell_pty_data');
  assert.ok(evt, 'output must reach the renderer');
  assert.equal(evt.data, 'hello\n');
  assert.equal(evt.sessionId, 'local_a');
});

test('stderr is streamed too, so errors are visible', () => {
  const { sessions, events, children } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open');
  children[0].stderr.emit('data', Buffer.from('bad\n'));
  assert.ok(events.some((e) => e.type === 'shell_pty_data' && e.data === 'bad\n'));
});

test('writeShellPty forwards keystrokes to the child', () => {
  const { sessions, children } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open');
  const res = sessions.write('local_a', 'echo hi\r');
  assert.equal(res.ok, true);
  // Enter arrives from xterm as a bare CR and leaves as CRLF. The child is a piped
  // process, not a PTY, and cmd.exe does not end a line on a bare CR over a pipe:
  // forwarding "\r" unchanged made Enter do nothing at all. See shell-enter.test.mjs.
  assert.deepEqual(children[0].written, ['echo hi\r\n']);
});

test('writeShellPty on an unknown session reports failure instead of throwing', () => {
  const { sessions } = makeSessions();
  const res = sessions.write('local_nope', 'x');
  assert.equal(res.ok, false);
  assert.equal(typeof res.error, 'string');
});

test('a second start reuses the running shell and replays its buffer', () => {
  // Reopening the pane must not spawn a second process, and the output produced
  // while the pane was closed is what `buffered` carries.
  const { sessions, children } = makeSessions();
  const first = sessions.start('local_a', 80, 24, 'pane_open');
  children[0].stdout.emit('data', Buffer.from('earlier output\n'));
  const second = sessions.start('local_a', 80, 24, 'pane_open');

  assert.equal(children.length, 1, 'must not spawn again');
  assert.equal(second.shell, first.shell);
  assert.equal(second.buffered, 'earlier output\n');
});

test('the buffer is consumed once, not replayed forever', () => {
  const { sessions, children } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open');
  children[0].stdout.emit('data', Buffer.from('once\n'));
  const second = sessions.start('local_a', 80, 24, 'pane_open');
  const third = sessions.start('local_a', 80, 24, 'pane_open');
  assert.equal(second.buffered, 'once\n');
  assert.equal(third.buffered, '', 'the replay must not repeat');
});

test('stop kills the child and reports a close event', () => {
  const { sessions, events, children } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open');
  sessions.stop('local_a');
  assert.equal(children[0].killed, true);
  assert.ok(events.some((e) => e.type === 'shell_pty_close'));
});

test('the child exiting closes the session', () => {
  const { sessions, events, children } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open');
  children[0].emit('close', 0, null);
  const close = events.find((e) => e.type === 'shell_pty_close');
  assert.ok(close);
  assert.equal(close.reason, 'exit 0');
  assert.equal(sessions.has('local_a'), false);
});

test('a spawn error closes the session instead of hanging', () => {
  const { sessions, events, children } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open');
  children[0].emit('error', new Error('spawn failed'));
  assert.ok(events.some((e) => e.type === 'shell_pty_close' && /spawn failed/.test(e.reason)));
  assert.equal(sessions.has('local_a'), false);
});

test('a throwing spawn reports ok:false instead of crashing', () => {
  const sessions = createShellSessions({
    emit: () => {},
    spawnImpl: () => { throw new Error('no shell here'); },
  });
  const res = sessions.start('local_a', 80, 24, 'pane_open');
  assert.equal(res.ok, false);
  assert.match(res.error, /no shell here/);
});

test('resize records the size and states it was not applied to the child', () => {
  // A pipe has no window size; claiming otherwise would be a lie the UI acts on.
  const { sessions } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open');
  const res = sessions.resize('local_a', 120, 40);
  assert.equal(res.ok, true);
  assert.equal(res.applied, false);
  assert.equal(res.cols, 120);
  assert.equal(res.rows, 40);
});

test('list reports the shells that exist', () => {
  const { sessions } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open', 'C:\\work');
  const list = sessions.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, 'local_a');
  assert.equal(list[0].cwd, 'C:\\work');
});

test('the spawn really receives the cwd the pane passed', () => {
  // `list()` reporting a cwd is not the same as the child being started there;
  // the pane's prompt comes from the process, not from our bookkeeping.
  const seen = [];
  const { EventEmitter } = require('node:events');
  const sessions = createShellSessions({
    emit: () => {},
    spawnImpl: (cmd, args, opts) => {
      seen.push({ cmd, args, cwd: opts && opts.cwd, stdio: opts && opts.stdio });
      const c = new EventEmitter();
      c.pid = 7;
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.stdin = { write: () => true };
      c.kill = () => {};
      return c;
    },
  });
  sessions.start('local_a', 80, 24, 'pane_open', 'C:\\work');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cwd, 'C:\\work', 'the child must actually start in the session folder');
  assert.deepEqual(seen[0].stdio, ['pipe', 'pipe', 'pipe']);
});

test('a null cwd is passed through as null, not invented', () => {
  // The renderer sends `spawnCwd: undefined` for every non-landing session
  // (cccc2cf0a: `spawnCwd: e.type==="landing" ? o : void 0`), so the bridge sees
  // null. Substituting the Electron process cwd would make the pane's prompt lie
  // about which folder the shell is in.
  const seen = [];
  const { EventEmitter } = require('node:events');
  const sessions = createShellSessions({
    emit: () => {},
    spawnImpl: (cmd, args, opts) => {
      seen.push(opts && opts.cwd);
      const c = new EventEmitter();
      c.pid = 8;
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.stdin = { write: () => true };
      c.kill = () => {};
      return c;
    },
  });
  const res = sessions.start('local_b', 80, 24, 'pane_open', null);
  assert.equal(seen[0], undefined, 'must not substitute a cwd');
  assert.equal(res.ok, true);
  assert.equal(sessions.list()[0].cwd, null, 'and must report the absence honestly');
});

test('writeShellPty delivers every keystroke without trimming or coalescing', () => {
  // The renderer writes one character per call, so a handler that trimmed or dropped
  // input would corrupt every keystroke. The CR is the one character that is
  // deliberately translated (to CRLF, see shell-enter.test.mjs); everything else must
  // arrive byte for byte.
  const { sessions, children } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open');
  for (const ch of 'echo hi') sessions.write('local_a', ch);
  sessions.write('local_a', '\r');
  assert.equal(children[0].written.join(''), 'echo hi\r\n');
  // No empty writes and nothing swallowed along the way.
  assert.equal(children[0].written.filter((w) => w === '').length, 0);
});

test('dispose stops every shell', () => {
  const { sessions, children } = makeSessions();
  sessions.start('local_a', 80, 24, 'pane_open');
  sessions.start('local_b', 80, 24, 'pane_open');
  sessions.dispose();
  assert.equal(children.every((c) => c.killed), true);
  assert.equal(sessions.list().length, 0);
});

test('defaultShell returns something usable for this platform', () => {
  const shell = defaultShell();
  assert.equal(typeof shell, 'string');
  assert.ok(shell.length > 0);
});
