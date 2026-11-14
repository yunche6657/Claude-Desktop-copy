'use strict';
const { gzip, gunzip } = require('node:zlib');
const { promisify } = require('node:util');
const compress = promisify(gzip), decompress = promisify(gunzip);
const MAGIC = Buffer.from([67, 76, 70, 2, 0, 154, 183, 226]);
const DAY = 86400000;
const validFeatures = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.values(value).every(v => v !== null && typeof v === 'object' && !Array.isArray(v));

async function encodeFeatureCache({ timestamp, mode, orgUuid, features }) {
  return Buffer.concat([MAGIC, await compress(JSON.stringify({ timestamp, mode, orgUuid, features }))]);
}
async function decodeFeatureCache(buffer, { now = Date.now(), mode, orgUuid, restricted = false }) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length <= MAGIC.length || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const data = JSON.parse((await decompress(buffer.subarray(MAGIC.length))).toString('utf8'));
    if (now - data.timestamp > DAY || data.mode !== mode ||
      (restricted && (orgUuid == null || data.orgUuid !== orgUuid))) return null;
    Object.keys(data.features);
    return data.features;
  } catch { return null; }
}
function sameFeature(a, b) {
  return !!a && a.on === b.on && JSON.stringify(a.value) === JSON.stringify(b.value) &&
    a.experimentResult?.variationId === b.experimentResult?.variationId &&
    a.experimentResult?.inExperiment === b.experimentResult?.inExperiment && a.experiment?.key === b.experiment?.key;
}
function project(features, source) {
  const fixed = source.hardcodedFeatures ?? (source.kind === 'static' ? source.features : null);
  if (fixed == null) return { ...features };
  const selected = {};
  for (const key of source.remoteAllowedKeys ?? []) if (key in features) selected[key] = features[key];
  return { ...selected, ...fixed };
}
function createGrowthBookProvider({ getContext, cache = {}, now = Date.now, monotonicNow = () => performance.now(), random = Math.random,
  setTimer = setTimeout, clearTimer = clearTimeout, onExposure, queueExperimentExposure } = {}) {
  if (typeof getContext !== 'function') throw new TypeError('getContext is required');
  let features = {}, state = 'none', disposed = false, generation = 0, identity, pending, timer, initialized = false;
  let initPromise, accountPromise, staleAccount = false, lastNetworkMono, lastNetworkWall;
  let lastRefresh, lastOutcome = 'success', writeChain = Promise.resolve();
  const legacyListeners = new Map(), changeListeners = new Map(), gateListeners = new Map();
  const freshListeners = new Set(), networkListeners = new Set(), deferredExposure = new Set();
  const securityListeners = new Set();
  let securityIdentity, securityEligible = false, lastSecurity = false, securityEpoch = 0, securityStaticVerified = false;
  const seenFeatureExposure = new Set(), seenExperimentExposure = new Set();
  let lastAccount;
  const keyFor = c => JSON.stringify([c.mode, c.accountKey ?? null, c.orgUuid ?? null, !!c.restricted, c.source?.kind, c.source?.identity ?? null]);
  const loaded = () => state !== 'none' && state !== 'map-fallback';
  const fresh = () => (state === 'network' || state === 'map-final') && !staleAccount;
  const emitSet = (set, ...args) => { for (const fn of [...(set ?? [])]) { try { fn(...args); } catch {} } };
  // This security signal is scoped to CLI MCP gate 513873720. A verified
  // static gate does not authenticate other retained remote features.
  const securityFresh = () => !disposed && securityEligible && securityIdentity !== undefined && securityIdentity === identity && (fresh() || securityStaticVerified);
  function notifySecurity() {
    const next = securityFresh();
    if (next === lastSecurity) return;
    lastSecurity = next;
    emitSet(securityListeners, next);
  }
  function invalidateSecurityFreshness() {
    securityEpoch++;
    securityIdentity = undefined;
    securityStaticVerified = false;
    notifySecurity();
  }
  function exposure(key, item) {
    if (!fresh()) { if (item !== undefined && state !== 'map-fallback') deferredExposure.add(key); return; }
    if (item === undefined) return;
    const signature = `${key}:${item.on}:${item.source}`;
    if (!seenFeatureExposure.has(signature)) {
      seenFeatureExposure.add(signature);
      try { onExposure?.({ feature_hash:key, on:item.on, feature_source:item.source, in_experiment:item.experimentResult?.inExperiment === true }); } catch {}
    }
    const experiment = item.experiment?.key, variation = item.experimentResult?.variationId;
    if (item.experimentResult?.inExperiment !== true || typeof experiment !== 'string' || typeof variation !== 'number') return;
    const id = `${experiment}:${variation}`;
    if (seenExperimentExposure.has(id)) return;
    seenExperimentExposure.add(id);
    if (typeof queueExperimentExposure === 'function') {
      Promise.resolve().then(() => queueExperimentExposure({ experiment_id:experiment, variation_id:variation, timestamp:new Date(now()).toISOString() }))
        .catch(() => seenExperimentExposure.delete(id));
    }
  }
  function freshTransition(wasFresh) {
    if (wasFresh || !fresh()) return;
    emitSet(freshListeners);
    const keys = new Set([...deferredExposure, ...changeListeners.keys()]);
    deferredExposure.clear();
    for (const key of keys) exposure(key, features[key]);
  }
  function apply(map, kind, source, {reprojection = false, securityToken = securityEpoch} = {}) {
    const rank = { none:0, 'map-fallback':1, 'map-final':1, disk:2, network:3 };
    if (rank[kind] < rank[state]) return;
    const applyGeneration = generation, applyIdentity = identity;
    const wasFresh = fresh();
    if (!reprojection && (kind === 'network' || kind === 'map-final')) staleAccount = false;
    if (!reprojection && kind === 'network') { lastNetworkMono = monotonicNow(); lastNetworkWall = now(); }
    const old = features; features = project(map, source); state = kind;
    for (const [key, value] of Object.entries(features)) if (!sameFeature(old[key], value)) {
      emitSet(legacyListeners.get(key), value);
      for (const fn of [...(changeListeners.get(key) ?? [])]) { exposure(key, value); try { fn(value); } catch {} }
      emitSet(gateListeners.get(key), value);
    }
    for (const key of Object.keys(old)) if (!Object.hasOwn(features, key)) {
      emitSet(legacyListeners.get(key), undefined); emitSet(gateListeners.get(key), undefined);
    }
    for (const [key, set] of changeListeners) if (!Object.hasOwn(features,key) && !Object.hasOwn(old,key)) emitSet(set, undefined);
    if (!reprojection) freshTransition(wasFresh);
    if (!reprojection && kind === 'network') emitSet(networkListeners);
    if (!reprojection && (kind === 'network' || kind === 'map-final')) {
      try { if (securityToken === securityEpoch && generation === applyGeneration && identity === applyIdentity && current(applyGeneration)) { securityIdentity = applyIdentity; securityStaticVerified = false; } }
      catch { /* no verified context for the security consumer */ }
    }
    notifySecurity();
  }
  function synchronize({markStale = true} = {}) {
    const c = getContext();
    if (!c?.source || !['static', 'remote'].includes(c.source.kind)) throw new TypeError('valid source is required');
    const key = keyFor(c);
    if (identity !== key) {
      if (markStale && identity !== undefined && c.source.kind === 'remote') { staleAccount = true; lastNetworkMono = undefined; lastNetworkWall = undefined; }
      securityIdentity = undefined;
      securityStaticVerified = false;
      securityEpoch++;
      identity = key; generation++; lastRefresh = undefined;
      // The consumer 1p identity is unavailable in the current main backend.
      securityEligible = c.mode !== '1p' || (typeof c.accountKey === 'string' && c.accountKey.length > 0 &&
        typeof c.orgUuid === 'string' && c.orgUuid.length > 0);
      notifySecurity();
    }
    return { context: c, generation };
  }
  const current = token => !disposed && generation === token && keyFor(getContext()) === identity;
  async function readCache(context, token) {
    try {
      if (typeof cache.read !== 'function') return null;
      const data = await cache.read();
      const result = await decodeFeatureCache(data, { now: now(), mode: context.mode, orgUuid: context.orgUuid, restricted: context.restricted });
      return current(token) ? result : null;
    } catch { return null; }
  }
  function queueCache(context, token, map) {
    if (typeof cache.write !== 'function') return;
    writeChain = writeChain.catch(() => {}).then(async () => {
      if (!current(token)) return;
      const bytes = await encodeFeatureCache({ timestamp: now(), mode: context.mode,
        orgUuid: context.restricted ? context.orgUuid : undefined, features: map });
      if (current(token)) await cache.write(bytes);
    }).catch(() => {});
  }
  async function fetchRemote(context, token, securityToken) {
    let response, body;
    try { response = await context.source.fetch(); } catch { return 'network-error'; }
    if (!response) return 'network-error';
    if (!response.ok) return 'http-error';
    try { body = await response.json(); } catch { return 'parse-error'; }
    if (!validFeatures(body?.features)) return 'parse-error';
    if (context.source.hybrid && body.user == null) return 'anon-refused';
    if (!current(token)) return 'success';
    apply(body.features, 'network', context.source, { securityToken }); queueCache(context, token, body.features);
    return 'success';
  }
  async function run(context, token, fallback, securityToken) {
    if (context.source.kind === 'static') {
      if (validFeatures(context.source.features) && current(token)) {
        apply(context.source.features, 'map-final', context.source, { securityToken });
        // Ordinary precedence may intentionally retain a projected network map.
        // Certify only this security gate when it is forced by the static map,
        // or absent from both that map and the remote allowlist.
        const gate = '513873720', fixed = context.source.features;
        const ownsGate = Object.hasOwn(fixed, gate);
        const allowed = context.source.remoteAllowedKeys;
        const preservedRemote = allowed?.has?.(gate) === true || Array.isArray(allowed) && allowed.includes(gate);
        const validGate = ownsGate ? sameFeature(features[gate], fixed[gate]) : !preservedRemote && !Object.hasOwn(features, gate);
        if (validGate && securityToken === securityEpoch && current(token)) {
          securityIdentity = identity;
          securityStaticVerified = true;
          notifySecurity();
        }
      }
      return 'static';
    }
    if (typeof context.source.fetch !== 'function') throw new TypeError('remote source fetch is required');
    const outcome = await fetchRemote(context, token, securityToken);
    lastOutcome = outcome;
    if (!current(token)) return 'stale';
    if (outcome === 'anon-refused' && (state === 'network' || state === 'disk')) {
      const before = fresh(); staleAccount = false; freshTransition(before);
      return outcome;
    }
    if ((fallback && state === 'none' && outcome !== 'success') || (outcome === 'anon-refused' && state !== 'network' && state !== 'disk')) {
      const cached = await readCache(context, token);
      if (!current(token)) return 'stale';
      if (cached) apply(cached, 'disk', context.source);
      else if (validFeatures(context.source.hardcodedFeatures)) apply(context.source.hardcodedFeatures,
        outcome === 'anon-refused' && !context.source.previouslyAuthed ? 'map-final' : 'map-fallback', context.source, { securityToken });
    }
    return outcome;
  }
  function fetchOnce(context, token, fallback) {
    if (pending?.token === token) return pending.promise;
    const securityToken = securityEpoch;
    const promise = run(context, token, fallback, securityToken).finally(() => { if (pending?.promise === promise) pending = undefined; });
    pending = { token, promise, securityToken }; return promise;
  }
  function backgroundSpread() {
    const item = features['1087396298']; exposure('1087396298',item);
    const value = item?.value;
    const valid = (x,max,fallback) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max ? x : fallback;
    return { earlyMs: valid(value?.earlyMaxMinutes,30,10)*60000, lateDelayMs:valid(value?.lateDelayMaxSeconds,40,20)*1000 };
  }
  function schedule() {
    if (timer != null) clearTimer(timer);
    timer = undefined;
    if (disposed || !initialized) return;
    const base = lastOutcome === 'network-error' ? 300000 : 3600000;
    const spread = base === 300000 ? {earlyMs:0,lateDelayMs:0} : backgroundSpread();
    const delay = base - random() * Math.min(spread.earlyMs,base/2), due = now()+delay;
    const fire = () => {
      timer = undefined;
      if (disposed) return;
      const {context, generation:token} = synchronize();
      const action = context.source.kind === 'static' ? Promise.resolve() : fetchOnce(context,token,false);
      Promise.resolve(action).finally(schedule);
    };
    timer = setTimer(() => {
      timer = undefined;
      if (disposed) return;
      if (spread.lateDelayMs > 0 && now()-due > 5000) { timer=setTimer(fire,random()*spread.lateDelayMs); timer?.unref?.(); }
      else fire();
    }, delay);
    timer?.unref?.();
  }
  function init() {
    if (disposed) return Promise.resolve();
    if (initPromise) return initPromise;
    initialized = true; const { context, generation: token } = synchronize();
    lastAccount = context.accountKey;
    initPromise = fetchOnce(context, token, true).finally(() => { if (state === 'none') initPromise = undefined; });
    schedule();
    return initPromise;
  }
  async function refresh({ force = false, requireSecurityCurrent = false } = {}) {
    if (disposed) return;
    const { context, generation: token } = synchronize();
    if (!force && lastRefresh !== undefined && now() - lastRefresh < 60000) return 'throttled';
    lastRefresh = now();
    const wanted = securityEpoch;
    const joiningOldSecurityEpoch = requireSecurityCurrent && pending?.token === token && pending.securityToken !== wanted;
    const result = await fetchOnce(context, token, false);
    if (joiningOldSecurityEpoch && current(token) && securityEpoch === wanted) return fetchOnce(context, token, false);
    return result;
  }
  function accountChanged() {
    if (disposed) return Promise.resolve();
    const prior = pending?.promise; generation++; identity = undefined;
    const { context, generation: token } = synchronize();
    staleAccount = true; lastNetworkMono = undefined; lastNetworkWall = undefined;
    invalidateSecurityFreshness();
    if (lastAccount !== undefined && lastAccount !== context.accountKey) seenExperimentExposure.clear();
    lastAccount = context.accountKey; deferredExposure.clear();
    if (context.source.kind === 'remote' && Object.hasOwn(context, 'accountKey') && context.accountKey === null) {
      accountPromise = undefined; return Promise.resolve();
    }
    const work = (async () => {
      if (prior) { try { await prior; } catch {} }
      if (!current(token)) return 'stale';
      try { return await fetchOnce(context, token, false); } finally { if (current(token)) schedule(); }
    })();
    accountPromise = work.finally(() => { if (accountPromise === wrapped) accountPromise = undefined; });
    const wrapped = accountPromise;
    return accountPromise;
  }
  // Managed-config rebuild reapplies the current projected map, not the original remote payload.
  function reproject() {
    if (disposed) return false;
    const {context} = synchronize({markStale:false});
    const fixed = context.source.hardcodedFeatures ?? (context.source.kind === 'static' ? context.source.features : null);
    if (state === 'none' || fixed == null) return false;
    apply(features, state, context.source, {reprojection:true});
    return true;
  }
  function getFeatureValue(key, fallback) {
    if (disposed) return fallback;
    synchronize(); const item = features[key]; exposure(key,item); return item === undefined ? fallback : item.value;
  }
  function getFeatureOn(key, fallback = false) {
    if (disposed) return fallback;
    synchronize(); const item = features[key]; exposure(key,item); return item?.on ?? fallback;
  }
  function subscribe(map,key,fn) {
    if (disposed) return () => {};
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    let set=map.get(key); if (!set) map.set(key,set=new Set()); set.add(fn);
    return () => { set.delete(fn); if (!set.size) map.delete(key); };
  }
  function observeFeature(key, fn) { return subscribe(legacyListeners,key,fn); }
  function observeFeatureGate(key,fn) { return subscribe(gateListeners,key,fn); }
  function onFeatureChange(key,fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    if (!disposed && state !== 'none') { exposure(key,features[key]); fn(features[key]); }
    return subscribe(changeListeners,key,fn);
  }
  function subscribeSignal(set,fn) { if (disposed) return () => {}; if (typeof fn !== 'function') throw new TypeError('listener must be a function'); set.add(fn); return () => set.delete(fn); }
  function dispose() { disposed = true; generation++; notifySecurity(); if (timer != null) clearTimer(timer); timer = undefined; legacyListeners.clear(); changeListeners.clear(); gateListeners.clear(); freshListeners.clear(); networkListeners.clear(); securityListeners.clear(); }
  return { init, refresh, accountChanged, reproject, sourceChanged:reproject, getFeatureValue, getFeatureOn, observeFeature, dispose,
    areFeaturesLoaded:loaded, waitForGrowthBookReady:() => state !== 'none' ? Promise.resolve() : init(),
    waitForGrowthBookSettled:async () => { if (state === 'none') await init(); if (accountPromise) await accountPromise; },
    isGrowthBookFreshForCurrentAccount:fresh,
    isGrowthBookFreshWithin:ms => state === 'map-final' || lastNetworkMono !== undefined && monotonicNow()-lastNetworkMono <= ms,
    getLastGrowthBookNetworkFetchAtMs:() => lastNetworkWall,
    onFeatureChange, observeFeatureGate, onGrowthBookFreshChange:fn => subscribeSignal(freshListeners,fn),
    onSecurityFreshnessChange:fn => subscribeSignal(securityListeners,fn),
    isSecurityFreshForCurrentSource:() => { if (disposed) return false; synchronize(); return securityFresh(); }, invalidateSecurityFreshness,
    onGrowthBookNetworkFetch:fn => subscribeSignal(networkListeners,fn), backgroundRefreshSpread:backgroundSpread };
}
module.exports = { createGrowthBookProvider, encodeFeatureCache, decodeFeatureCache };
