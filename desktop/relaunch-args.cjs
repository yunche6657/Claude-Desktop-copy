'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const claudeProtocols = new Set(['claude:', 'claude-dev:', 'claude-nest:', 'claude-nest-dev:', 'claude-nest-prod:']);

function isTransientRelaunchArg(arg) {
  if (arg === '--startup' || arg === '--relaunched-after-gpu-crash-loop' ||
      arg.startsWith('--os-entry=') || arg.startsWith('--claude-hybrid-switch-org=')) return true;
  if (URL.canParse(arg) && claudeProtocols.has(new URL(arg).protocol)) return true;
  const lower = arg.toLowerCase();
  if (lower.endsWith('.dxt') || lower.endsWith('.mcpb')) return true;
  let candidate = arg;
  if (/^[a-zA-Z]:"$/.test(candidate)) candidate = `${candidate.slice(0, 2)}\\`;
  else if (candidate.startsWith('file:')) {
    try { candidate = fileURLToPath(candidate); } catch { /* retain invalid URL */ }
  }
  return path.isAbsolute(candidate);
}

function buildRelaunchArgs(argv = process.argv, defaultApp = process.defaultApp, additionalArgs = []) {
  const start = defaultApp ? 2 : 1;
  return [...argv.slice(1, start), ...argv.slice(start).filter(arg => !isTransientRelaunchArg(arg)), ...additionalArgs];
}

module.exports = { buildRelaunchArgs, isTransientRelaunchArg };
