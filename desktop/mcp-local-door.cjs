'use strict';

// A local-config connection door, not an authority provider. The caller must
// supply a synchronous guard backed by the session, config and policy owners.
// It must reject foreign/unknown transcript origins, reserved names, disabled
// tools and retired session/config generations as appropriate to the operation.
function createLocalMcpDoor({ host }) {
  if (!host || !(host.servers instanceof Map) || typeof host.connect !== 'function') {
    throw new TypeError('MCP host required');
  }

  async function run({ name, operation, toolName, args, uri, isAuthorized }) {
    if (typeof name !== 'string' || !name || typeof isAuthorized !== 'function') throw new Error('MCP access denied');
    if (!['listResources', 'readResource', 'callTool'].includes(operation)) throw new Error('MCP access denied');
    const state = host.servers.get(name);
    const check = () => {
      if (!state || host.servers.get(name) !== state || isAuthorized() !== true) throw new Error('MCP access denied');
    };
    check();
    await host.connect(name);
    check();
    const connection = state.connection;
    if (state.status !== 'connected' || !connection) throw new Error('MCP server unavailable');
    let result;
    if (operation === 'listResources') result = await connection.listResources();
    else if (operation === 'readResource') result = await connection.readResource(uri);
    else result = await connection.callTool(toolName, args ?? {});
    check();
    if (state.connection !== connection || state.status !== 'connected') throw new Error('MCP server unavailable');
    return result;
  }
  return { run };
}

module.exports = { createLocalMcpDoor };

// Bind a host load to an exact config file instance and bytes. This detects
// observed changes, replacements and failed reads; it is not a cross-process
// lock or proof that an unobserved A -> B -> A change never occurred.
function createConfigFileLease({ host, getPath }) {
  const fs = require('node:fs');
  const path = require('node:path');
  if (!host || typeof host.load !== 'function' || typeof getPath !== 'function') throw new TypeError('config owner required');
  const read = () => {
    const name = getPath();
    if (typeof name !== 'string' || !name || !path.isAbsolute(name)) throw new Error('config unavailable');
    const filename = path.resolve(name);
    const fd = fs.openSync(filename, 'r');
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > 8388608n) throw new Error('invalid config file');
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd, { bigint: true });
      const named = fs.statSync(filename, { bigint: true });
      const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
        a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
      if (!same(before, after) || !same(after, named)) throw new Error('config changed');
      return { filename, bytes, stat: after };
    } finally { fs.closeSync(fd); }
  };
  const snapshot = read();
  let parsed;
  try { parsed = JSON.parse(snapshot.bytes.toString('utf8')); } catch { throw new Error('invalid config'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid config');
  host.load(parsed);
  if (!(host.servers instanceof Map)) throw new TypeError('host server map required');
  const states = new Map([...host.servers].map(([name, state]) => [name, { state, server: structuredClone(state.server) }]));
  const { isDeepStrictEqual } = require('node:util');
  const isCurrent = () => {
    try {
      const fresh = read();
      return fresh.filename === snapshot.filename && fresh.stat.dev === snapshot.stat.dev &&
        fresh.stat.ino === snapshot.stat.ino && fresh.stat.size === snapshot.stat.size &&
        fresh.stat.mtimeNs === snapshot.stat.mtimeNs && fresh.stat.ctimeNs === snapshot.stat.ctimeNs &&
        fresh.bytes.equals(snapshot.bytes) && states.size === host.servers.size &&
        [...states].every(([name, item]) => host.servers.get(name) === item.state &&
          isDeepStrictEqual(item.state.server, item.server));
    } catch { return false; }
  };
  if (!isCurrent()) throw new Error('config changed');
  return { isCurrent };
}
module.exports.createConfigFileLease = createConfigFileLease;
