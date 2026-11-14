'use strict';

const { filterCliMcpApps } = require('./cli-mcp-app-filter.cjs');
const { filterCliMcpMetadata, parseCliMcpResourceReply } = require('./cli-mcp-resource.cjs');

// The embedding host must supply authoritative identity and permission decisions.
function createSdkMcpHostAdapter({ session, actor, discovery, isCurrent, authorize, createEndpoint }) {
  if (!session || !actor || typeof isCurrent !== 'function' || typeof authorize !== 'function' ||
      typeof createEndpoint !== 'function' || !discovery ||
      !['subscribe', 'getSnapshot', 'isCurrent'].every(k => typeof discovery[k] === 'function')) throw TypeError('host authority required');
  const entries = new Map(), binding = Object.freeze({ session, actor });
  let closed = false, generation = 0, snapshot;
  const invalidate = () => { generation++; snapshot = undefined; for (const e of entries.values()) { e.tools = undefined; e.version++; } };
  const unsubscribe = discovery.subscribe(invalidate);
  if (typeof unsubscribe !== 'function') throw TypeError('discovery unsubscribe required');
  const current = () => {
    try { return !closed && isCurrent(binding) === true && snapshot?.complete === true && discovery.isCurrent(snapshot) === true; }
    catch { return false; }
  };
  const ensure = () => { if (!current()) throw Error('stale SDK host binding'); };
  function attach(name, source, options = {}) {
    if (closed || typeof name !== 'string' || typeof source !== 'string' || entries.has(name)) throw Error('invalid or duplicate SDK server');
    const entry = { name, source, version: 0, tools: undefined, endpoint: undefined, lists: new Set(), overlap: false };
    const notifyClient = options.notifyClient || (() => {});
    entry.endpoint = createEndpoint({ ...options, notifyClient: message => {
      if (message?.method === 'notifications/tools/list_changed') { entry.version++; entry.tools = undefined; }
      return notifyClient(message);
    } });
    if (!entry.endpoint || typeof entry.endpoint.ccb !== 'function' || typeof entry.endpoint.read !== 'function' || typeof entry.endpoint.close !== 'function') throw TypeError('invalid SDK endpoint');
    entries.set(name, entry);
    if (entry.endpoint.exit?.then) entry.endpoint.exit.then(() => { entry.version++; entry.tools = undefined; });
    return entry.endpoint;
  }
  async function refresh() {
    const version = generation;
    const next = await discovery.getSnapshot({ sessionId: session, actorToken: actor });
    if (closed || generation !== version || isCurrent(binding) !== true || next?.complete !== true ||
        next.featureEnabled !== true || next.sessionAllowed !== true || typeof next.conflicts !== 'function' ||
        typeof next.cliRunsAsThisUser !== 'boolean' || discovery.isCurrent(next) !== true) throw Error('incomplete discovery');
    snapshot = next;
  }
  async function ccb(name, message) {
    ensure();
    const entry = entries.get(name); if (!entry) throw Error('unknown SDK server');
    const list = message?.method === 'tools/list' && Object.hasOwn(message, 'id');
    const version = list ? ++entry.version : entry.version;
    if (list) { entry.tools = undefined; if (entry.lists.size) entry.overlap = true; entry.lists.add(version); }
    try {
      const response = await entry.endpoint.ccb(message);
      ensure();
      if (list && !entry.overlap && entry.version === version && Array.isArray(response?.result?.tools)) entry.tools = structuredClone(response.result.tools);
      return response;
    } finally {
      if (list) { entry.lists.delete(version); if (!entry.lists.size) entry.overlap = false; }
    }
  }
  function apps() {
    ensure();
    const result = filterCliMcpApps([...entries.values()].map(e => ({ name: e.name, source: e.source, tools: e.tools })), snapshot.conflicts);
    ensure();
    return result.map(app => ({ ...app, tools: app.tools.map(tool => ({ ...tool, _meta: filterCliMcpMetadata(tool._meta, snapshot.cliRunsAsThisUser) })) }));
  }
  async function read(requestBinding, name, uri) {
    ensure();
    if (requestBinding?.session !== session || requestBinding?.actor !== actor) throw Error('SDK host binding mismatch');
    const entry = entries.get(name), app = apps().find(x => x.name === name);
    if (!entry || !app?.tools.some(t => (t._meta?.ui?.resourceUri ?? t._meta?.['ui/resourceUri']) === uri)) throw Error('resource URI not declared');
    const token = generation, version = entry.version, snap = snapshot;
    const check = () => { ensure(); if (token !== generation || version !== entry.version || snapshot !== snap || entries.get(name) !== entry) throw Error('resource declaration changed'); };
    const authority = Object.freeze({ ...binding, server: name, source: entry.source });
    if (await authorize(authority, uri) !== true) throw Error('resource access denied');
    check();
    const response = await entry.endpoint.read(uri);
    check();
    if (await authorize(authority, uri) !== true) throw Error('resource access denied');
    check();
    if (response?.error || !Array.isArray(response?.result?.contents) || response.result.contents.some(x => x?.uri !== uri)) throw Error('invalid resource response');
    const result = parseCliMcpResourceReply(response.result, snap.cliRunsAsThisUser);
    if (result.unavailable) throw Error('invalid resource response');
    return result;
  }
  function close() { if (closed) return; closed = true; invalidate(); unsubscribe(); for (const e of entries.values()) e.endpoint.close(); entries.clear(); }
  return { attach, refresh, ccb, apps, read, close };
}
module.exports = { createSdkMcpHostAdapter };
