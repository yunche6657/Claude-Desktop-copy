'use strict';
const {formatMcpError}=require('./mcp-error.cjs');

// The desktop's GA projection omits config, which can contain credentials.
const transports = new Set(['stdio', 'sse', 'http', 'ws', 'sdk', 'sse-ide', 'ws-ide', 'claudeai-proxy']);
const scopes = new Set(['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed', 'agent', 'flag']);

function projectMcpStatus(server) {
  const type = server.config?.type ?? (server.config && 'command' in server.config ? 'stdio' : undefined);
  const transport = type === undefined ? undefined : transports.has(type) ? type : 'unknown';
  const scope = scopes.has(server.scope) ? server.scope : undefined;
  return {
    name: server.name,
    status: server.status,
    ...(server.status === 'failed' && typeof server.error === 'string' && server.error ? { error:formatMcpError(server.error) } : {}),
    ...(transport ? { transport } : {}),
    ...(scope ? { scope } : {}),
    ...(server.status === 'connected' && server.tools ? { toolCount: server.tools.length } : {}),
  };
}

module.exports = { projectMcpStatus };
