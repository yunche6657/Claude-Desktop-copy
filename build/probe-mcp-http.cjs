// Live HTTP transport check against a real server.
//
// The unit tests drive HttpConnection through an injected fetch, which proves the
// wire format but not that a real server accepts it. This stands up a minimal
// Streamable-HTTP MCP server on loopback and talks to it over actual HTTP.
//
//   node build/probe-mcp-http.cjs
'use strict';

const http = require('node:http');
const { McpHost } = require('../desktop/mcp-host.cjs');

/** A tiny MCP server: one JSON endpoint, session id, JSON and SSE responses. */
function startServer() {
  const sessions = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'DELETE') {
        const id = req.headers['mcp-session-id'];
        sessions.delete(id);
        res.writeHead(204).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let message;
      try { message = JSON.parse(raw); }
      catch { res.writeHead(400).end(); return; }

      const reply = result => {
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(req.headers['mcp-session-id'] ? {} : { 'mcp-session-id': 'sess-live' }),
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };

      if (message.id === undefined) {
        // A notification: 202, no body.
        res.writeHead(202).end();
        return;
      }
      if (message.method === 'initialize') {
        sessions.add('sess-live');
        reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'live-http-fixture', version: '1.0.0' },
        });
        return;
      }
      if (message.method === 'tools/list') {
        reply({
          tools: [
            { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } },
            { name: 'sum', description: 'Add', inputSchema: { type: 'object' } },
          ],
        });
        return;
      }
      if (message.method === 'tools/call') {
        const args = message.params?.arguments || {};
        if (message.params?.name === 'echo') {
          reply({ content: [{ type: 'text', text: String(args.text ?? '') }] });
          return;
        }
        if (message.params?.name === 'sum') {
          reply({ content: [{ type: 'text', text: String(Number(args.a || 0) + Number(args.b || 0)) }] });
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown tool' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, sessions });
    });
  });
}

async function main() {
  const { server, port, sessions } = await startServer();
  const host = new McpHost();
  try {
    host.load({
      mcpServers: {
        live: { type: 'http', url: `http://127.0.0.1:${port}/mcp` },
      },
    });

    const state = await host.connect('live');
    console.log('connect     :', state.status, 'tools:', state.toolCount);

    const echo = await host.callTool('live', 'echo', { text: 'real-http' });
    console.log('echo        :', echo.content[0].text);

    const sum = await host.callTool('live', 'sum', { a: 20, b: 22 });
    console.log('sum         :', sum.content[0].text);

    await host.disconnect('live');
    console.log('sessions    :', sessions.size, '(DELETE should have cleared it)');

    const ok = state.status === 'connected'
      && state.toolCount === 2
      && echo.content[0].text === 'real-http'
      && sum.content[0].text === '42'
      && sessions.size === 0;
    console.log('\nhttpTransportWorks:', ok);
    process.exitCode = ok ? 0 : 1;
  } finally {
    host.stopAll();
    server.close();
  }
}

main().catch(error => {
  console.error('probe failed:', error.code || '', error.message);
  process.exitCode = 1;
});
