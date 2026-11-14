// Enter must actually run the command.
//
// The terminal pane's shell is a real child process with PIPED stdio (there is no PTY
// binding in this project). xterm sends a BARE CR (0x0D) when Enter is pressed, because
// that is what a real terminal transmits. cmd.exe reading from a pipe does not treat a
// bare CR as end-of-line, so the command sat in the line buffer forever.
//
// Measured with no project code involved (tools/_cmd-cr.cjs):
//   stdin "echo MARKER73\r"     -> banner only, MARKER73 never printed
//   stdin "echo MARKER73\r\n"   -> echoes the command and prints MARKER73
//   stdin "echo MARKER73\n"     -> same as CRLF
//
// So every keystroke was delivered correctly and pressing Enter still did nothing. On the
// live app before this fix, the bridge received
//   writeShellPty ["<session>", "\r"]        (charCodes [13] -- a real CR)
// and the shell produced no output at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShellSessions } = require('../desktop/shell-sessions.cjs');

/**
 * A spawn stub that records what was written to stdin and lets the test drive output.
 * Using a stub keeps the assertion about the TRANSLATION; the process-level behaviour is
 * proved separately by tools/_cmd-cr.cjs.
 */
function makeStub() {
  const written = [];
  const listeners = {};
  const child = {
    pid: 4242,
    stdin: { write: (data) => { written.push(data); return true; } },
    stdout: { on: (ev, fn) => { listeners[`stdout:${ev}`] = fn; } },
    stderr: { on: (ev, fn) => { listeners[`stderr:${ev}`] = fn; } },
    on: (ev, fn) => { listeners[ev] = fn; },
    kill: () => {},
  };
  return { child, written, listeners, spawnImpl: () => child };
}

function makeShells(stub, events = []) {
  return createShellSessions({
    emit: (e) => events.push(e),
    log: () => {},
    spawnImpl: stub.spawnImpl,
  });
}

test('a bare CR is translated to CRLF before reaching the shell', () => {
  const stub = makeStub();
  const shells = makeShells(stub);
  shells.start('s1', 80, 24, 'pane_open', null, true, {});

  shells.write('s1', '\r');

  assert.deepEqual(stub.written, ['\r\n'], 'Enter must arrive as CRLF over a pipe');
});

test('CRLF is not turned into CR CR LF', () => {
  // A renderer that already sends CRLF must pass through unchanged; otherwise every
  // Enter would insert a blank line.
  const stub = makeStub();
  const shells = makeShells(stub);
  shells.start('s1', 80, 24, 'pane_open', null, true, {});

  shells.write('s1', 'dir\r\n');

  assert.deepEqual(stub.written, ['dir\r\n']);
});

test('a lone LF is left alone', () => {
  const stub = makeStub();
  const shells = makeShells(stub);
  shells.start('s1', 80, 24, 'pane_open', null, true, {});

  shells.write('s1', 'dir\n');

  assert.deepEqual(stub.written, ['dir\n']);
});

test('a CR in the middle of input is translated, not just a trailing one', () => {
  const stub = makeStub();
  const shells = makeShells(stub);
  shells.start('s1', 80, 24, 'pane_open', null, true, {});

  // Pasted multi-line input: each CR is a line break that must execute.
  shells.write('s1', 'echo a\recho b\r');

  assert.deepEqual(stub.written, ['echo a\r\necho b\r\n']);
});

test('ordinary text passes through byte for byte', () => {
  const stub = makeStub();
  const shells = makeShells(stub);
  shells.start('s1', 80, 24, 'pane_open', null, true, {});

  shells.write('s1', 'echo hello world');

  assert.deepEqual(stub.written, ['echo hello world']);
});

test('writing to an unknown session still reports no shell', () => {
  const stub = makeStub();
  const shells = makeShells(stub);
  const result = shells.write('nope', 'x\r');
  assert.equal(result.ok, false);
  assert.match(String(result.error), /no shell/);
  assert.deepEqual(stub.written, []);
});

test('output still reaches subscribers unchanged', () => {
  // The translation must apply only to input, never to output: rewriting shell output
  // would corrupt carriage returns used for progress bars.
  const stub = makeStub();
  const events = [];
  const shells = makeShells(stub, events);
  shells.start('s1', 80, 24, 'pane_open', null, true, {});

  stub.listeners['stdout:data'](Buffer.from('progress 50%\rprogress 100%\r\n'));
  const data = events.filter((e) => e.type === 'shell_pty_data').map((e) => e.data).join('');

  assert.ok(data.includes('progress 50%\rprogress 100%'), 'carriage returns in output must survive');
  assert.ok(!data.includes('\r\n\r\n'), 'output must not have CRs expanded');
});
