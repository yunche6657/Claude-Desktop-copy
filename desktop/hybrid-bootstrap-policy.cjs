'use strict';
// Narrow aLe URL policy. Metadata and channel are supplied by the caller;
// field schemas, flattening and consent are deliberately outside this module.
const LOOPBACK_EXCEPTIONS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function loopback(hostname) {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (ipv4) return ipv4[1] === '127' || ipv4[1] === '0';
  if (host.startsWith('[') && host.endsWith(']')) {
    const ip = host.slice(1, -1);
    if (ip === '::1' || ip === '::') return true;
    const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (mapped) { const first = parseInt(mapped[1], 16) >> 8; return first === 127 || first === 0; }
  }
  return false;
}
function unsafeUrl(value) { try { const url = new URL(value); return url.protocol !== 'https:' || loopback(url.hostname); } catch { return true; } }
function exceptionUrl(value) { try { return LOOPBACK_EXCEPTIONS.has(new URL(value).hostname); } catch { return false; } }
function urls(value) {
  const one = x => x && typeof x === 'object' && typeof x.url === 'string' ? [x.url] : [];
  return typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(x => typeof x === 'string' ? [x] : one(x)) : one(value);
}
function applyBootstrapUrlPolicy(input, { metadata = {}, channel = 'bootstrap', trustedOrigin, allowLoopbackResponseUrls = false, isBuiltinMcp = () => false, oauthUrls = () => [] } = {}) {
  const config = { ...input }, rejected = [], errors = [], stoodIn = [];
  if (channel === 'local' || channel === 'mdm') return { config, rejected, errors, stoodIn };
  const failClosed = (key, definition) => { if (Object.hasOwn(definition, 'failClosedValue')) { config[key] = definition.failClosedValue; stoodIn.push(key); } else delete config[key]; };
  for (const [key, definition] of Object.entries(metadata)) {
    const value = config[key], policy = definition.remotePolicy;
    if (value === undefined || !policy) continue;
    if (policy.hybrid?.scope === 'only' && channel !== 'hybrid') { delete config[key]; errors.push({key, kind:'hybrid-only'}); continue; }
    const allow = allowLoopbackResponseUrls || channel === 'hybrid' && policy.hybrid?.loopback === true;
    if (policy.rejectLoopback && urls(value).some(url => unsafeUrl(url) && !(allow && exceptionUrl(url)))) {
      failClosed(key, definition); errors.push({key, kind:'unsafe-url'}); continue;
    }
    if (policy.originPinned && trustedOrigin !== undefined && typeof value === 'string') {
      let matches = false; try { matches = new URL(value).origin === trustedOrigin; } catch {}
      if (!matches) { delete config[key]; rejected.push(key); errors.push({key, kind:'origin'}); continue; }
    }
    if (policy.mcpUrlHygiene && Array.isArray(value)) {
      const kept = value.filter(item => {
        const builtin = isBuiltinMcp(item), target = builtin ? item.customUrl : item.transport === 'stdio' ? undefined : item.url;
        return !(target !== undefined && unsafeUrl(target)) && !(!builtin && item.transport !== 'stdio' && oauthUrls(item.oauth).some(unsafeUrl));
      });
      if (kept.length !== value.length) { errors.push({key,kind:'mcp-url'}); if (!kept.length) { if (Object.hasOwn(definition, 'failClosedValue')) { config[key] = definition.failClosedValue; stoodIn.push(key); } } else config[key] = kept; }
    }
    if (policy.marketplaceUrlHygiene && Array.isArray(value)) {
      const kept = value.filter(item => item && typeof item === 'object' && !(typeof item.url === 'string' && unsafeUrl(item.url)));
      if (value.some(item => item && typeof item === 'object' && typeof item.url === 'string' && unsafeUrl(item.url))) errors.push({key,kind:'marketplace-url'});
      config[key] = kept;
    }
  }
  return {config,rejected,errors,stoodIn};
}
module.exports = { applyBootstrapUrlPolicy, unsafeUrl, loopback };
