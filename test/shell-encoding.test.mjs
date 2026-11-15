import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShellSessions } = require('../desktop/shell-sessions.cjs');

function fixture(outputEncoding) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true };
  child.kill = () => {};
  const events = [];
  const shells = createShellSessions({ outputEncoding, spawnImpl: () => child, emit: e => events.push(e) });
  shells.start('encoding', 80, 24);
  return { child, shells, events, text: () => events.filter(e => e.type === 'shell_pty_data').map(e => e.data).join('') };
}

test('CMD GBK copyright and Chinese cwd survive arbitrary byte boundaries and replay', () => {
  const f = fixture('gbk');
  // GBK bytes captured from the default Chinese Windows CMD banner/prompt.
  const bytes = Buffer.from('286329204d6963726f736f667420436f72706f726174696f6ea1a3b1a3c1f4cbf9d3d0c8a8c0fba1a30d0a433a5cd7a2b2e1bac520c4e6cff23e', 'hex');
  for (const byte of bytes) f.child.stdout.emit('data', Buffer.from([byte]));
  const expected = '(c) Microsoft Corporation。保留所有权利。\r\nC:\\注册号 逆向>';
  assert.equal(f.text(), expected);
  assert.equal(f.shells.start('encoding').buffered, expected);
});

test('UTF-8 characters split between stdout chunks stay intact', () => {
  const f = fixture('utf-8');
  for (const byte of Buffer.from('中文🙂\rprogress\n')) f.child.stdout.emit('data', Buffer.from([byte]));
  assert.equal(f.text(), '中文🙂\rprogress\n');
});

test('stdout and stderr maintain independent pending multibyte sequences', () => {
  const f = fixture('gbk');
  f.child.stdout.emit('data', Buffer.from([0xd6]));
  f.child.stderr.emit('data', Buffer.from([0xce]));
  f.child.stdout.emit('data', Buffer.from([0xd0]));
  f.child.stderr.emit('data', Buffer.from([0xc4]));
  assert.equal(f.text(), '中文');
});

test('a trailing incomplete sequence flushes before the close event', () => {
  const f = fixture('utf-8');
  f.child.stderr.emit('data', Buffer.from([0xe4]));
  assert.equal(f.text(), '');
  f.child.emit('close', 0, null);
  assert.equal(f.text(), '\ufffd');
  assert.equal(f.events.at(-1).type, 'shell_pty_close');
});

test('real Windows CMD banner, Chinese cwd, Enter and stderr decode correctly', {
  skip: process.platform !== 'win32', timeout: 10000,
}, async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-中文-'));
  const events = [];
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });
  const shells = createShellSessions({ emit: event => {
    events.push(event);
    if (event.type === 'shell_pty_close') finish();
  } });
  t.after(() => { shells.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); });
  assert.equal(shells.start('live', 80, 24, 'pane_open', cwd).ok, true);
  shells.write('live', 'echo ENCODING_ENTER_OK\recho ENCODING_STDERR_OK 1>&2\rexit\r');
  await closed;
  const text = events.filter(e => e.type === 'shell_pty_data').map(e => e.data).join('');
  assert.ok(text.includes('Microsoft'), text);
  assert.ok(text.includes(cwd), text);
  assert.ok(text.includes('ENCODING_ENTER_OK\r\n'), text);
  assert.match(text, /ENCODING_STDERR_OK *\r\n/);
  assert.ok(!text.includes('\ufffd'), text);
});
