'use strict';
const { createGrowthBookSource } = require('./growthbook-source.cjs');
const { hardcodedMainGrowthBookFeatures, growthBookRemoteAllowedKeys } = require('./growthbook-3p-policy.cjs');
const HOSTS = new Set(['api.anthropic.com', 'api-staging.anthropic.com', 'api.claude.ai']);

// Ol/kl from the shipped backend. The unpackaged development override is an
// injected host dependency; no new user environment variable is introduced.
function nativeAuthority(e) {
  let t=e.replace(/[\t\n\r]/g,""),n=0,r=t.length;
  for(;n<r&&t.charCodeAt(n)<=32;)n++;
  for(;r>n&&t.charCodeAt(r-1)<=32;)r--;
  const i=t.slice(n,r);
  return (/^(?:https?|wss?):[/\\]*([^/?#]*)/i.exec(i)??/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(i))?.[1];
}
function hybridEnabled(bootstrap, { packaged = true, developmentOrigin } = {}) {
  if (!bootstrap?.url || bootstrap.enabled === false) return false;
  try {
    const text = bootstrap.url;
    const authority = nativeAuthority(text) || '';
    const url = new URL(text);
    if (authority.includes('@') || authority.includes('\\') || url.username || url.password) return false;
    return HOSTS.has(url.host) || (!packaged && !!developmentOrigin && url.host === new URL(developmentOrigin).host);
  } catch { return false; }
}

function createGrowthBookModeBackend({ getConfig, netFetch, hybridAuthedFetch,
  appVersion, totalMemoryBytes, whenReady, packaged = true, developmentOrigin,
  consumerOrigin = 'https://claude.ai' }) {
  function getContext() {
    const config = getConfig();
    const { mode, bootstrap, builtinBrowserEnabled = false, selfHostedSessions = false } = config;
    const common = { appVersion, totalMemoryBytes, whenReady };
    if (mode === '1p') return { mode, source: createGrowthBookSource({ ...common,
      kind: 'remote', origin: consumerOrigin, netFetch }) };
    const features = mode === '3p' ? hardcodedMainGrowthBookFeatures({ builtinBrowserEnabled, selfHostedSessions }) : {};
    if (mode !== '3p' || !hybridEnabled(bootstrap, { packaged, developmentOrigin })) {
      return { mode, source: { kind: 'static', identity: `${mode}:${builtinBrowserEnabled}:${selfHostedSessions}`, features, remoteAllowedKeys: growthBookRemoteAllowedKeys() } };
    }
    const origin = new URL(bootstrap.url).origin;
    // A missing OIDC backend must not fall through to consumer net.fetch, or
    // reuse credentials from the inference provider or Code account store.
    return { mode, source: createGrowthBookSource({ ...common, kind: 'remote', origin,
      identity: JSON.stringify([bootstrap.url, builtinBrowserEnabled, selfHostedSessions]), authedFetch: hybridAuthedFetch
        ? (url, headers) => hybridAuthedFetch(bootstrap.url, url, headers)
        : async () => null,
      hardcodedFeatures: features, remoteAllowedKeys: growthBookRemoteAllowedKeys(),
      previouslyAuthed: config.previouslyAuthed === true }) };
  }
  return { getContext };
}
module.exports = { createGrowthBookModeBackend, hybridEnabled };
