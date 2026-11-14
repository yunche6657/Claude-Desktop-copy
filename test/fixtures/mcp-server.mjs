// A minimal MCP stdio server used by the tests.
//
// Speaks the same newline-delimited JSON-RPC that the real servers do, so the
// client is exercised against the wire format rather than against a mock of its
// own functions. Behaviour is chosen by argv:
//
//   --mode ok        answers initialize / tools/list / tools/call
//   --mode garbage   prints a non-JSON line
//   --mode silent    never answers (drives the timeout path)
//   --mode crash     exits immediately
'use strict';

const modeFlag = process.argv.indexOf('--mode');
const mode = modeFlag >= 0 ? process.argv[modeFlag + 1] : 'ok';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message);
  }
});

function handle(message) {
  if (mode === 'crash') process.exit(3);
  if (mode === 'silent') return;
  if (mode === 'garbage') { process.stdout.write('this is not json\n'); return; }

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-server', version: '1.0.0' },
      },
    });
    return;
  }

  if (message.method === 'notifications/initialized') return;

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echoes its input', inputSchema: { type: 'object' } },
          { name: 'add', description: 'Adds two numbers', inputSchema: { type: 'object' } },
        ],
      },
    });
    return;
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(args.text ?? '') }] } });
      return;
    }
    if (name === 'add') {
      const sum = Number(args.a || 0) + Number(args.b || 0);
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(sum) }] } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown tool ${name}` } });
    return;
  }

  if (typeof message.id === 'number') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
}
