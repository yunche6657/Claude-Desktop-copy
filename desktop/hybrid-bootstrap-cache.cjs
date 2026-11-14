'use strict';
// ytn/vtn/gtn: fetch cache and last-served record are separate. The host owns
// credential-generation capture, trusted-delivery calculation and transport.
function createHybridBootstrapCache({ getConfig, fetchBootstrap, captureCredentialGeneration, trustedDelivery, now = Date.now }) {
  for (const fn of [getConfig, fetchBootstrap, captureCredentialGeneration, trustedDelivery, now]) {
    if (typeof fn !== 'function') throw new TypeError('bootstrap cache dependencies required');
  }
  let fetched = null, lastServed;
  const clearFetchCache = () => { fetched = null; };
  const setLastServed = value => { lastServed = value; };
  const getLastServed = () => lastServed;
  async function resolve(options) {
    const config = getConfig(), url = config.bootstrap.url;
    if (!url || !config.bootstrap.enabled) return { ok: false, kind: 'unconfigured' };
    const startedAt = now();
    if (!options?.bypassCache && fetched && (options?.preferCache || fetched.expiresAt > startedAt) && fetched.value.sourceUrl === url) return fetched.value;
    const stale = captureCredentialGeneration(), trusted = trustedDelivery(url);
    const previous = lastServed?.sourceUrl === url ? lastServed : undefined;
    const result = await fetchBootstrap(url, config.bootstrap.oidc, startedAt, previous, trusted, options?.background);
    if (result.ok && !stale()) {
      const expires = result.value.expiresAt;
      fetched = { value: result, expiresAt: expires ? (expires < 1e12 ? expires * 1000 : expires) : startedAt + 3600000 };
    }
    return result;
  }
  return { resolve, clearFetchCache, setLastServed, getLastServed };
}
module.exports = { createHybridBootstrapCache };
