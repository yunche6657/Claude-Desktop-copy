'use strict';

const { randomUUID, createHash } = require('node:crypto');
const MAX_TABS = 25;
const validUrl = value => {
  try { const url = new URL(value); return ['http:', 'https:', 'about:'].includes(url.protocol) && !url.username && !url.password && (url.protocol !== 'about:' || value === 'about:blank'); }
  catch { return false; }
};

// Exact pure URL-redaction helper from original index.chunk-lzaSYO3Q.js
// offsets 4622871..4627883; no application imports or runtime hooks.
const sanitizeConsoleText = (() => {
const Gci="REDACTED",Kci=2048,DY=16384,qci="\u2026[truncated]",Jci=4096,Yci=new Set(["code","auth","key","sig","hash","hmac","mac","salt","otp","pin","pass","pwd","pw","totp","sid","assertion","nonce","magic","jwt","bearer","ssn","cvv","cvc","cc"]),Xci=new Set("product.item.sku.part.model.article.catalog.category.course.event.plan.type.job.country.region.state.province.city.area.post.postal.zip.dial.airport.iata.lang.language.locale.currency.status.error.reason.result.response.return.exit.http.decline.failure.char.key.color.colour.size".split(".")),Zci="token.secret.passw.passcode.passphrase.credential.apikey.authcode.authkey.authoriz.oauth.otpcode.saml.signature.session.sessid.cookie.csrf.xsrf.verif.xamz.xgoog.keypairid.privatekey.accesskey.oobcode.creditcard.cardnum.ccnumber.socialsecurity".split(".");function OY(e){try{return decodeURIComponent(e.replace(/\+/gu," "))}catch{return e}}function Qci(e){let t=e.replace(/([a-z0-9])([A-Z])/gu,"$1_$2").toLowerCase().split(/[^a-z0-9]+/u).filter((e=>e!=="")),n=t.join(""),r=t.at(-1)??"",i=r.endsWith("s")&&Yci.has(r.slice(0,-1))?r.slice(0,-1):r,a=i==="code"&&Xci.has(t.at(-2)??"");return Yci.has(i)&&!a||Zci.some((e=>n.includes(e)))}function $ci(e){let t=OY(e);if(Qci(t))return!0;let n=t.endsWith("]")?t.lastIndexOf("["):-1;return n>0&&Qci(t.slice(n+1,-1))}function kY(e){let t=OY(e);return t.split(/[^\w-]+/u).some(eli)?!0:t.length<24?!1:(t.match(/[A-Za-z0-9]{16,}/gu)??[]).some((e=>Number(/[A-Z]/u.test(e))+Number(/[a-z]/u.test(e))+Number(/[0-9]/u.test(e))>=2))}function eli(e){let t=OY(e);if(!/^[\w-]{16,}$/u.test(t)||!/[A-Z]/u.test(t)||!/[a-z]/u.test(t))return!1;let n=t.match(/[a-z](?=[A-Z])|[A-Za-z](?=[0-9])|[0-9](?=[A-Za-z])/gu)?.length??0;return n>=3&&n*5>=t.length}function tli(e){let t=OY(e);if(/\/\/[^/?#]*@/u.test(t))return!0;let n=e=>{let t=e.indexOf("=");return t>0&&e.length-t>3&&(Qci(e.slice(0,t))||kY(e.slice(t+1)))},r=e=>!e.includes("=")&&e.split("/").some(kY),i=t.indexOf("#");return t.split(/[?&#;]/u).some(n)||i!==-1&&t.slice(i+1).split(/[?&#;]/u).some(r)}function nli(e,t){return OY(t).length<=2?null:$ci(e)||kY(t)||tli(t)?`${e}=${Gci}`:null}function rli(e){return e.split(/([&;])/u).map((e=>{if(e==="&"||e===";")return e;let t=e.indexOf("=");return t===-1||/^=*$/u.test(e.slice(t+1))?kY(e.replace(/=+$/u,""))?Gci:e:nli(e.slice(0,t),e.slice(t+1))??e})).join("")}function ili(e){return e.length<=1?"":`?${rli(e.slice(1))}`}function ali(e){return e.includes(";")?e.replace(/;([^;/=]*)=([^;/]*)/gu,((e,t,n)=>{let r=nli(t,n);return r===null?e:`;${r}`})):e}function oli(e){return e.split("/").map((e=>kY(e)?Gci:e)).join("/")}function sli(e){if(e.length<=1)return"";let t=e.slice(1),n=t.indexOf("?"),r=t.indexOf("=");return r!==-1&&(n===-1||r<n)?`#${rli(t)}`:n===-1?`#${oli(t)}`:`#${oli(t.slice(0,n))}?${rli(t.slice(n+1))}`}var cli=/[\s\u0085"'<>\\`]/gu,lli=e=>e==="'"?"%27":encodeURIComponent(e);function uli(e){let t=e.replace(cli,lli);return t.length>Kci?t.slice(0,2036)+qci:t}function AY(e){if(URL.canParse?.(e)===!1)return null;try{return new URL(e)}catch{return null}}function jY(e){let t=e.length>DY?e.slice(0,DY).replace(/[?&#;][^?&#;]*$/u,""):e,n=AY(t);if(n===null){let e=t.search(/[?#]/u);return uli(e===-1?t:t.slice(0,e))}return n.protocol==="http:"||n.protocol==="https:"?uli(`${n.protocol}//${n.host}${ali(n.pathname)}${ili(n.search)}${sli(n.hash)}`):/^about:(?:blank|srcdoc)$/iu.test(t)?t.toLowerCase():n.protocol==="blob:"?n.origin==="null"?"blob:":`blob:${n.origin}`:/^[a-z][a-z0-9+.-]*:\/\//iu.test(t)?uli(`${n.protocol}//${n.host}${ali(n.pathname)}`):n.protocol}var dli=e=>e.replace(/^www\./iu,"");function fli(e,t){let n=dli(t.hostname),r=AY(`http://${e.replace(/^[a-z][a-z0-9+.-]*:\/\//iu,"")}`);return n!==""&&r!==null&&r.username===""&&r.password===""&&dli(r.hostname)===n}function pli(e,t){let n=e.length>DY?e.slice(0,16385):e,r=n.trim();if(/^https?:\/\/\S+$/iu.test(r)&&AY(r)!==null)return r;let i=AY(t);if(i===null)return null;if(fli(r,i))return t;if(i.search.length<=1&&i.hash.length<=1)return null;if(n.length>=Jci)return t;let a=OY(n);return[i.search,i.hash].some((e=>e.length>=4&&e.length<=9*n.length&&(n.includes(e)||a.includes(OY(e)))))?t:null}var mli=/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"<>]+/giu,hli=/[\s"<>]/u,gli=/[.,;:!?'`]/u,_li=/:\d+:\d+$/u,vli=/^(?:\s*at (?:async )?(?:.*\()?|[^\s@(]*@)$/u,yli=200;function bli(e,t){return e.split(t).length-1}var xli=[[")","("],["]","["],["}","{"]];function Sli(e){let t=new Map(xli.map((([t,n])=>[t,bli(e,t)-bli(e,n)]))),n=e.length;for(;n>0;){let r=e.charAt(n-1),i=t.get(r)??0;if(i>0)t.set(r,i-1);else if(!gli.test(r))return n;--n}return n}function Cli(e){if(e.length<=DY)return e;let t=DY;for(;t>0&&!hli.test(e.charAt(t-1));)--t;let n=e.slice(0,DY);return(n.includes("://",t)?n.slice(0,t):n)+qci}function wli(e){let t=Cli(e);return t.replace(mli,((e,n)=>{let r=e.slice(0,Sli(e)),i=t.slice(Math.max(0,n-yli),n),a=vli.test(i.slice(i.lastIndexOf(`\n`)+1))&&_li.exec(r)?.[0]||"",o=r.slice(0,r.length-a.length);return/[?#;@]/u.test(o)?jY(o)+a+e.slice(r.length):e}))}
return wli;
})();

const trimText = (text, limit) => text.length <= limit ? text : text.slice(0, limit) + '...';
const remoteReadContext = id => typeof id === 'string' && id.startsWith('preview-remote-')
  && !id.startsWith('preview-remote-artifact_') && !id.startsWith('preview-remote-gdrive_');
function consoleArgument(arg) {
  if (arg.value !== undefined || arg.type === 'undefined') return String(arg.value);
  if (arg.subtype === 'error' && arg.description !== undefined) return arg.description;
  const properties = arg.preview?.properties;
  return properties?.length ? '{' + properties.map(p => p.name + ': ' + (p.value ?? '…')).join(', ') + (arg.preview.overflow ? ', …' : '') + '}' : arg.description || '';
}
function formatAccessibility(nodes, counter) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const entries = new Map(nodes.map(node => [node.nodeId, node]));
  const active = new Set();
  const build = node => {
    if (active.has(node.nodeId)) throw new Error('Cyclic accessibility tree');
    active.add(node.nodeId);
    const tree = { uid: String(++counter.value), role: node.role?.value || 'unknown', name: node.name?.value || '',
      value: node.value?.value == null ? undefined : String(node.value.value), children: [] };
    for (const id of node.childIds || []) { const child = entries.get(id); if (child) tree.children.push(build(child)); }
    active.delete(node.nodeId); return tree;
  };
  const interactive = new Set(['button','link','textbox','checkbox','radio','combobox','menuitem','tab','heading','img']);
  const generic = role => ['none','presentation','generic'].includes(role);
  const hasMeaning = node => node.children.some(child => interactive.has(child.role) && !(child.role === 'img' && !child.name) || hasMeaning(child));
  const count = node => node.children.reduce((sum, child) => sum + 1 + count(child), 0);
  const line = (node, indent) => '  '.repeat(indent) + '[' + node.uid + '] ' + node.role
    + (node.name ? ': "' + trimText(node.name, 200) + '"' : '') + (node.value ? ' (value: "' + trimText(node.value, 200) + '")' : '');
  const format = (node, indent = 0, depth = 0) => {
    if (depth > 8) { const descendants = count(node); return line(node, indent) + (descendants ? ' ... (' + descendants + ' descendants)' : ''); }
    const children = node.role === 'SvgRoot' || node.role === 'img' && node.children.length && !hasMeaning(node) ? [] : node.children;
    if (generic(node.role) && !node.name && !node.value && !hasMeaning(node)) return children.map(child => format(child, indent, depth)).filter(Boolean).join('\n');
    if (!node.name && !node.value && children.length === 1 && generic(node.role)) return format(children[0], indent, depth);
    return [line(node, indent), ...children.map(child => format(child, indent + 1, depth + 1)).filter(Boolean)].join('\n');
  };
  const text = format(build(nodes[0]));
  return text.length <= 12000 ? text : text.slice(0,12000) + '\n\n... (truncated — ' + text.length + ' total chars, showing first 12000)';
}

// Browser views contain real, isolated webContents. Service supervision is supplied
// by preview-launch; this host never starts a server or invents successful tabs.
function createPreviewHost({ createView, getMainWindow = () => null, emit = () => {},
  isUrlAllowed = validUrl, maxTabs = MAX_TABS, captureTimeoutMs = 10000, offscreen = false, readToolsEnabled = false, authorizeRead = () => false, getSession = () => null,
  authorizeHtmlFile = () => false, interactiveHtmlEnabled = false, onHtmlPreviewsChanged = () => {} } = {}) {
  if (!Number.isInteger(maxTabs) || maxTabs < 1 || maxTabs > 100) throw new TypeError('Invalid preview tab limit');
  const partition = 'preview-host-' + randomUUID();
  if (!Number.isSafeInteger(captureTimeoutMs) || captureTimeoutMs < 1) throw new TypeError('Invalid preview capture deadline');
  const contexts = new Map();
  const htmlRecords = new Map();
  let htmlCounter = 0;
  const artifacts = require('./preview-artifact.cjs').createPreviewArtifacts({ getSession, authorizeHtmlFile });
  const htmlChanged = () => { try { onHtmlPreviewsChanged(); } catch {} };
  const interactiveHtml = () => { try { return (typeof interactiveHtmlEnabled === 'function' ? interactiveHtmlEnabled() : interactiveHtmlEnabled) === true; } catch { return false; } };
  let disposed = false;
  const makeView = createView || (options => new (require('electron').WebContentsView)(options));
  const send = (...args) => { try { emit(...args); } catch {} };
  const alive = tab => tab && !tab.view.webContents.isDestroyed();
  const selected = (ctx, tabId) => ctx?.tabs.get(tabId === undefined ? ctx.activeTabId : tabId);
  const allowed = url => { try { return artifacts.owns(url) || artifacts.ownsRaw(url) || validUrl(url) && isUrlAllowed(url) === true; } catch { return false; } };
  const readsEnabled = () => { try { return (typeof readToolsEnabled === 'function' ? readToolsEnabled() : readToolsEnabled) === true; } catch { return false; } };
  const navigationAllowed = (ctx, tab, url) => tab?.rawDocument ? artifacts.ownsRaw(url,ctx.id) : tab?.artifactToken ? artifacts.isDocument(url,ctx.id,tab.artifactToken) : artifacts.owns(url) ? artifacts.owns(url,ctx.id) : allowed(url);
  function addConsole(tab, record) {
    const wc = tab.view.webContents;
    let origin;
    try { origin = new URL(wc.getURL()).origin; } catch {}
    const row = { ...record, text: trimText(sanitizeConsoleText(String(record.text)), 8000), origin, sequence: (tab.consoleSequence || 0) + 1 };
    tab.consoleSequence = row.sequence;
    tab.console.push(row); tab.consoleChars += row.text.length;
    while (tab.console.length > 1 && (tab.console.length > 500 || tab.consoleChars > 2000000)) tab.consoleChars -= tab.console.shift().text.length;
  }
  async function ensureTools(ctx, tab) {
    if (!readsEnabled() || !remoteReadContext(ctx.id) || !alive(tab)) return false;
    const tools = tab.view.webContents.debugger;
    if (!tools) return false;
    if (tab.toolsReady && tab.toolsOwned && tools.isAttached()) return tab.toolsReady;
    if (tools.isAttached() && !tab.toolsOwned) return false;
    tab.toolsReady = (async () => {
      try {
        tools.attach('1.3'); tab.toolsOwned = true;
        const listener = (_event, method, params) => {
          if (method === 'Runtime.consoleAPICalled') {
            const type = params.type;
            const level = type === 'warning' ? 'warn' : ['assert','error'].includes(type) ? 'error' : ['info','debug'].includes(type) ? type : 'log';
            let text = '';
            for (const arg of params.args || []) { if (text.length > 16000) break; text += (text ? ' ' : '') + trimText(consoleArgument(arg), 16000); }
            addConsole(tab, { level, text, timestamp: params.timestamp ?? Date.now() });
          } else if (method === 'Runtime.exceptionThrown') {
            const details = params.exceptionDetails;
            const text = [details?.text, details?.exception ? consoleArgument(details.exception) : ''].filter(Boolean).join(' ');
            addConsole(tab, { level: 'error', text: text || 'Uncaught exception', timestamp: params.timestamp ?? Date.now(), source: 'javascript' });
          } else if (method === 'Log.entryAdded') {
            const entry = params.entry;
            addConsole(tab, { level: entry.level === 'warning' ? 'warn' : entry.level, text: entry.text, timestamp: entry.timestamp ?? Date.now(), source: entry.source });
          }
        };
        tab.toolsListener = listener; tools.on('message', listener);
        await tools.sendCommand('Runtime.enable'); await tools.sendCommand('Log.enable');
        return true;
      } catch { releaseTools(tab); return false; }
    })();
    return tab.toolsReady;
  }
  function releaseTools(tab) {
    if (!tab.toolsOwned && !tab.toolsListener) return;
    let tools;
    try { tools = tab.view.webContents.debugger; } catch { tab.toolsOwned = false; tab.toolsListener = null; return; }
    if (tools && tab.toolsListener) { try { tools.removeListener('message', tab.toolsListener); } catch {} }
    tab.toolsListener = null;
    if (tab.toolsOwned && tools) { try { if (tools.isAttached()) tools.detach(); } catch {} }
    tab.toolsOwned = false;
  }
  function readStamp(ctx, tab) {
    if (!readsEnabled() || !remoteReadContext(ctx.id) || !alive(tab) || tab.loading) return null;
    try {
      const wc = tab.view.webContents;
      const url = wc.getURL();
      if (!allowed(url) || !/^https?:/.test(url)) return null;
      const frames = wc.mainFrame?.framesInSubtree;
      if (!Array.isArray(frames)) return null;
      const frameState = frames.map(frame => ({ processId: frame.processId, routingId: frame.routingId, url: frame.url }));
      return { url, origin: new URL(url).origin, epoch: tab.readEpoch, frames: frameState };
    } catch { return null; }
  }
  const policyStamp = (ctx,tab,stamp) => ({ serverId: ctx.id, tabId: tab.id, cwd: ctx.cwd, sessionId: ctx.sessionId, ...stamp, frames: stamp.frames.map(frame=>({...frame})) });
  const sameStamp = (left, right) => left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
  async function readPage(serverId, action, commit) {
    const ctx = contexts.get(serverId), tab = selected(ctx);
    if (!ctx || !tab) return null;
    const previous = tab.readQueue || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const stamp = readStamp(ctx, tab);
      if (stamp === null) return null;
      let approved = false;
      try { approved = await authorizeRead(policyStamp(ctx,tab,stamp)); } catch {}
      if (approved !== true || !sameStamp(stamp, readStamp(ctx, tab)) || !await ensureTools(ctx, tab) || !sameStamp(stamp, readStamp(ctx, tab))) return null;
      const result = await action(ctx, tab, stamp);
      if (!sameStamp(stamp, readStamp(ctx, tab))) return null;
      // Policy/org grants may change during CDP work without a navigation.
      // Recheck the original stamp before exposing data or committing clear.
      let stillApproved = false;
      try { stillApproved = await authorizeRead(policyStamp(ctx,tab,stamp)); } catch {}
      if (stillApproved !== true || !sameStamp(stamp, readStamp(ctx, tab))) return null;
      commit?.(ctx, tab, result);
      return result;
    }).catch(() => null);
    tab.readQueue = job;
    return job;
  }
  function summary(tab) {
    const wc = tab.view.webContents;
    let title = '', audible = false, muted = tab.muted;
    try { title = wc.getTitle(); audible = wc.isCurrentlyAudible?.() || false; muted = wc.isAudioMuted?.() ?? muted; } catch {}
    return { tabId: tab.id, origin: tab.displayUrl || (tab.url === 'about:blank' || tab.rawDocument ? '' : new URL(tab.url).origin),
      toolAccess: 'pending', isOrgBlocked: false, title, loading: tab.loading,
      toolActive: false, openedWithoutGesture: false, audible, muted,
      emulatedViewport: tab.viewport ? { ...tab.viewport } : null,
      ...(tab.favicon ? { faviconUrl: tab.favicon } : {}) };
  }
  function tabs(ctx) { return ctx ? { tabs: [...ctx.tabs.values()].filter(alive).map(summary), activeTabId: ctx.activeTabId } : { tabs: [], activeTabId: 'seed' }; }
  function changed(ctx, detail) { send('previewTabsChanged', ctx.id, tabs(ctx).tabs, ctx.activeTabId, detail); }
  function detach(ctx) {
    if (!ctx.attached) return;
    try { ctx.attached.window.contentView.removeChildView(ctx.attached.view); } catch {}
    ctx.attached = null;
  }
  function attach(ctx) {
    detach(ctx);
    if (!ctx.visible) return false;
    const tab = selected(ctx);
    const win = getMainWindow(ctx.targetWindowId);
    if (!alive(tab) || !win || win.isDestroyed?.() || !win.contentView?.addChildView) return false;
    try { win.contentView.addChildView(tab.view); tab.view.setBounds(ctx.bounds); tab.view.setVisible?.(true); ctx.attached = { window: win, view: tab.view }; return true; }
    catch { return false; }
  }
  function wire(ctx, tab) {
    const wc = tab.view.webContents;
    wc.setWindowOpenHandler?.(({ url }) => { if (!tab.artifactToken && !tab.rawDocument && allowed(url)) openTab(ctx, url); return { action: 'deny' }; });
    const guard = (event, url) => { if (!navigationAllowed(ctx,tab,url)) event.preventDefault(); };
    wc.on('did-start-navigation', () => { tab.readEpoch++; });
    wc.on('did-frame-navigate', () => { tab.readEpoch++; });
    wc.on('did-navigate-in-page', () => { tab.readEpoch++; });
    wc.on('will-navigate', guard); wc.on('will-redirect', guard);
    wc.on('did-start-loading', () => { tab.loading = true; changed(ctx); });
    wc.on('did-stop-loading', () => { tab.loading = false; changed(ctx); });
    const committed = (_event, url, _inPlace, isMainFrame = true) => {
      if (!isMainFrame || !allowed(url)) return;
      tab.url = url; tab.lastCapture = null;
      send('previewUrlChanged', ctx.id, tab.displayUrl || url); changed(ctx);
    };
    wc.on('did-navigate', (event, url) => committed(event, url));
    wc.on('did-navigate-in-page', (event, url, isMainFrame) => { if (isMainFrame) committed(event, url); });
    wc.on('page-title-updated', () => changed(ctx));
    wc.on('page-favicon-updated', (_event, urls) => { tab.favicon = urls.find(url => /^https?:/.test(url)); changed(ctx); });
    wc.on('audio-state-changed', () => changed(ctx));
    wc.on('destroyed', () => {
      releaseTools(tab);
      if (!ctx.tabs.has(tab.id) || ctx.closing) return;
      ctx.tabs.delete(tab.id);
      if (ctx.activeTabId === tab.id) ctx.activeTabId = ctx.tabs.keys().next().value || 'seed';
      attach(ctx); changed(ctx);
    });
  }
  function openTab(ctx, url = 'about:blank', id, metadata = {}) {
    if (disposed || ctx.tabs.size >= maxTabs || ctx.artifactMode === 'static' && ctx.tabs.size > 0 || !allowed(url)) return null;
    let view;
    try { view = makeView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, focusOnNavigation: false, disableDialogs: true,
      backgroundThrottling: false, offscreen: Boolean(offscreen), partition: ctx.partition || partition } }); } catch { return null; }
    if (!view?.webContents || view.webContents.isDestroyed()) return null;
    const tab = { id: id || 'tab-' + randomUUID(), view, url: 'about:blank', loading: true, muted: ctx.muted, viewport: null, lastCapture: null, console: [], consoleChars: 0, readEpoch: 0, axCounter: { value: 0 }, artifactToken: artifacts.owns(url,ctx.id) ? new URL(url).hostname : null, displayUrl: metadata.displayUrl, rawDocument: artifacts.ownsRaw(url,ctx.id) };
    ctx.tabs.set(tab.id, tab); ctx.activeTabId = tab.id;
    try {
      view.webContents.session?.setPermissionRequestHandler?.((_wc, _permission, callback) => callback(false));
      view.webContents.setAudioMuted(ctx.muted);
      view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
      view.setBackgroundColor?.('#ffffff');
      wire(ctx, tab); attach(ctx); changed(ctx);
      tab.ready = (async () => {
        if (tab.artifactToken && !await artifacts.bindSession(view.webContents.session,ctx.id)) throw new Error('Artifact protocol could not be installed');
        // Chromium needs an initial document before a new WebContentsView can
        // answer Runtime.enable. Attach before the real page so early logs survive.
        if (readsEnabled() && remoteReadContext(ctx.id)) await view.webContents.loadURL('about:blank');
        await ensureTools(ctx, tab);
        return view.webContents.loadURL(url);
      })().then(() => {
        if (!alive(tab) || !ctx.tabs.has(tab.id)) return false;
        tab.url = view.webContents.getURL() || url; tab.loading = false; changed(ctx); return true;
      }, () => { tab.loading = false; changed(ctx); return false; });
      return tab;
    } catch {
      ctx.tabs.delete(tab.id);
      try { view.webContents.close(); } catch {}
      return null;
    }
  }
  async function createPreview(serverId, url, cwd, sessionId, internal = {}) {
    if (disposed || typeof serverId !== 'string' || !serverId || !allowed(url)) return null;
    let ctx = contexts.get(serverId);
    if (ctx) {
      const tab = selected(ctx);
      if (!alive(tab) || !await tab.ready) return null;
      return { previewId: ctx.id, tabId: tab.id };
    }
    ctx = { id: serverId, cwd, sessionId, artifactMode: internal.artifactMode, partition: internal.partition, tabs: new Map(), closed: [], activeTabId: 'seed', muted: false,
      visible: false, attached: null, claimantId: null, targetWindowId: undefined,
      bounds: { x: 0, y: 0, width: 1024, height: 768 } };
    contexts.set(serverId, ctx);
    const tab = openTab(ctx, url, 'seed',internal);
    if (!tab || !await tab.ready) { destroyPreview(serverId); return null; }
    return { previewId: ctx.id, tabId: tab.id };
  }
  async function navigatePreview(serverId, url, tabId) {
    const ctx = contexts.get(serverId), tab = selected(ctx, tabId);
    if (!alive(tab) || !navigationAllowed(ctx,tab,url)) return false;
    try { await tab.view.webContents.loadURL(url); tab.url = tab.view.webContents.getURL() || url; tab.lastCapture = null; changed(ctx); return true; }
    catch { return false; }
  }
  function closePreviewTab(serverId, tabId) {
    const ctx = contexts.get(serverId), tab = selected(ctx, tabId);
    if (!tab) return false;
    if (ctx.artifactMode === 'static' && ctx.tabs.size === 1) return destroyPreview(serverId);
    if (tab.artifactToken) artifacts.revoke(tab.artifactToken);
    ctx.closed.push(tab.url); if (ctx.closed.length > 25) ctx.closed.shift();
    ctx.tabs.delete(tab.id);
    if (ctx.activeTabId === tab.id) ctx.activeTabId = ctx.tabs.keys().next().value || 'seed';
    detach(ctx);
    releaseTools(tab);
    try { tab.view.webContents.close(); } catch {}
    attach(ctx); changed(ctx); return true;
  }
  function destroyPreview(serverId) {
    const ctx = contexts.get(serverId);
    if (!ctx) return false;
    contexts.delete(serverId); ctx.closing = true; detach(ctx);
    try{ctx.rawSourceWatcher?.close();}catch{}
    clearTimeout(ctx.rawSourceTimer);
    artifacts.revokeOwner(serverId);
    for (const tab of ctx.tabs.values()) { try { artifacts.unbindSession(tab.view.webContents.session,serverId); } catch {} }
    if (htmlRecords.delete(serverId)) htmlChanged();
    for (const tab of ctx.tabs.values()) { releaseTools(tab); try { tab.view.webContents.close(); } catch {} }
    ctx.tabs.clear(); changed(ctx); return true;
  }
  function history(serverId, tabId, direction) {
    const ctx = contexts.get(serverId), tab = selected(ctx, tabId);
    if (!alive(tab)) return false;
    const wc = tab.view.webContents, nav = wc.navigationHistory || wc;
    try {
      if (direction === 'back' ? !nav.canGoBack() : !nav.canGoForward()) return false;
      direction === 'back' ? nav.goBack() : nav.goForward(); return true;
    } catch { return false; }
  }
  async function capture(serverId, tabId, changedOnly, force) {
    const ctx = contexts.get(serverId), tab = selected(ctx, tabId);
    if (!alive(tab) || tab.loading) return null;
    let timer, attached = false, cancelled = false;
    const wc = tab.view.webContents;
    try {
      const encode = image => {
        if (tabId !== undefined && !changedOnly) {
          const size = image.getSize();
          if (size.width < 1 || size.height < 1) return null;
          const width = Math.min(size.width, 800);
          image = image.resize({ width, height: Math.max(1, Math.floor(width / size.width * size.height)), quality: 'good' });
        }
        return changedOnly || tabId !== undefined ? image.toJPEG(changedOnly ? 80 : 75) : image.toPNG();
      };
      const readFrame = async () => {
        try {
          const image = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
          if (cancelled) return null;
          if (!image.isEmpty()) return encode(image);
        } catch {}
        // Hidden WebContentsView can have no compositor surface. CDP captures
        // its actual document without presenting a window or moving OS focus.
        if (cancelled || !alive(tab) || !wc.debugger || wc.debugger.isAttached() && !tab.toolsOwned) return null;
        if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }
        const frame = await wc.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true, captureBeyondViewport: false,
        });
        if (typeof frame.data !== 'string') return null;
        const image = require('electron').nativeImage.createFromBuffer(Buffer.from(frame.data, 'base64'));
        return image.isEmpty() ? null : encode(image);
      };
      const bytes = await Promise.race([readFrame(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Preview capture timeout')), captureTimeoutMs);
      })]);
      if (!alive(tab) || !bytes?.length) return null;
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (changedOnly && tab.lastCapture === digest && !force) return null;
      if (changedOnly) tab.lastCapture = digest;
      return bytes.toString('base64');
    } catch { return null; }
    finally { cancelled = true; clearTimeout(timer); if (attached && !wc.isDestroyed()) { try { wc.debugger.detach(); } catch {} } }
  }
  function evictHtml(scope) {
    for (const [id,row] of [...htmlRecords]) if ((row.sessionId ?? null) === (scope ?? null)) destroyPreview(id);
    const others = [...htmlRecords.keys()]; for (const id of others.slice(0,Math.max(0,others.length-3))) destroyPreview(id);
  }
  async function loadHtmlPreview(filePath, sessionId, cwd) {
    if (disposed) return null;
    const { resolveRequested } = require('./preview-artifact.cjs');
    const path = require('node:path'), { pathToFileURL } = require('node:url');
    if (sessionId !== undefined && !await getSession(sessionId)) throw new Error('Session not found.');
    const requested = resolveRequested(filePath,cwd); if (!requested) return null;
    if (interactiveHtml() && sessionId !== undefined && cwd) {
      const id = 'preview-' + sessionId;
      const descriptor = await artifacts.mintFile({requestedPath:requested,sessionId,cwd,interactive:true,ownerId:id});
      if (descriptor) {
        let ctx = contexts.get(id), tab;
        const displayUrl = pathToFileURL(descriptor.sourcePath).href;
        if (!ctx) {
          const result = await createPreview(id,descriptor.url,cwd,sessionId,{artifactMode:'interactive',partition:'artifact-'+randomUUID(),displayUrl});
          if (!result) { artifacts.revoke(descriptor.token); return null; }
        } else {
          tab = openTab(ctx,descriptor.url,undefined,{displayUrl});
          if (!tab || !await tab.ready) { if(tab)closePreviewTab(id,tab.id);artifacts.revoke(descriptor.token);return null; }
        }
        return id;
      }
    }
    const id='html-preview-'+Date.now()+'-'+htmlCounter++;
    const descriptor=await artifacts.readRawFile({requestedPath:requested,sessionId,cwd,ownerId:id});
    if(!descriptor)return null;
    evictHtml(sessionId);
    const created=await createPreview(id,descriptor.url,path.dirname(requested),sessionId,{artifactMode:'static',partition:'artifact-'+randomUUID()});
    if(!created){artifacts.revokeOwner(id);return null;}
    const ctx=contexts.get(id);ctx.rawSource=descriptor;
    watchRawFile(ctx);
    // Original W5i passes no cwd to the standalone fallback manager; its cwd is
    // the source directory and filePath is absent, even when cwd resolved input.
    htmlRecords.set(id,{serverId:id,name:path.basename(requested),...(sessionId!==undefined?{sessionId}:{}),port:0,status:'running',startedAt:new Date().toISOString(),cwd:path.dirname(requested)});htmlChanged();
    return id;
  }
  async function refreshRawFile(ctx, force=false) {
    if(contexts.get(ctx.id)!==ctx||!ctx.rawSource)return false;
    if(ctx.rawRefresh)return ctx.rawRefresh;
    ctx.rawRefresh=(async()=>{
      const source=ctx.rawSource;
      const fresh=await artifacts.readRawFile({requestedPath:source.sourcePath,sessionId:ctx.sessionId,cwd:source.cwd,ownerId:ctx.id,expected:source});
      if(!fresh||contexts.get(ctx.id)!==ctx)return false;
      const tab=selected(ctx);if(!alive(tab))return false;
      ctx.rawSource=fresh;
      if(fresh.url===tab.url&&!force)return false;
      try{await tab.view.webContents.loadURL(fresh.url);tab.url=fresh.url;tab.lastCapture=null;changed(ctx);return true;}catch{return false;}
    })().finally(()=>{ctx.rawRefresh=null;});
    return ctx.rawRefresh;
  }
  function watchRawFile(ctx) {
    const fs=require('node:fs'),path=require('node:path');
    const filename=path.basename(ctx.rawSource.sourcePath);
    const equal=name=>process.platform==='win32'||process.platform==='darwin'?name.toLowerCase()===filename.toLowerCase():name===filename;
    try {
      ctx.rawSourceWatcher=fs.watch(path.dirname(ctx.rawSource.sourcePath),{persistent:false},(_event,name)=>{
        if(name!==null&&!equal(String(name)))return;
        clearTimeout(ctx.rawSourceTimer);
        ctx.rawSourceTimer=setTimeout(()=>{ctx.rawSourceTimer=null;void refreshRawFile(ctx);},200);
      });
      ctx.rawSourceWatcher.on('error',()=>{ctx.rawSourceWatcher?.close();ctx.rawSourceWatcher=null;clearTimeout(ctx.rawSourceTimer);});
    }catch{}
  }
  async function loadHtmlPreviewContent(content, displayPath, isSvg, cwd, sessionId) {
    if(disposed||!await getSession(sessionId))throw new Error('Session not found.');
    const path=require('node:path'),{pathToFileURL}=require('node:url');
    const id='html-preview-'+Date.now()+'-'+htmlCounter++;
    const descriptor=await artifacts.mintContent({content,displayPath,isSvg,cwd,sessionId,ownerId:id});
    if(!descriptor)throw new Error('HTML preview content is invalid or exceeds the native limit.');
    evictHtml(sessionId);
    const displayUrl=pathToFileURL(path.resolve(cwd||'.',displayPath)).href;
    const created=await createPreview(id,descriptor.url,cwd,sessionId,{artifactMode:'static',partition:'artifact-'+randomUUID(),displayUrl});
    if(!created){artifacts.revoke(descriptor.token);throw new Error('HTML preview page failed to load.');}
    htmlRecords.set(id,{serverId:id,name:path.basename(displayPath),sessionId,port:0,status:'running',startedAt:new Date().toISOString(),cwd:cwd||path.dirname(displayPath),...(cwd?{filePath:displayPath}:{})});htmlChanged();return id;
  }
  return {
    createPreview,
    loadHtmlPreview,loadHtmlPreviewContent,
    loadClaudePagePreview: async () => null,
    setArtifactPaneHost: () => false,
    getHtmlPreviews: () => [...htmlRecords.values()].map(row=>({...row})),
    // Main-process policy adapter only; intentionally not an IPC method.
    getReadStamp(serverId,tabId) { const ctx=contexts.get(serverId),tab=selected(ctx,tabId);if(!ctx||!tab)return null;const stamp=readStamp(ctx,tab);return stamp===null?null:policyStamp(ctx,tab,stamp); },
    previewConsoleLogs(serverId, options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options) || options.onlyErrors !== undefined && typeof options.onlyErrors !== 'boolean' || options.clear !== undefined && typeof options.clear !== 'boolean') return Promise.resolve(null);
      let capturedThrough = 0;
      return readPage(serverId, (_ctx, tab, stamp) => {
        capturedThrough = tab.console.at(-1)?.sequence || 0;
        const result = tab.console.filter(row => (!options.onlyErrors || row.level === 'error') && (!row.origin || row.origin === stamp.origin))
          .map(({ level, text, timestamp, source }) => ({ level, text, timestamp, ...(source !== undefined ? { source } : {}) }));
        return result;
      }, (_ctx, tab) => { if (options.clear === true) { tab.console = tab.console.filter(row=>row.sequence > capturedThrough); tab.consoleChars = tab.console.reduce((sum,row)=>sum+row.text.length,0); } });
    },
    previewSnapshot(serverId) {
      return readPage(serverId, async (_ctx, tab) => {
        const result = await tab.view.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
        return formatAccessibility(result.nodes, tab.axCounter);
      });
    },
    previewInspect(serverId, selector, styles) {
      if (typeof selector !== 'string' || styles !== undefined && (!Array.isArray(styles) || styles.some(style => typeof style !== 'string'))) return Promise.resolve(null);
      return readPage(serverId, async (_ctx, tab) => {
        const tools = tab.view.webContents.debugger;
        try {
          await tools.sendCommand('DOM.enable'); await tools.sendCommand('CSS.enable');
          const { root } = await tools.sendCommand('DOM.getDocument');
          const { nodeId } = await tools.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
          if (!nodeId) return { found: false };
          const { node } = await tools.sendCommand('DOM.describeNode', { nodeId });
          const attributes = node.attributes || [], attrs = {};
          for (let at = 0; at < attributes.length; at += 2) attrs[attributes[at]] = attributes[at + 1];
          const names = styles || ['color','background-color','font-size','font-weight','padding','margin','width','height','display','visibility'];
          const { computedStyle } = await tools.sendCommand('CSS.getComputedStyleForNode', { nodeId });
          const selectedStyles = {};
          for (const name of names) { const value = computedStyle.find(style => style.name === name)?.value; if (value !== undefined) selectedStyles[name] = value; }
          let boundingBox;
          try { const { model } = await tools.sendCommand('DOM.getBoxModel', { nodeId }); const q = model.content; if (q?.length >= 6) boundingBox = { x: q[0], y: q[1], width: q[2] - q[0], height: q[5] - q[1] }; } catch {}
          const { result } = await tools.sendCommand('Runtime.evaluate', { expression: 'document.querySelector(' + JSON.stringify(selector) + ')?.innerText?.substring(0, 500) || ""', returnByValue: true });
          return { found: true, info: { tagName: node.nodeName.toLowerCase(), text: typeof result?.value === 'string' ? result.value.slice(0,500) : '',
            className: (attrs.class || '').slice(0,200), id: attrs.id || '', ...(attrs.value ? { value: attrs.value } : {}), styles: selectedStyles,
            ...(boundingBox ? { boundingBox } : {}) } };
        } catch { return { found: false }; }
        finally { try { await tools.sendCommand('CSS.disable'); await tools.sendCommand('DOM.disable'); } catch {} }
      });
    },
    navigatePreview,
    getPreviewTabs: serverId => tabs(contexts.get(serverId)),
    getAllSessionPreviewTabs: () => [...contexts.values()].filter(ctx=>ctx.artifactMode !== 'static').map(ctx => ({ serverId: ctx.id, ...tabs(ctx) })),
    getPreviewUrl(serverId) { const tab = selected(contexts.get(serverId)); return alive(tab) ? tab.displayUrl || tab.view.webContents.getURL() || null : null; },
    getPreviewNavState(serverId, tabId) {
      const tab = selected(contexts.get(serverId), tabId); if (!alive(tab)) return null;
      const nav = tab.view.webContents.navigationHistory || tab.view.webContents;
      return { canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward() };
    },
    openPreviewTab(serverId) { const ctx = contexts.get(serverId); return ctx ? openTab(ctx)?.id || null : null; },
    closePreviewTab,
    closeAllPreviewTabs(serverId) {
      const ctx = contexts.get(serverId); if (!ctx) return false;
      for (const id of [...ctx.tabs.keys()].slice(1)) closePreviewTab(serverId, id);
      return true;
    },
    reopenClosedPreviewTab(serverId) {
      const ctx = contexts.get(serverId); if (!ctx || !ctx.closed.length || ctx.tabs.size >= maxTabs) return null;
      const url = ctx.closed.pop(); return openTab(ctx, url)?.id || null;
    },
    reorderPreviewTab(serverId, tabId, index) {
      const ctx = contexts.get(serverId); if (!ctx || !ctx.tabs.has(tabId) || !Number.isInteger(index) || index < 0 || index >= ctx.tabs.size) return false;
      const pairs = [...ctx.tabs]; const old = pairs.findIndex(([id]) => id === tabId); const [row] = pairs.splice(old, 1); pairs.splice(index, 0, row); ctx.tabs = new Map(pairs); changed(ctx); return true;
    },
    setActivePreviewTab(serverId, tabId) {
      const ctx = contexts.get(serverId); if (!ctx || !alive(ctx.tabs.get(tabId))) return false;
      ctx.activeTabId = tabId; attach(ctx); changed(ctx); return true;
    },
    setPreviewMuted(serverId, muted) {
      const ctx = contexts.get(serverId); if (!ctx || typeof muted !== 'boolean') return false;
      ctx.muted = muted; for (const tab of ctx.tabs.values()) { tab.muted = muted; tab.view.webContents.setAudioMuted(muted); } changed(ctx); return true;
    },
    refreshPreview(serverId, tabId) { const ctx=contexts.get(serverId);if(ctx?.rawSource)return refreshRawFile(ctx,true);const tab = selected(ctx, tabId); if (!alive(tab)) return false; tab.lastCapture = null; tab.view.webContents.reload(); return true; },
    goBack: (serverId, tabId) => history(serverId, tabId, 'back'),
    goForward: (serverId, tabId) => history(serverId, tabId, 'forward'),
    showPreview(serverId, bounds, claimantId, targetWindowId) {
      const ctx = contexts.get(serverId);
      if (!ctx || !bounds || !['x','y','width','height'].every(k => Number.isFinite(bounds[k])) || bounds.width < 1 || bounds.height < 1 || bounds.width > 16384 || bounds.height > 16384) return false;
      if (ctx.claimantId !== null && claimantId !== undefined && ctx.claimantId !== claimantId) return false;
      ctx.bounds = Object.fromEntries(['x','y','width','height'].map(k=>[k,Math.round(bounds[k])])); ctx.targetWindowId = targetWindowId; ctx.visible = true;
      const attached = attach(ctx); if (!attached) ctx.visible = false; else if (claimantId !== undefined) ctx.claimantId = claimantId;
      return attached;
    },
    hidePreview(serverId, claimantId, targetWindowId) {
      const ctx = contexts.get(serverId); if (!ctx || claimantId !== undefined && ctx.claimantId !== null && claimantId !== ctx.claimantId || targetWindowId !== undefined && targetWindowId !== ctx.targetWindowId) return false;
      // Native KZ (index.chunk-lzaSYO3Q.js @4900912) releases the claim
      // only after validating owner and target window. React may unmount the
      // pane and reopen it with a new useId claimant.
      ctx.claimantId = null;
      ctx.visible = false;
      for (const tab of ctx.tabs.values()) { try { tab.view.setVisible?.(false); } catch {} }
      detach(ctx); return true;
    },
    setPreviewViewport(serverId, width, height, tabId) {
      const ctx = contexts.get(serverId), tab = selected(ctx, tabId);
      if (!alive(tab) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) return false;
      try {
        tab.view.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height },
          viewPosition: { x: 0, y: 0 }, viewSize: { width, height }, deviceScaleFactor: 0, scale: 1 });
        tab.viewport = { width, height, setBy: 'user' }; tab.lastCapture = null; changed(ctx); return true;
      } catch { return false; }
    },
    clearPreviewViewport(serverId, tabId) {
      const ctx = contexts.get(serverId), tab = selected(ctx, tabId); if (!alive(tab)) return false;
      try { tab.view.webContents.disableDeviceEmulation(); tab.viewport = null; tab.lastCapture = null; changed(ctx); return true; }
      catch { return false; }
    },
    async setPreviewColorScheme(serverId, scheme, tabId) {
      const tab = selected(contexts.get(serverId), tabId); if (!alive(tab) || !['light', 'dark', 'system'].includes(scheme)) return false;
      const tools = tab.view.webContents.debugger; if (!tools || tools.isAttached() && !tab.toolsOwned) return false;
      let temporary = false;
      try { if (!tools.isAttached()) { tools.attach('1.3'); temporary = true; } await tools.sendCommand('Emulation.setEmulatedMedia', { features: scheme === 'system' ? [] : [{ name: 'prefers-color-scheme', value: scheme }] }); tab.lastCapture = null; return true; }
      catch { return false; } finally { if (temporary) { try { tools.detach(); } catch {} } }
    },
    focusPreview(serverId) { const ctx = contexts.get(serverId); const tab = selected(ctx); if (!ctx?.visible || !alive(tab)) return false; tab.view.webContents.focus(); return true; },
    capturePreviewScreenshot: (serverId, tabId) => capture(serverId, tabId, false, false),
    capturePreviewScreenshotIfChanged: (serverId, force) => capture(serverId, undefined, true, force === true),
    destroyPreview,
    teardownRemoteSessionPreview(sessionId) { let removed = false; for (const ctx of [...contexts.values()]) if (ctx.sessionId === sessionId) removed = destroyPreview(ctx.id) || removed; return removed; },
    dispose() { if (disposed) return; disposed = true; for (const id of [...contexts.keys()]) destroyPreview(id); artifacts.dispose(); },
  };
}
module.exports = { createPreviewHost, validUrl };
