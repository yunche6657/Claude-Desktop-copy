// Synthetic 3p bootstrap.
//
// In third-party-gateway mode an original instance has no claude.ai account yet
// still paints the full Code surface. It does so by answering its own
// app://localhost/edge-api/bootstrap with a synthesised payload (observed:
// 64646 bytes, account.email_address "cowork-3p@localhost", a synthetic uuid,
// plus feature bags for statsig/growthbook and the model selector config).
//
// This module reproduces that payload from a template captured off a running
// original, so the frontend bootstraps without any network account. Values that
// are identity-bearing (uuid, localhost e-mail) are generated locally; the
// feature bags and model selector are taken from the captured template.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BOOTSTRAP_PATH = '/edge-api/bootstrap';

/**
 * Point the model selector at the model this build will actually call.
 *
 * The captured template advertises the full Claude catalogue (Fable/Opus/Sonnet). That is
 * correct for an original talking to Anthropic, and wrong for a build talking to a gateway
 * that serves other models: the composer picked claude-sonnet-5-5, the gateway had no such
 * model, and the Send button stayed disabled with no error anywhere. Observed with a relay
 * offering deepseek-v4-pro / glm-5.3 / gemini-3.5-flash.
 *
 * Prefer the configured inferenceModels catalogue, retaining an explicit selected model.
 * Discovery is a fallback for profiles without a model list. With neither a selected model
 * nor a catalogue, retain the captured template.
 */
function normalizeModelIds(models) {
  if (!Array.isArray(models)) return [];
  return [...new Set(models.map((row) => {
    if (typeof row === 'string') return row.trim();
    if (!row || typeof row !== 'object') return '';
    return [row.id, row.model, row.name].find((value) => typeof value === 'string' && value.trim())?.trim() || '';
  }).filter(Boolean))];
}

function withResolvedModel(payload, resolvedModel, extraModels, capabilityProfile = {}) {
  const catalogue = normalizeModelIds(extraModels);
  const model = (typeof resolvedModel === 'string' ? resolvedModel.trim() : '') || catalogue[0] || '';
  if (!model) return payload;

  // A gateway model id is not a Claude display name, so derive a readable label from the id
  // rather than claiming it is e.g. 'Sonnet 5.5'.
  const label = model;
  const profile = { ...(capabilityProfile.raw || capabilityProfile), inferenceModels: extraModels };
  const makeEntry = (id, name = id) => {
    const thinking = require('./model-capabilities.cjs').modelThinking(id, profile);
    return { id, name, description: 'Provided by the configured gateway', ...(thinking ? { thinking } : {}) };
  };
  const entry = makeEntry(model, label);

  // Every model the gateway serves, not just the current one.
  //
  // This used to replace the catalogue with `models: [entry]`, which is why the picker
  // offered exactly one choice while the gateway answered /v1/models with 15 ids
  // (deepseek-v4-pro, gpt-5.5, glm-5.3, kimi-k3, ...). The measured consequence:
  // `[trace] LocalSessions.setAvailableCodeModels [["deepseek-v4.1-flash"]]` — the
  // renderer could only ever push back the single model it had been given.
  //
  // `catalogue` is optional: without it the old single-entry behaviour is unchanged, so a
  // caller that cannot reach the gateway degrades honestly instead of inventing names.
  const entries = [entry];
  for (const id of catalogue) {
    if (id === model) continue;
    if (entries.some((row) => row.id === id)) continue;
    entries.push(makeEntry(id));
  }

  const sections = Array.isArray(payload.model_selector_config) ? payload.model_selector_config : [];
  const patched = sections.map((section) => {
    if (!section || typeof section !== 'object') return section;
    // Keep every non-model field (the section id drives which surface reads it); replace the
    // model list with the whole catalogue, current model first so the default stays selected.
    return { ...section, models: entries.map((row) => ({ ...row })) };
  });

  // The selector state names the current selection per section. Without this the picker would
  // show one option but still hold the old id, which is the exact mismatch being fixed.
  const state = Array.isArray(payload.model_selector_state) ? payload.model_selector_state : [];
  const patchedState = state.map((row) => (row && typeof row === 'object'
    ? { ...row, model: model }
    : row));

  return {
    ...payload,
    model_selector_config: patched.length ? patched : [{ id: 'code', models: entries.map((row) => ({ ...row })) }],
    model_selector_state: patchedState.length ? patchedState : [{ id: 'code', model }],
  };
}


/**
 * Which UI locale the bootstrap document advertises.
 *
 * The shipped frontend derives its boot locale from, in order: `spa:locale` in
 * localStorage, then `navigator.languages` narrowed to its catalog allowlist. The
 * account's `locale` in this document is a third source the app compares against
 * (`ty()` reads `locale_source`), and the settings language picker seeds from it.
 *
 * Measured on the real app (config.json, `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc`):
 *   "locale": "zh-Hans"
 * and its UI is Chinese. The catalogs for it are fetched from the web origin, not the
 * package, and this build vendors them (see i18n-overlay.cjs). So the honest value here
 * is the same tag the real app stores, and it is only advertised when the vendored
 * catalog is actually present -- otherwise the app would claim a language it cannot load.
 *
 * @param {string} [override] explicit locale (CLAUDE_APP_LOCALE)
 * @returns {string|null}
 */
function resolveAppLocale(override) {
  const explicit = typeof override === 'string' ? override.trim() : '';
  if (explicit) return explicit;
  try {
    const { resolveCatalogOverlay } = require('./i18n-overlay.cjs');
    const overlay = path.resolve(__dirname, '..', 'resources', 'i18n-overlay');
    if (resolveCatalogOverlay(overlay, '/i18n/zh-Hans.json')) return 'zh-Hans';
  } catch { /* no overlay -> no claim */ }
  return null;
}

/** Stable per-install synthetic identity, so sessions do not drift each launch. */
function syntheticIdentity(seed) {
  const uuid = crypto.createHash('sha256').update(String(seed)).digest('hex');
  const hex = uuid.slice(0, 32);
  return [
    hex.slice(0, 8), hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${(8 | (parseInt(hex[16], 16) & 3)).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * @param {{ templatePath?: string, seed?: string, email?: string, locale?: string }} opts
 * @returns {object} the bootstrap payload
 */
function buildBootstrap({ templatePath, seed = 'claude-desktop-reconstruction', email, locale, env = process.env, resolveGateway } = {}) {
  const uuid = syntheticIdentity(seed);

  // A captured template is the normal source: it carries the growthbook /
  // statsig feature bags and the model selector catalogue the frontend reads to
  // decide which surface and which tools exist. Without it the payload is
  // structurally valid but feature-empty, and the frontend cannot resolve a
  // surface. Fall back to the captured sample before giving up.
  const candidates = [templatePath, DEFAULT_TEMPLATE].filter(Boolean);
  let template = null;
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        template = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        break;
      }
    } catch { /* try the next candidate */ }
  }

  const base = template || {};
  // The account row renders `full_name || display_name || email_address`. The
  // captured template carries empty names (the machine it came from showed the
  // 3p principal instead), so a synthetic local name is supplied here. Without it
  // the sidebar row collapses to just its icon.
  const localUser = (() => {
    try { return require('node:os').userInfo().username; } catch { return ''; }
  })();
  const account = {
    ...(base.account || {}),
    tagged_id: `cowork_3p_${uuid}`,
    uuid,
    email_address: email || 'cowork-3p@localhost',
    full_name: localUser,
    display_name: localUser,
    is_verified: true,
    age_is_verified: true,
    memberships: (base.account && base.account.memberships) || [],
    settings: {
      paprika_mode: 'default',
      dismissed_claudeai_banners: [],
      enabled_wiggle_egress: false,
      enabled_wiggle_egress_hosts_template: '',
      enabled_geolocation: false,
      ...((base.account && base.account.settings) || {}),
    },
  };

  const gateway = (resolveGateway || require('./gateway-source.cjs').resolveGateway)(env);
  const capabilityProfile = require('./model-capabilities.cjs').currentCapabilityProfile(gateway);
  const configuredModels = capabilityProfile.inferenceModels || [];
  // Clear only defaults derived by the launcher; explicit environment overrides survive.
  env = { ...env };
  require('./startup-defaults.cjs').clearStartupDefaultsForRelaunch(env);
  resolveGateway = () => gateway;
  // The selector must offer the model this build can actually call (see withResolvedModel).
  const resolvedModel = (() => {
    try {
      // Use the same startup selection (including an explicitly matched runtime
      // model), but never mutate the caller environment while producing UI data.
      const selected = require('./startup-defaults.cjs').applyStartupDefaults({ ...env }, resolveGateway);
      return selected.CLAUDE_AGENT_MODEL || '';
    } catch { return ''; }
  })();

  return withResolvedModel({
    ...base,
    account,
    current_user_access: base.current_user_access || { features: [] },
    featureFlagsOrgUuid: base.featureFlagsOrgUuid || '00000000-0000-4000-8000-000000000000',
    // Was `base.locale ?? null` and the template carries null, so the app always fell back
    // to en-US even on a Chinese system. See resolveAppLocale.
    locale: base.locale ?? resolveAppLocale(locale),
    statsig: base.statsig || { user: { userID: uuid }, values: {}, values_hash: '' },
    feature_flags: base.feature_flags || { user: { userID: uuid }, values: {}, values_hash: '' },
    growthbook: base.growthbook || { features: {} },
    model_selector_config: base.model_selector_config || [],
    model_selector_state: base.model_selector_state || [],
    bootstrap_push_revision: base.bootstrap_push_revision ?? 1,
    intercom_account_hash: null,
    gated_imports: base.gated_imports || {},
    gated_imports_build_id: base.gated_imports_build_id || '',
    system_prompts: base.system_prompts || {},
  }, resolvedModel, configuredModels.length ? configuredModels : gatewayCatalogue(gateway), capabilityProfile);
}

// The gateway catalogue, shared with the bridge.
//
// Profiles without inferenceModels can use discovery warmed by bridge-services. The cache
// is scoped to the resolved provider so changing profiles cannot leak the previous list.
function gatewayCatalogue(gateway) {
  try {
    const bridge = require('./bridge-services.cjs');
    if (bridge && typeof bridge.knownGatewayModels === 'function') {
      const list = bridge.knownGatewayModels(gateway);
      if (Array.isArray(list)) return list;
    }
  } catch { /* the bridge may not be constructed yet */ }
  return [];
}

/** True when this request is the bootstrap document. */
function isBootstrapRequest(url) {
  try {
    const u = new URL(String(url));
    return u.pathname === BOOTSTRAP_PATH || u.pathname === '/api/bootstrap';
  } catch {
    return false;
  }
}

/**
 * Create the local bootstrap responder.
 * @param {{ templatePath?: string, seed?: string, locale?: string }} opts
 */
function createBootstrapResponder(opts = {}) {
  return {
    /** @returns {Response} */
    respond() {
      const body = JSON.stringify(buildBootstrap(opts));
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    },
    /** The payload, for inspection and tests. */
    payload() { return buildBootstrap(opts); },
  };
}

const DEFAULT_TEMPLATE = path.resolve(__dirname, '..', 'resources', 'bootstrap-3p.json');

module.exports = {
  BOOTSTRAP_PATH,
  DEFAULT_TEMPLATE,
  syntheticIdentity,
  resolveAppLocale,
  buildBootstrap,
  isBootstrapRequest,
  createBootstrapResponder,
  withResolvedModel,
  normalizeModelIds,
};
