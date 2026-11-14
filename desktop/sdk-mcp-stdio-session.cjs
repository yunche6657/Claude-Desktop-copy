'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { createSdkResourceSession } = require('./sdk-mcp-resource-session.cjs');

// This creates a host-owned connection, not a connection owned by the CLI.
function createSdkStdioSession({ command, args = [], cwd, env, notifyClient = () => {}, onMessage = () => {} }) {
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let ended = false, stderr = '';
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const fail = error => {
    if (ended) return;
    ended = true;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    session.close();
  };
  const session = createSdkResourceSession({ notifyClient, dispatch(message) {
    if (ended) throw Error('MCP transport closed');
    if (!Object.hasOwn(message, 'id')) { child.stdin.write(JSON.stringify(message) + '\n'); return null; }
    return new Promise((resolve, reject) => {
      pending.set(message.id, { resolve, reject });
      child.stdin.write(JSON.stringify(message) + '\n', error => {
        if (error && pending.delete(message.id)) reject(error);
      });
    });
  } });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
  child.stdin.on('error', fail);
  child.on('error', fail);
  child.on('exit', () => fail(Error('MCP server exited')));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { fail(Error('invalid MCP frame')); child.kill(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      fail(Error('invalid MCP frame')); child.kill(); return;
    }
    try { onMessage(message); } catch (error) { fail(error); child.kill(); return; }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const p = pending.get(message.id);
      if (p) { pending.delete(message.id); p.resolve(message); }
    } else if (message.method && !Object.hasOwn(message, 'id')) {
      Promise.resolve(session.notification(message)).catch(fail);
    } else { fail(Error('unsupported MCP server request')); child.kill(); }
  });
  return { ccb: session.ccb, read: session.read, pid: child.pid, exit,
    get stderr() { return stderr; },
    close() { fail(Error('MCP transport closed')); child.stdin.end(); },
  };
}
module.exports = { createSdkStdioSession };
