// Local answers for backend API paths.
//
// The shipped protocol handler intercepts a few paths before forwarding:
//
//   let r = n.startsWith("/edge-api/") ? `/api/${n.slice(10)}` : n,
//       i = Jgn(e, r, t.search);        // local interception
//   if (i) return i;
//   ... a.net.fetch(backendUrl, ...)
//
// This build has no backend at all (it runs against an inference gateway), so
// every /api/* request answered 503 and the frontend treated the app as offline.
// The visible symptom was the account Overview page stuck on "Loading Overview":
// `/api/account_profile` is the profile query, it 503'd, and the page renders only
// after that query settles.
//
// Everything answered here is derived from the bootstrap document the app already
// serves locally, so there is no invented data: the account record in the
// bootstrap is the same one the UI shows in the sidebar.
//
// Settings writes are the one place that has to store something new. The shipped
// client writes account-scoped settings with
//
//   PATCH /api/account/settings   { <field>: <value>, ... }
//
// and reads them back from `account.settings[field]`. Without a backend that PATCH
// 503'd, so every account-scoped control in Settings (Default transcript view,
// etc.) silently reverted. The overlay below is applied on top of the bootstrap
// settings and persisted by the caller, so a write survives a restart.
'use strict';

/**
 * Build the interceptor.
 * @param {{
 *   bootstrap?: () => object|null,
 *   readSettings?: () => object,        // persisted overrides, merged over bootstrap
 *   writeSettings?: (patch: object) => object,  // persists and returns the merged bag
 *   acceptLocaleWrites?: boolean,      // answer the language picker's PUT (see below)
 * }} opts
 * @returns {(request: Request, pathname: string) => Response|null}
 */
function createApiInterceptors({ bootstrap, readSettings, writeSettings, acceptLocaleWrites = false } = {}) {
  const readBootstrap = () => {
    if (typeof bootstrap !== 'function') return null;
    try { return bootstrap(); } catch { return null; }
  };

  /** Bootstrap settings with the persisted overrides layered on top. */
  const effectiveSettings = () => {
    const boot = readBootstrap();
    const base = (boot && boot.account && boot.account.settings) || {};
    let overrides = {};
    if (typeof readSettings === 'function') {
      try { overrides = readSettings() || {}; } catch { overrides = {}; }
    }
    return { ...base, ...(overrides && typeof overrides === 'object' ? overrides : {}) };
  };

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

  /**
   * `/api/account_profile` answers the profile object. Its consumers read
   * `cowork_instructions_union`, `conversation_preferences`, `avatar_image_url`
   * and the account identity fields; the bootstrap carries the account already.
   */
  const accountProfile = () => {
    const boot = readBootstrap();
    const account = boot && boot.account ? boot.account : null;
    if (!account) return null;
    const settings = effectiveSettings();
    return json({
      // Identity, mirroring the bootstrap account record.
      uuid: account.uuid,
      email_address: account.email_address,
      full_name: account.full_name ?? '',
      display_name: account.display_name ?? '',
      tagged_id: account.tagged_id ?? null,
      created_at: account.created_at ?? null,
      updated_at: account.updated_at ?? null,
      is_verified: account.is_verified === true,
      age_is_verified: account.age_is_verified === true,
      memberships: Array.isArray(account.memberships) ? account.memberships : [],
      workspace_memberships: Array.isArray(account.workspace_memberships) ? account.workspace_memberships : [],
      // Profile fields the personalization pane reads.
      avatar_image_url: settings.avatar_image_url ?? null,
      display_avatar: settings.display_avatar ?? null,
      // `conversation_preferences` is the user's free-text custom instructions, NOT
      // an object. The Settings pane puts it straight into a textarea and computes
      // its text direction with
      //
      //   dir: we(value, 80)      // for (const ch of value) { ch.codePointAt(0) ... }
      //
      // so an object here throws `TypeError: e is not iterable` while rendering and
      // takes the WHOLE settings route into the error boundary ("This page ran into
      // a problem"). Answering `{}` looked harmless and crashed every settings page.
      conversation_preferences: typeof settings.conversation_preferences === 'string'
        ? settings.conversation_preferences
        : '',
      // The cap the textarea shows its size warning against; null means unbounded.
      conversation_preferences_cloud_max_chars:
        Number.isFinite(settings.conversation_preferences_cloud_max_chars)
          ? settings.conversation_preferences_cloud_max_chars
          : null,
      // `gq()` treats anything other than `true` as "union is off", which is the
      // safe default for a profile that never enabled it.
      cowork_instructions_union: settings.cowork_instructions_union === true,
      cowork_global_instructions: settings.cowork_global_instructions ?? null,
      // The bootstrap's own settings bag, so nothing the UI shows is invented.
      settings,
    });
  };

  /**
   * `PATCH /api/account/settings` writes account-scoped settings.
   *
   * The client's own mutation optimistically merges the patch into its cached
   * account and rolls back on error, so a success here is what makes the control
   * stick. The reply is the updated profile — the same shape the client already
   * holds — which is what its onSuccess handler expects to reconcile against.
   */
  const writeAccountSettings = async (request) => {
    let patch = null;
    try { patch = await request.json(); } catch { patch = null; }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return json({ error: 'invalid_settings_patch' }, 400);
    }
    // Only persist through the caller; the bootstrap document itself is read-only.
    if (typeof writeSettings !== 'function') {
      return json({ error: 'settings_not_writable' }, 501);
    }
    let merged;
    try { merged = writeSettings(patch); } catch (error) {
      return json({ error: 'settings_write_failed', detail: String(error && error.message) }, 500);
    }
    const boot = readBootstrap();
    const account = boot && boot.account ? boot.account : null;
    return json({
      uuid: account ? account.uuid : null,
      settings: merged && typeof merged === 'object' ? merged : effectiveSettings(),
    });
  };

  /**
   * `PUT /api/account_profile` with `{ locale }` — the language picker's write.
   *
   * Opt-in via `acceptLocaleWrites`: the same path also carries general profile writes
   * (avatar, custom instructions) that this build genuinely cannot honour, and those must
   * keep falling through to the forwarder instead of being answered with a stale profile.
   * Only a caller that persists the value (main.cjs, via account-settings.json) enables it.
   *
   * Returns the account record the client reconciles against. Only `locale` is
   * accepted: this endpoint is the account PATCH, and accepting arbitrary fields would
   * let a client rewrite identity fields the bootstrap owns.
   */
  const writeAccountLocale = async (request) => {
    let patch = null;
    try { patch = await request.json(); } catch { patch = null; }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return json({ error: 'invalid_account_patch' }, 400);
    }
    const locale = typeof patch.locale === 'string' ? patch.locale.trim() : '';
    if (!locale || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) {
      return json({ error: 'invalid_locale' }, 400);
    }
    if (typeof writeSettings !== 'function') {
      return json({ error: 'settings_not_writable' }, 501);
    }
    try { writeSettings({ locale }); } catch (error) {
      return json({ error: 'settings_write_failed', detail: String(error && error.message) }, 500);
    }
    const boot = readBootstrap();
    const account = boot && boot.account ? boot.account : null;
    return json({
      uuid: account ? account.uuid : null,
      email_address: account ? account.email_address : null,
      full_name: account ? account.full_name ?? '' : '',
      display_name: account ? account.display_name ?? '' : '',
      locale,
      settings: effectiveSettings(),
    });
  };

  /**
   * `/api/organizations/<uuid>/notification/preferences`.
   *
   * The Settings > Notifications pane queries this on every mount. With no backend
   * it 503'd, the query threw, and the whole pane reported a query error.
   *
   * The consumer reads `effective_preferences`, `push_reachability` and
   * `admin_spend_alerts_available` and merges them over what it holds, so an empty
   * but well-formed record is honest here: this build delivers no notifications, so
   * every channel is off rather than pretending to be on.
   */
  // What the user toggled, so a GET reflects the PATCH that preceded it.
  //
  // Measured before this persisted: toggling 回复完成 flipped the switch to true, a page
  // reload kept it true, and a full process restart put it back to false. The switch was
  // written into this in-memory object and nothing else, so the user's choice survived
  // exactly as long as the process did — the same silent loss the IndexedDB fix addressed,
  // in a different store.
  //
  // The store is the account settings file (the one readAccountSettings/writeAccountSettings
  // already own), because it is the only writable preference store this process has.
  const NOTIFICATION_KEY = 'notification_preferences';
  const readNotificationOverrides = () => {
    if (typeof readSettings !== 'function') return {};
    try {
      const stored = readSettings();
      const value = stored && stored[NOTIFICATION_KEY];
      return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
    } catch { return {}; }
  };
  let notificationOverrides = readNotificationOverrides();
  const saveNotificationOverrides = () => {
    if (typeof writeSettings !== 'function') return;
    try {
      const stored = (typeof readSettings === 'function' ? readSettings() : null) || {};
      writeSettings({ ...stored, [NOTIFICATION_KEY]: notificationOverrides });
    } catch { /* a read-only store must not break the toggle */ }
  };

  const notificationPreferences = () => json({
    preferences: {
      feature_preference: notificationOverrides,
      enable_push: false,
      push_source: 'explicit',
    },
    effective_preferences: { ...notificationOverrides },
    push_reachability: {
      most_recent_token_refresh: null,
      has_active_channel: false,
      platforms: [],
    },
    admin_spend_alerts_available: false,
  });

  /**
   * `PATCH /api/organizations/<uuid>/notification/preferences`.
   *
   * This is how the Settings notification toggles are saved:
   *
   *   PATCH { preferences: { feature_preference: { routines: { enable_push: true } } } }
   *
   * A GET-only interceptor left every toggle unable to persist — it moved and
   * snapped back, which reads as "the switch is broken". The patch is merged and
   * echoed back so the client's optimistic update reconciles.
   */
  const patchNotificationPreferences = async (request) => {
    let body = null;
    try { body = await request.json(); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'invalid_preferences_patch' }, 400);
    }
    const incoming = body.preferences && body.preferences.feature_preference;
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      // Merge per feature key so toggling one does not clear the others.
      for (const [feature, value] of Object.entries(incoming)) {
        const prior = notificationOverrides[feature];
        notificationOverrides[feature] = (prior && typeof prior === 'object' && value && typeof value === 'object')
          ? { ...prior, ...value }
          : value;
      }
      saveNotificationOverrides();
    }
    return json({      preferences: {
        feature_preference: notificationOverrides,
        enable_push: false,
        push_source: 'explicit',
      },
      effective_preferences: { ...notificationOverrides },
      push_reachability: {
        most_recent_token_refresh: null,
        has_active_channel: false,
        platforms: [],
      },
      admin_spend_alerts_available: false,
    });
  };

  /**
   * Telemetry endpoints. The app posts these continuously; a 503 makes the client
   * retry with backoff, which is pure noise in a build that has no collector.
   * Answering 200 with an empty body is the shape a collector returns on accept.
   */
  const telemetry = () => new Response(null, { status: 200 });

  return function intercept(request, pathname) {
    const method = (request.method || 'GET').toUpperCase();
    const route = String(pathname || '');

    // Strip the /edge-api prefix so the same table serves both spellings.
    const path = route.startsWith('/edge-api/') ? `/api/${route.slice(10)}` : route;

    if (path === '/api/account_profile' && method === 'GET') {
      return accountProfile();
    }
    if (path === '/api/account/settings' && method === 'PATCH') {
      return writeAccountSettings(request);
    }
    // The language picker (Settings > General > Language) writes its choice with
    //   PUT /api/account_profile   { locale }
    // — verified in resources/ion-dist/assets/v1/shared-25-DOWZRSlq.js, where the
    // picker's mutation is `Tn("/api/account_profile","PUT",...)` and the picker calls it
    // as `mutateAsync({ locale })`. Answering that PUT is what makes the choice stick;
    // main.cjs then advertises it in the bootstrap document, which seeds the boot locale
    // on the next launch.
    if (path === '/api/account_profile' && method === 'PUT' && acceptLocaleWrites) {
      return writeAccountLocale(request);
    }
    // Per-organization notification preferences. The organization id varies, so this
    // matches on the suffix rather than an exact path. GET reads; PATCH is how the
    // Settings toggles persist.
    if (/^\/api\/organizations\/[^/]+\/notification\/preferences$/.test(path)) {
      if (method === 'GET') return notificationPreferences();
      if (method === 'PATCH') return patchNotificationPreferences(request);
    }
    // RUM and event logging: accept and drop.
    if (path === '/api/v2/rum' || path.startsWith('/api/event_logging/')) {
      return telemetry();
    }
    return null;
  };
}

module.exports = { createApiInterceptors };
