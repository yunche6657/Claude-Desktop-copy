// Live probe: does the agent loop actually drive a tool call?
//
// Runs against the configured endpoint with a real model. This is a probe, not a
// test: it needs credentials and network, so it is not part of `npm test`.
//
//   node build/probe-agent.cjs
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAgent } = require('../desktop/agent.cjs');
const { defineTools, definitionsFor } = require('../desktop/tools.cjs');

const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.empfish.net';
const API_KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PROBE_MODEL || 'claude-sonnet-5-5';

async function main() {
  if (!API_KEY) {
    console.error('no API key in ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY');
    process.exitCode = 2;
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-probe-'));
  fs.writeFileSync(path.join(root, 'greeting.txt'), 'hello from the probe\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'probe', version: '1.2.3' }, null, 2));

  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const events = [];

  try {
    const result = await runAgent({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
      system: 'You are a coding agent. Use the tools to answer. Be terse.',
      messages: [{
        role: 'user',
        content: 'Read greeting.txt and package.json, then tell me the version and the greeting in one line.',
      }],
      tools: definitionsFor(tools),
      execute: async request => {
        const tool = tools.find(candidate => candidate.name === request.name);
        if (!tool) return { content: `Unknown tool ${request.name}`, isError: true };
        return await tool.handler(request.input);
      },
      onEvent: event => {
        events.push(event);
        if (event.type === 'turn') console.log(`--- turn ${event.turn}`);
        if (event.type === 'tool_request') {
          console.log(`  tool_request ${event.name} ${JSON.stringify(event.input)}`);
        }
        if (event.type === 'tool_result') {
          console.log(`  tool_result ${event.name}${event.isError ? ' (error)' : ''}: ${event.preview.split('\n')[0]}`);
        }
        if (event.type === 'tool_error') console.log(`  tool_error ${event.name}: ${event.message}`);
        if (event.type === 'text') console.log(`  text: ${event.text.trim().slice(0, 160)}`);
      },
      maxTurns: 8,
    });

    const usedTools = events.filter(e => e.type === 'tool_request').map(e => e.name);
    console.log('\n=== summary');
    console.log('turns          :', result.turns);
    console.log('tools used     :', usedTools.join(', ') || '(none)');
    console.log('stop reason    :', result.stopReason);
    console.log('final text     :', result.text.trim().slice(0, 300));
    console.log('toolUseDriven  :', usedTools.length > 0);

    // A loop that never called a tool would mean the seam is still broken.
    process.exitCode = usedTools.length > 0 ? 0 : 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('probe failed:', error.code || '', error.message);
  if (error.detail) console.error(JSON.stringify(error.detail).slice(0, 600));
  process.exitCode = 1;
});
