// Where the gateway settings actually come from.
//
// Two different parts of the product need this answer and must never disagree:
//   * the launcher (tools/launch-replica.cjs) — it injects ANTHROPIC_* into the child;
//   * the bridge (desktop/bridge-services.cjs) — the settings UI asks it "is the provider
//     configured?" and, on 2026-10-23, answered "no" while turns were running fine.
//
// Keeping one resolver here means a change in precedence shows up in both places.
//
// Precedence:
//   1. configLibrary/<_meta.json appliedId>.json   (the shipped app's own source)
//   2. any other profile listed in _meta.json entries
//   3. any other .json in configLibrary            (historical layouts)
//   4. ~/.claude/settings.json  env block          (what the CLI itself reads)
//   5. the process environment
//
// Every step has to yield a real base URL to be accepted. "There is a json file" is not an
// answer — on this host configLibrary had `{"entries": []}` plus one profile carrying no
// gateway fields, and the old single-source reader turned that into "no gateway at all".
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EMPTY = Object.freeze({
  baseUrl: '',
  apiKey: '',
  apiType: 'anthropic',
  model: '',
  provider: '',
  source: 'none',
  file: null,
  raw: null,
});

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function pickString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function normaliseApiType(value) {
  if (value === undefined || value === null || value === '') return 'anthropic';
  if (!['anthropic', 'openai-chat', 'openai-responses'].includes(value)) throw new Error('Unsupported inferenceApiType');
  return value;
}

/** A profile may carry flat gateway keys or a nested credentials object. */
function normaliseProfile(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const credentials = source.credentials && typeof source.credentials === 'object' ? source.credentials : {};
  return {
    baseUrl: pickString(source.inferenceGatewayBaseUrl, source.baseUrl, credentials.baseUrl),
    apiKey: pickString(source.inferenceGatewayApiKey, source.apiKey, credentials.apiKey, credentials.accessToken),
    apiType: normaliseApiType(pickString(source.inferenceApiType, source.apiType, credentials.apiType)),
    model: pickString(source.model, source.defaultModel, ...(Array.isArray(source.inferenceModels) ? source.inferenceModels.map(entry =>
      typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? pickString(entry.id, entry.model, entry.name) : '') : [])), 
    provider: pickString(source.inferenceProvider, source.provider),
    raw: source,
  };
}

/** The configLibrary directories the shipped app writes, in preference order. */
function configLibraryDirs(env) {
  if (env.CLAUDE_RECONSTRUCTION_CONFIG_DIR) return [env.CLAUDE_RECONSTRUCTION_CONFIG_DIR];
  return [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'CodeDesktop-Reconstruction', 'configLibrary') : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Claude-3p', 'configLibrary') : null,
    env.APPDATA ? path.join(env.APPDATA, 'Claude-3p', 'configLibrary') : null,
    env.APPDATA ? path.join(env.APPDATA, 'code-desktop-reconstruction', 'configLibrary') : null,
  ].filter(Boolean);
}

/**
 * Profile files in the order they should be tried.
 *
 * Reading _meta.json first is what keeps the applied profile authoritative: picking
 * "whichever json comes first" made the profile name render as a UUID and marked every
 * profile as applied (the bug fixed in round 95).
 */
function profileFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const meta = readJsonFile(path.join(dir, '_meta.json'));
  const entries = Array.isArray(meta && meta.entries) ? meta.entries : [];
  const appliedId = meta && typeof meta.appliedId === 'string' ? meta.appliedId : null;

  // Deduplicated: the applied profile is usually also listed in entries and is also a file
  // on disk, and handing the same path to the reader three times makes the "which profile
  // won" question depend on iteration count instead of order.
  const ordered = [];
  const seen = new Set();
  const push = (file) => {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(file);
  };

  if (appliedId) push(path.join(dir, `${appliedId}.json`));
  for (const entry of entries) {
    if (entry && typeof entry.id === 'string') push(path.join(dir, `${entry.id}.json`));
  }
  for (const name of names.sort()) {
    if (name.endsWith('.json') && name !== '_meta.json') push(path.join(dir, name));
  }
  return ordered;
}

function fromConfigLibrary(env) {
  for (const dir of configLibraryDirs(env)) {
    for (const file of profileFiles(dir)) {
      const profile = readJsonFile(file);
      if (!profile || typeof profile !== 'object') continue;
      let normalised;
      try { normalised = normaliseProfile(profile); } catch { continue; }
      if (normalised.baseUrl) return { ...normalised, source: 'configLibrary', file };
    }
  }
  return null;
}

function fromClaudeSettings(env) {
  const home = env.USERPROFILE || env.HOME || (env === process.env ? os.homedir() : '');
  if (!home) return null;
  const file = path.join(home, '.claude', 'settings.json');
  const settings = readJsonFile(file);
  const block = settings && settings.env;
  if (!block || typeof block !== 'object') return null;
  const normalised = normaliseProfile({
    inferenceGatewayBaseUrl: block.ANTHROPIC_BASE_URL,
    inferenceGatewayApiKey: block.ANTHROPIC_AUTH_TOKEN || block.ANTHROPIC_API_KEY,
    inferenceApiType: block.ANTHROPIC_API_TYPE,
    model: block.ANTHROPIC_MODEL || block.CLAUDE_AGENT_MODEL,
  });
  return normalised.baseUrl ? { ...normalised, source: 'claude-settings', file } : null;
}

function fromEnvironment(env) {
  const normalised = normaliseProfile({
    inferenceGatewayBaseUrl: env.ANTHROPIC_BASE_URL,
    inferenceGatewayApiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY,
    inferenceApiType: env.ANTHROPIC_API_TYPE,
    model: env.ANTHROPIC_MODEL || env.CLAUDE_AGENT_MODEL,
  });
  return normalised.baseUrl ? { ...normalised, source: 'environment', file: null } : null;
}

/** Resolve the gateway. Never throws; returns EMPTY when nothing is configured. */
function resolveGateway(options = process.env) {
  // Keep the existing resolveGateway(env) callers while accepting explicit options.
  const env = options.env || options;
  let library, settings, environment;
  try { library = fromConfigLibrary(env); } catch { /* malformed profiles remain editable in Settings */ }
  try { if (!env.CLAUDE_RECONSTRUCTION_CONFIG_DIR) settings = fromClaudeSettings(env); } catch { /* invalid legacy settings */ }
  try { environment = fromEnvironment(env); } catch { /* invalid environment format */ }
  return library || settings || environment || { ...EMPTY };
}

/**
 * The provider profile the settings UI reads.
 *
 * The UI's "Your provider setup needs a fix" banner is driven by whether a profile exists
 * at all, not by whether inference works. When the library is empty but a gateway IS
 * resolvable, saying "nothing configured" is the wrong answer -- it tells the user to fix
 * something that is not broken. So a resolved gateway is presented as a profile, marked
 * with where it came from.
 *
 * @returns {null | {id: string, name: string, config: object, source: string, file: string|null}}
 */
function synthesizeProfile(resolved) {
  if (!resolved || !resolved.baseUrl) return null;
  const fromSettings = resolved.source === 'claude-settings';
  return {
    id: `resolved-${resolved.source}`,
    name: fromSettings ? 'Claude settings' : 'Environment',
    source: resolved.source,
    file: resolved.file,
    config: {
      // Field names the shipped profile uses, so the settings form renders instead of
      // showing blank inputs next to a healthy state.
      inferenceProvider: resolved.provider || 'gateway',
      inferenceGatewayBaseUrl: resolved.baseUrl,
      inferenceGatewayApiKey: resolved.apiKey,
      inferenceApiType: resolved.apiType || 'anthropic',
      model: resolved.model || undefined,
      // Provenance, for the UI to explain why the fields are read-only-ish.
      resolvedFrom: resolved.source,
      resolvedFromFile: resolved.file,
    },
  };
}

module.exports = {
  EMPTY,
  configLibraryDirs,
  profileFiles,
  normaliseProfile,
  resolveGateway,
  synthesizeProfile,
};
