'use strict';

// Injectable subset of resolveBootstrapOverlay. The host supplies the real
// fetch cache, validation, consent UI and guarded commit operations.
function createHybridBootstrapCandidate({ fetchCandidate, validateCandidate, checkConsent, loadConsent,
  applyCandidate, validateApplied, cacheCandidate, clearFetchCache = () => {} }) {
  for (const fn of [fetchCandidate, validateCandidate, applyCandidate, validateApplied, cacheCandidate, clearFetchCache]) {
    if (typeof fn !== 'function') throw new TypeError('bootstrap candidate dependencies required');
  }
  if (loadConsent === undefined) {
    if (typeof checkConsent !== 'function') throw new TypeError('checkConsent or loadConsent required');
    loadConsent = async () => checkConsent;
  }
  if (typeof loadConsent !== 'function') throw new TypeError('loadConsent must be a function');
  let generation = 0, appliedGeneration = 0, invalidatedThrough = 0;
  function invalidate() { invalidatedThrough = ++generation; }
  const current = token => token > invalidatedThrough && token >= appliedGeneration;
  async function resolve(options = {}) {
    const token = ++generation, isCurrent = () => current(token);
    const candidate = await fetchCandidate(options);
    if (!isCurrent()) { if (candidate?.ok) clearFetchCache(); return { kind: 'stale' }; }
    if (!candidate?.ok) {
      if (candidate?.kind === 'unconfigured' || candidate?.kind === 'auth' ||
          (candidate?.kind === 'parse' && candidate.status !== undefined) ||
          (candidate?.kind === 'http' && (candidate.status === 404 || candidate.status === 410) && candidate.hybrid === true)) {
        appliedGeneration = token;
      }
      return { kind: 'fetch-error', result: candidate };
    }
    const valid = await validateCandidate(candidate, { isCurrent });
    if (!isCurrent()) { clearFetchCache(); return { kind: 'stale' }; }
    if (!valid) return { kind: 'invalid' };
    const consentFn = await loadConsent();
    // Native advances after its dynamic import and does not re-check the
    // applied generation at this point. Explicit host invalidation still wins.
    if (token <= invalidatedThrough) return { kind: 'stale' };
    appliedGeneration = token;
    const consent = await consentFn(candidate.value, { isCurrent, trustedDelivery: candidate.trustedDelivery, userAction: options.gesture === true });
    if (consent?.status === 'pending') {
      if (typeof consent.prompt !== 'function') throw new TypeError('pending consent requires prompt');
      consent.prompt(() => { void resolve({ preferCache: true }).catch(() => {}); });
      return { kind: 'pending' };
    }
    if (consent?.status !== 'consented') return { kind: 'refused' };
    // Mutators must recheck isCurrent at their own final commit boundary.
    await applyCandidate(candidate, { isCurrent });
    if (!isCurrent()) return { kind: 'stale' };
    let appliedValid;
    try { appliedValid = await validateApplied(candidate, { isCurrent }); }
    catch (error) { return isCurrent() ? { kind: 'applied-invalid', error } : { kind: 'stale' }; }
    if (!isCurrent()) return { kind: 'stale' };
    if (!appliedValid) return { kind: 'applied-invalid' };
    await cacheCandidate(candidate, { isCurrent });
    return isCurrent() ? { kind: 'applied' } : { kind: 'stale' };
  }
  return { resolve, invalidate };
}
module.exports = { createHybridBootstrapCandidate };
