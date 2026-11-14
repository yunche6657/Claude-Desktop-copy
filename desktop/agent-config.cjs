// Agent configuration.
//
// Resolves the endpoint, key, model and tool set for agent mode from the
// environment, and builds the `run` function server.mjs calls.
//
// Configuration is explicit: with no key, agent mode refuses to start rather
// than silently degrading to demo. That is the difference between "tools are
// off" and "tools are on but nothing can drive them".
'use strict';

const path = require('node:path');
const { runAgent } = require('./agent.cjs');
const { defineTools, definitionsFor } = require('./tools.cjs');
const { createApprovalExecutor } = require('./tool-approval.cjs');
const { MODES, VALID_MODES } = require('./permissions.cjs');
const { listSkills } = require('./local-skills.cjs');

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * Read the applied provider profile from the config library.
 *
 * The library is the same one Custom3pSetup manages (see bridge-services.cjs):
 *   configLibrary/_meta.json  -> { entries: [{id, name}], appliedId }
 *   configLibrary/<id>.json   -> the profile, including endpoint / key / model
 *
 * Why this exists: `resolveConfig` used to read ONLY environment variables, so choosing a
 * provider in the settings UI wrote the profile to disk and then changed nothing -- the
 * agent kept talking to whatever the environment said. Editing the profile had no effect
 * on the running agent.
 *
 * @returns {{id: string, dir: string, profile: object}|null}
 */
function readAppliedProfile(fsImpl, pathImpl, env) {
  const candidates = env.CLAUDE_RECONSTRUCTION_CONFIG_DIR ? [env.CLAUDE_RECONSTRUCTION_CONFIG_DIR] : [
    env.LOCALAPPDATA ? pathImpl.join(env.LOCALAPPDATA, 'CodeDesktop-Reconstruction', 'configLibrary') : null,
    env.LOCALAPPDATA ? pathImpl.join(env.LOCALAPPDATA, 'Claude-3p', 'configLibrary') : null,
    env.APPDATA ? pathImpl.join(env.APPDATA, 'code-desktop-reconstruction', 'configLibrary') : null,
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (!fsImpl.existsSync(dir)) continue;
      const metaPath = pathImpl.join(dir, '_meta.json');
      if (!fsImpl.existsSync(metaPath)) continue;
      const meta = JSON.parse(fsImpl.readFileSync(metaPath, 'utf8'));
      const entries = Array.isArray(meta && meta.entries) ? meta.entries : [];
      if (!entries.length) continue;
      const id = (typeof meta.appliedId === 'string' && meta.appliedId) || entries[0].id;
      if (!id) continue;
      const file = pathImpl.join(dir, `${id}.json`);
      if (!fsImpl.existsSync(file)) continue;
      const profile = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      if (!profile || typeof profile !== 'object') continue;
      return { id, dir, profile };
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Reads the agent settings.
 *
 * Precedence: environment variable > applied profile > built-in default.
 * Environment still wins so an explicit `ANTHROPIC_BASE_URL=... node tools/launch-replica.cjs`
 * stays authoritative (the launcher and probes rely on it), while the settings UI takes
 * effect when nothing is set in the environment.
 */
function resolveConfig(env = process.env, deps = {}) {
  const fsImpl = deps.fs || require('node:fs');
  const pathImpl = deps.path || require('node:path');

  const applied = readAppliedProfile(fsImpl, pathImpl, env);
  const profile = (applied && applied.profile) || {};
  // A profile may carry the flat gateway keys or a nested credentials object.
  const cred = profile.credentials && typeof profile.credentials === 'object'
    ? profile.credentials : {};

  const pick = (...values) => {
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  const profileBaseUrl = pick(profile.inferenceGatewayBaseUrl, profile.baseUrl, cred.baseUrl, DEFAULT_BASE_URL);
  const baseUrl = pick(env.ANTHROPIC_BASE_URL, profileBaseUrl);
  const profileMatches = !env.ANTHROPIC_BASE_URL || (() => {
    try { return new URL(baseUrl).href.replace(/\/$/, '') === new URL(profileBaseUrl).href.replace(/\/$/, ''); }
    catch { return false; }
  })();
  const apiKey = pick(
    env.ANTHROPIC_AUTH_TOKEN,
    env.ANTHROPIC_API_KEY,
    profileMatches && profile.apiKey,
    profileMatches && profile.inferenceGatewayApiKey,
    profileMatches && cred.apiKey,
    profileMatches && cred.accessToken,
  );
  /**
   * R637: the shipped settings UI writes `inferenceModels` — an ARRAY whose first entry is the default model — and this
   * resolver only read `profile.model` / `profile.defaultModel`. So a user could fill in Gateway base URL and API key,
   * pick a model in the UI, and still be told "agent configuration incomplete", because nothing here ever looked at the key
   * the UI produced. Measured: `inferenceModels` appeared zero times in this file.
   *
   * The first entry is the default by the UI's own documented rule ("First entry is the default"). Read the list before
   * legacy scalar keys so editing the UI list takes effect even when an imported profile retains an older `model`.
   * Explicit environment overrides still win; empty or malformed lists fall back to the legacy scalar keys.
   */
  const firstFromList = (list) => {
    if (!Array.isArray(list)) return '';
    for (const entry of list) {
      if (typeof entry === 'string' && entry.trim()) return entry.trim();
      // The UI also accepts objects; the model id is the identity field.
      if (entry && typeof entry === 'object') {
        const id = pick(entry.id, entry.model, entry.name);
        if (id) return id;
      }
    }
    return '';
  };

  const model = pick(
    env.CLAUDE_AGENT_MODEL,
    env.ANTHROPIC_MODEL,
    profileMatches && firstFromList(profile.inferenceModels),
    profileMatches && profile.model,
    profileMatches && profile.defaultModel,
  );
  const mode = pick(env.CLAUDE_PERMISSION_MODE, profileMatches && profile.permissionMode, MODES.ASK);

  return {
    baseUrl,
    apiKey,
    model,
    permissionMode: VALID_MODES.has(mode) ? mode : MODES.ASK,
    // Where the values came from, so the UI can say "from environment" vs "from profile".
    source: (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) ? 'env'
      : (profileMatches && applied ? 'profile' : 'none'),
    profileId: profileMatches && applied ? applied.id : null,
  };
}

/** True when the environment can actually drive a model. */
function isConfigured(env = process.env) {
  const config = resolveConfig(env);
  return Boolean(config.apiKey && config.model);
}

/**
 * Builds the agent runner.
 *
 * `approve` is async (request) => 'allow' | 'cancel' | 'timeout'. The desktop
 * shell passes the consent manager; a headless host passes a refusing stub, so
 * an unattended run cannot silently mutate the workspace.
 */
/**
 * The directories the installed skills live in, for command EXECUTION only.
 *
 * A skill is not just prose: docx ships scripts/comment.py, pdf ships
 * scripts/convert_pdf_to_images.py, and those scripts import their siblings, so they
 * have to run with the skill directory as the working directory. Without this the agent
 * could read a skill's instructions and then be unable to follow them --
 * measured: "working directory is outside the approved roots", and running the script by
 * absolute path from the workspace dies on `import` because the sibling module is not on
 * sys.path.
 *
 * This deliberately does NOT widen allowedRoots: file reads and writes stay confined to
 * the workspace. Only the Bash working directory may point here, and those scripts are
 * read-only helpers by nature.
 *
 * @returns {string[]}
 */
function skillRoots() {
  const roots = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return roots;
  const plugins = require('node:path').join(home, 'AppData', 'Local', 'Claude-3p',
    'local-agent-mode-sessions', 'skills-plugin');
  let accounts;
  try {
    accounts = require('node:fs').readdirSync(plugins, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const account of accounts) {
    if (!account.isDirectory()) continue;
    const accountDir = require('node:path').join(plugins, account.name);
    let versions;
    try {
      versions = require('node:fs').readdirSync(accountDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const skills = require('node:path').join(accountDir, version.name, 'skills');
      if (require('node:fs').existsSync(skills)) roots.push(skills);
    }
  }
  return roots;
}

/**
 * The skill catalogue as the model should see it: name + when to use it.
 *
 * The Customize > Skills page lists eleven skills the installed app ships with, but
 * the agent never saw them: the system prompt was three fixed sentences and the skill
 * directory was only ever read for the UI. So asking for a .docx produced a hand-rolled
 * script instead of the docx skill, and the Skills page was decoration.
 *
 * Only the front matter is included (name, description) — that is the part that decides
 * whether a skill applies. The bodies are loaded on demand through readSkillFiles.
 *
 * @param {string} dataDir
 * @returns {Array<{name: string, description: string, enabled: boolean}>}
 */
function skillCatalogue(dataDir) {
  let skills;
  try {
    skills = listSkills(dataDir);
  } catch {
    return [];
  }
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((skill) => skill && skill.enabled !== false && typeof skill.name === 'string')
    .map((skill) => ({
      name: skill.name,
      description: typeof skill.description === 'string' ? skill.description : '',
      enabled: skill.enabled !== false,
    }));
}

/**
 * The system prompt, with the skill catalogue appended when there is one.
 *
 * Kept as a function so the prompt is rebuilt per run: a skill created in the UI is
 * usable in the very next message instead of after a restart.
 *
 * @param {Array<{name: string, description: string}>} skills
 * @returns {string}
 */
function buildSystemPrompt(skills) {
  const base = 'You are Claude Code, a coding agent working inside the user\'s workspace. '
    + 'Use the provided tools to inspect and change files and to run commands. '
    + 'Prefer reading before editing. Keep replies short.';
  if (!skills.length) return base;
  const lines = skills.map((skill) => {
    const when = skill.description.trim();
    return when ? `- ${skill.name}: ${when}` : `- ${skill.name}`;
  });
  return base + '\n\n'
    + 'The following skills are installed. When a request falls inside one of them, '
    + 'follow that skill rather than improvising your own approach:\n'
    + lines.join('\n');
}

function createAgentRunner({ workspaceRoot, approve, env = process.env, onEvent = () => {}, permissionMode, model } = {}) {
  // The SESSION decides the mode, not the process. main.cjs keys its runner cache by the
  // mode it was asked for, but this function used to drop the argument and resolve the
  // mode from env/profile only. Measured: createAgentRunner({permissionMode: 'acceptEdits'})
  // reported permissionMode 'ask', so a session recorded as 接受编辑 still prompted for
  // every Write and the card said "ask mode prompts before edits and commands".
  const resolved = resolveConfig(env);
  // The SESSION also decides the model. MEASURED BEFORE THIS: the parameter did not exist,
  // so a session whose model the user changed still ran on the process-config model —
  // switching to 'definitely-not-a-real-model-xyz' produced a normal reply. Same shape as the
  // permissionMode fix above: the caller passed it and this function dropped it.
  const config = {
    ...resolved,
    ...(VALID_MODES.has(permissionMode) && permissionMode !== resolved.permissionMode
      ? { permissionMode }
      : {}),
    ...(typeof model === 'string' && model && model !== resolved.model ? { model } : {}),
  };
  if (!config.apiKey) throw new Error('agent mode needs ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY');
  if (!config.model) throw new Error('agent mode needs CLAUDE_AGENT_MODEL or ANTHROPIC_MODEL');

  const root = workspaceRoot ? path.resolve(workspaceRoot) : process.cwd();
  const allowedRoots = [root];
  const tools = defineTools({ workspaceRoot: root, allowedRoots, execRoots: [root, ...skillRoots()] });
  const definitions = definitionsFor(tools);

  return {
    model: config.model,
    permissionMode: config.permissionMode,
    tools: definitions.map(definition => definition.name),
    async run({ messages, signal, onEvent: emit = onEvent, requestApproval, permissionMode, effortLevel }) {
      // The SESSION owns the permission mode: the composer lets the user pick 自动 /
      // 手动 / 接受编辑 / 计划 / 跳过确认, and that choice is stored on the session
      // record. This runner used to ignore it and always use the process config, so a
      // session set to 自动 still prompted for every Write: measured, permissionMode
      // "auto" on the record while a Write raised an approval card. Auto applies edits
      // without asking (decide() says prompt:false), so the card should never appear.
      const effectiveMode = VALID_MODES.has(permissionMode) ? permissionMode : config.permissionMode;
      // `requestApproval` is supplied by the kernel for an in-app approval card. When
      // present it takes priority over the shell's `approve`, which is the native
      // modal path; without it the consent manager is still used, so a headless host
      // keeps working.
      const ask = typeof requestApproval === 'function'
        ? async (request) => {
          const decision = await requestApproval(request);
          if (decision === 'allow' || decision === 'deny' || decision === 'timeout') return decision;
          return 'cancel';
        }
        : approve;
      const execute = createApprovalExecutor({
        mode: effectiveMode,
        tools,
        ask,
        onEvent: emit,
      });
      // Rebuilt every run so a skill added in the UI applies to the next message.
      const dataDir = env.CLAUDE_WORKSPACE || process.cwd();
      const system = buildSystemPrompt(skillCatalogue(require('node:path').join(dataDir, '.data')));
      return await runAgent({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        // The session record carries the effort picker's value; without this the level
        // only changed a label. low/medium/high map to a thinking budget in agent.cjs.
        effort: effortLevel,
        system,
        messages,
        tools: definitions,
        execute,
        onEvent: emit,
        signal,
      });
    },
  };
}

module.exports = { DEFAULT_BASE_URL, resolveConfig, isConfigured, createAgentRunner, buildSystemPrompt, skillCatalogue, skillRoots };