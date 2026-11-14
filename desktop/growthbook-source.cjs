'use strict';

const FEATURE_PATH = '/api/desktop/features';
const REQUEST_TIMEOUT_MS = 30000;

// Cv in the shipped main bundle. Values are supplied by the host, not inferred
// from an inference gateway or from the renderer bootstrap.
function growthBookHeaders({ appVersion, totalMemoryBytes }) {
  if (typeof appVersion !== 'string' || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes < 0) {
    throw new TypeError('appVersion and totalMemoryBytes are required');
  }
  const deviceClass = totalMemoryBytes < 6e9 ? 'le4' : totalMemoryBytes < 12e9 ? '8' : totalMemoryBytes < 2e10 ? '16' : 'gt16';
  return {
    'anthropic-client-platform': 'desktop_app',
    'anthropic-client-app': 'com.anthropic.claudefordesktop',
    'anthropic-client-version': appVersion,
    'anthropic-client-device-class': deviceClass,
    'anthropic-client-total-memory-gb': String(Math.round(totalMemoryBytes / 1024 ** 3)),
  };
}

// The backend owns authenticated transport, including token refresh, headers,
// no-store and its 30-second fetch timeout. Returning null means no bearer.
// Provider consumes the returned Response; it validates features and refuses
// anonymous hybrid responses before applying or caching them.
function createGrowthBookSource(options) {
  if (!options || typeof options !== 'object') throw new TypeError('source options required');
  const { kind, features, origin, netFetch, authedFetch, appVersion, totalMemoryBytes, whenReady = async () => {}, identity } = options;
  if (kind === 'static') return { kind: 'static', features };
  if (kind !== 'remote') throw new TypeError('unknown source kind');
  if (typeof origin !== 'string') throw new TypeError('origin required');
  if (authedFetch != null && typeof authedFetch !== 'function') throw new TypeError('authedFetch must be a function');
  if (authedFetch == null && typeof netFetch !== 'function') throw new TypeError('netFetch required for consumer source');
  if (typeof whenReady !== 'function') throw new TypeError('whenReady must be a function');
  const url = new URL(FEATURE_PATH, origin).toString();
  // Validate metadata before initialization instead of silently fabricating it.
  growthBookHeaders({ appVersion, totalMemoryBytes });
  return {
    ...Object.fromEntries(['hardcodedFeatures', 'remoteAllowedKeys', 'previouslyAuthed'].filter(key => key in options).map(key => [key, options[key]])),
    kind: 'remote', origin, identity: identity ?? origin,
    hybrid: authedFetch != null,
    fetch: async () => {
      await whenReady();
      const headers = growthBookHeaders({ appVersion, totalMemoryBytes });
      return authedFetch != null
        ? authedFetch(url, headers)
        : netFetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    },
  };
}
module.exports = { createGrowthBookSource, growthBookHeaders, FEATURE_PATH, REQUEST_TIMEOUT_MS };
