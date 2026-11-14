// getSSHConfigs is the most-called fallback channel in the app and now has a real handler.
//
// Measured across 73 recorded replica runs: 13,373 fallback hits on 80 distinct channels,
// and getSSHConfigs alone accounted for 1,631 of them (12-16 calls per startup). Every
// consumer tolerates null, so nothing crashed — but the remote-host picker stayed empty on
// any machine that did have ~/.ssh/config. SSH is a shipped feature (43 bundles, 292 zh-Hans
// strings), so null was a missing feature wearing a safe-looking mask.
//
// The implementation parses the user's own ~/.ssh/config. Rules verified against a synthetic
// file (`Host alpha` with HostName/User/Port/IdentityFile, `Host beta gamma` sharing one
// HostName, and `Host *.internal`):
//   alpha            -> 4 options attached
//   beta, gamma      -> two rows, each keeping its own name and the shared HostName
//   *.internal       -> skipped, it is a pattern, not a host
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

/** Extract the SSH parser from the bridge and run it against a synthetic home directory. */
function parseWith(homeDir) {
  const start = BRIDGE_SOURCE.indexOf('const readSshHosts = () => {');
  assert.ok(start > 0, 'readSshHosts is missing from the bridge');
  const end = BRIDGE_SOURCE.indexOf('    };', start) + 6;
  const body = BRIDGE_SOURCE.slice(start, end).replace('os.homedir()', 'home');
  // eslint-disable-next-line no-new-func
  const run = new Function('path', 'os', 'fs', 'home', body + ' return readSshHosts();');
  return run(path, os, fs, homeDir);
}

/** A throwaway home directory holding the given ~/.ssh/config text. */
function homeWith(configText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-config-'));
  fs.mkdirSync(path.join(dir, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ssh', 'config'), configText);
  return dir;
}

test('a machine without ~/.ssh/config answers an empty array, not null', () => {
  // [] and null mean different things to the picker; this channel is called on every start.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-none-'));
  try {
    const hosts = parseWith(dir);
    assert.ok(Array.isArray(hosts), 'the answer is not an array');
    assert.equal(hosts.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Host block contributes its name and options', () => {
  const dir = homeWith(
    ['Host alpha', '  HostName alpha.example.com', '  User deploy', '  Port 2222',
      '  IdentityFile ~/.ssh/id_alpha'].join('\n'),
  );
  try {
    const hosts = parseWith(dir);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].sshHost, 'alpha');
    assert.equal(hosts[0].sshHostName, 'alpha.example.com');
    assert.equal(hosts[0].sshUser, 'deploy');
    assert.equal(hosts[0].sshPort, 2222);
    assert.equal(hosts[0].sshIdentityFile, '~/.ssh/id_alpha');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('several patterns on one Host line each become a row', () => {
  // Measured bug: the first version kept only the last pattern, so `gamma` vanished.
  const dir = homeWith(['Host beta gamma', '  HostName beta.example.com'].join('\n'));
  try {
    const hosts = parseWith(dir);
    assert.equal(hosts.length, 2, 'expected two rows, got ' + hosts.length);
    assert.deepEqual(hosts.map((h) => h.sshHost), ['beta', 'gamma']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a shared HostName does not overwrite the row names', () => {
  // Both rows must stay distinguishable in the picker.
  const dir = homeWith(['Host beta gamma', '  HostName shared.example.com'].join('\n'));
  try {
    const hosts = parseWith(dir);
    assert.deepEqual(hosts.map((h) => h.sshHost), ['beta', 'gamma']);
    assert.equal(hosts[0].sshHostName, 'shared.example.com');
    assert.equal(hosts[1].sshHostName, 'shared.example.com');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wildcard patterns are skipped', () => {
  // `Host *.internal` is a matching rule, not a machine you can connect to.
  const dir = homeWith(['Host *.internal', '  User root', 'Host real', '  HostName real.example.com'].join('\n'));
  try {
    const hosts = parseWith(dir);
    assert.deepEqual(hosts.map((h) => h.sshHost), ['real']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('comments and blank lines are ignored', () => {
  const dir = homeWith(['# a comment', '', 'Host delta', '  # trailing note', '  HostName d.example.com'].join('\n'));
  try {
    const hosts = parseWith(dir);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].sshHost, 'delta');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('both namespaces register the handler', () => {
  assert.match(BRIDGE_SOURCE, /define\(`claude\.web_\$_\$\{svc\}_\$_getSSHConfigs`/, 'the handler is not registered');
});
