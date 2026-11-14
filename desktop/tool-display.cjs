'use strict';

// UI-only projections. Keep execution/replay inputs and persisted CLI rows intact.
// Shipped renderer contract: shell rows prefer input.description to input.command;
// file rows read file_path, and Agent/Task rows read description.
const SECRET_KEY = /^(?:.*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|cookie|credentials?)(?:[_-].*)?$/i;
const SHELL_TOOLS = new Set(['Bash', 'BashTool', 'PowerShell', 'PowerShellTool', 'bash', 'power_shell']);
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'FileRead', 'FileWrite', 'FileEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task', 'Subagent']);

function redactText(value) {
  return String(value)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [REDACTED]')
    .replace(/((?:https?:\/\/)[^\s/@:]+:)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:[?&]|\b)(?:[\w-]*(?:token|password|passwd|secret|api[_-]?key|authorization|cookie)[\w-]*)\s*=\s*)("[^"]*"|'[^']*'|[^\s&;|]+)/gi, '$1[REDACTED]')
    .replace(/((?:--?|\/)(?:[\w-]*(?:token|password|passwd|secret|api[_-]?key|authorization|cookie)[\w-]*)(?:\s+|[:=]))("[^"]*"|'[^']*'|[^\s;|]+)/gi, '$1[REDACTED]')
    .replace(/((?:["']?(?:authorization|cookie|x-api-key)["']?)\s*:\s*)("[^"]*"|'[^']*'|[^\r\n,}]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]');
}
function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const result = Array.isArray(value) ? value.map(item => redact(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redact(item, seen)]));
  seen.delete(value);
  return result;
}
function objectInput(value) {
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch {}
    return { command: value };
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function firstString(input, names) {
  return names.map(name => input[name]).find(value => typeof value === 'string' && value.trim());
}
function normalizeToolDisplayInput(name, value) {
  const input = redact(objectInput(value));
  if (SHELL_TOOLS.has(name)) {
    const command = firstString(input, ['command', 'cmd', 'command_line', 'script']);
    if (command) {
      input.command = command;
      const description = firstString(input, ['description']);
      // The renderer hides command whenever description exists. Include both so a
      // vague model label never conceals what actually ran (multiline stays intact).
      input.description = description ? (description.includes(command) ? description : `${description} — ${command}`) : command;
    }
  } else if (FILE_TOOLS.has(name)) {
    const file = firstString(input, ['file_path', 'path', 'filePath', 'notebook_path']);
    if (file) input.file_path = file;
  } else if (AGENT_TOOLS.has(name)) {
    const description = firstString(input, ['description', 'title']);
    const details = [
      ['agent', firstString(input, ['subagent_type', 'agent_type', 'agent', 'name'])],
      ['model', firstString(input, ['model'])],
      ['effort', firstString(input, ['effort', 'effortLevel'])],
      ['prompt', firstString(input, ['prompt', 'task'])],
    ].filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`);
    const suffix = details.join(' — ');
    if (description || suffix) {
      input.description = suffix && description !== suffix && !description?.endsWith(` — ${suffix}`)
        ? [description, suffix].filter(Boolean).join(' — ')
        : description || suffix;
    }
  }
  return input;
}
function projectBlock(block) {
  if (!block || typeof block !== 'object' || !['tool_use', 'server_tool_use'].includes(block.type)) return block;
  return { ...block, input: normalizeToolDisplayInput(block.name, block.input) };
}
function projectTranscriptEntry(entry) {
  if (!Array.isArray(entry?.message?.content)) return entry;
  return { ...entry, message: { ...entry.message, content: entry.message.content.map(projectBlock) } };
}
function projectToolDisplayEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (['tool_request', 'tool_use', 'tool_approval_needed'].includes(event.type)) {
    return { ...redact(event), input: normalizeToolDisplayInput(event.name || event.toolName, event.input) };
  }
  if (['tool_permission_request', 'tool_permission_resolved'].includes(event.type) && event.request) {
    return { ...event, request: { ...redact(event.request), input: normalizeToolDisplayInput(event.request.name || event.request.toolName, event.request.input) } };
  }
  if (event.type === 'message') return { ...event, message: projectTranscriptEntry(event.message) };
  return event;
}
module.exports = { normalizeToolDisplayInput, projectToolDisplayEvent, projectTranscriptEntry, redactText };
