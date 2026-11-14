'use strict';

// Mirrors the original control-plane host and delivery checks. Configuration
// provenance is supplied by the host, not inferred from the remote response.
function hasUrlCredentials(value) {
  const stripped = value.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
  const authority = (/^(?:https?|wss?):[/\\]*([^/?#]*)/i.exec(stripped) ?? /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(stripped))?.[1];
  if (authority !== undefined && /[@\\]/.test(authority)) return true;
  try { const url = new URL(value); return url.username !== '' || url.password !== ''; } catch { return false; }
}

function isControlPlaneUrl(value, { isPackaged = true, developmentUrl } = {}) {
  if (hasUrlCredentials(value)) return false;
  try {
    const host = new URL(value).host;
    if (new Set(['api.anthropic.com', 'api-staging.anthropic.com', 'api.claude.ai']).has(host)) return true;
    const dev = isPackaged ? undefined : developmentUrl?.trim() || undefined;
    return dev !== undefined && URL.canParse(dev) && new URL(dev).host === host;
  } catch { return false; }
}

function trustedBootstrapDelivery(url, { config, rawConfig, serverUrlDeviceDelivered, isPackaged = true, developmentUrl } = {}) {
  if (isControlPlaneUrl(url, { isPackaged, developmentUrl })) return true;
  if (config.bootstrap.url !== url) return false;
  return rawConfig.bootstrap?.trustBootstrapDelivery ?? serverUrlDeviceDelivered;
}

module.exports = { isControlPlaneUrl, trustedBootstrapDelivery };
