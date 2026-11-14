'use strict';

// The native client compares both normalized names and MCP tool-name prefixes.
const sanitize = value => value.replace(/[^a-zA-Z0-9_-]/g, '_');
const key = value => sanitize(value).toLowerCase().replace(/[-_]+/g, '_');
const readName = value => value.toLowerCase().replace(/-/g, '_');
function nameParts(value) {
  const clean = sanitize(value);
  return {
    keys: [...new Set([key(value), key(value.replace(/^plugin:/, ''))])],
    read: [`${value}:`, `mcp__local_${clean}__`, `mcp__internal_${clean}__`, `mcp__${clean}__`, `mcp__remote-devices__${clean}__`]
      .map(readName).filter(item => item !== 'mcp__remote_devices__'),
  };
}
function matchesCliServer(names, name) {
  if (typeof name !== 'string' || !(names instanceof Set || Array.isArray(names))) return false;
  const requested = nameParts(name);
  return [...names].some(candidate => {
    if (typeof candidate !== 'string') return false;
    if (candidate === name) return true;
    const item = nameParts(candidate);
    return item.keys.some(value => requested.keys.includes(value)) ||
      item.read.some(value => requested.read.some(other => value.startsWith(other) || other.startsWith(value)));
  });
}
const contains = (values, key) => values instanceof Set ? values.has(key) : Array.isArray(values) && values.includes(key);
function isToolDisabled(session, server, tool) {
  const full = `${server}:${tool}`;
  const disabledConnectors = Array.isArray(session.remoteMcpServersConfig) && session.mcpConnectorsAsked != null
    ? session.remoteMcpServersConfig.filter(item => !contains(session.mcpConnectorsAsked, item.uuid)) : [];
  const connectorId = full.split(':', 1)[0];
  if (contains(session.mcpConnectorsAskedOut, connectorId) || disabledConnectors.some(item => item.uuid === connectorId)) return true;
  const disabled = new Set(session.mcpToolsAskedOff instanceof Set || Array.isArray(session.mcpToolsAskedOff) ? session.mcpToolsAskedOff : []);
  for (const item of disabledConnectors) for (const entry of item.tools ?? []) disabled.add(`${item.uuid}:${entry.name}`);
  return disabled.has(full) || disabled.has(`local:${full}`) ||
    session.enabledMcpTools?.[full] === false || session.enabledMcpTools?.[`local:${full}`] === false;
}
module.exports = { matchesCliServer, isToolDisabled };
