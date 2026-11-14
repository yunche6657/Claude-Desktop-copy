// Backend proxying for the shipped frontend.
//
// Observed in the shipped bundle's custom-3p protocol handler:
//
//   let n = t.pathname,
//       r = n.startsWith("/edge-api/") ? `/api/${n.slice(10)}` : n,
//       i = Jgn(e, r, t.search);        // local interception
//   if (i) return i;
//   ... o = Chn(..., r) ...            // overlay / local handling
//   ... a.net.fetch(backendUrl, { method, headers, body, bypassCustomProtocolHandlers: true })
//
// So every /edge-api/<rest> request is rewritten to /api/<rest> and forwarded
// to the configured host, while any other path is forwarded unchanged. This
// module reproduces the rewrite and the forward, and nothing else: no
// interception table, no overlay.
//
// Without a configured host the proxy answers 503 for API paths, which is the
// shape the frontend already handles (its offline state), instead of an
// unhandled protocol error.
'use strict';

/** Strip the /edge-api prefix the way the shipped handler does. */
function rewriteApiPath(pathname) {
  if (typeof pathname !== 'string') return pathname;
  return pathname.startsWith('/edge-api/') ? `/api/${pathname.slice(10)}` : pathname;
}

/** True for paths that belong to the backend rather than to the static bundle. */
function isBackendPath(pathname) {
  if (typeof pathname !== 'string') return false;
  return (
    pathname.startsWith('/edge-api/') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/web-api/') ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/v2/') ||
    pathname.startsWith('/oauth/') ||
    pathname.startsWith('/claudeai-rpc/') ||
    pathname.startsWith('/mcp-registry/')
  );
}

/**
 * Build a forwarder.
 * @param {{
 *   backendOrigin: string|null,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   onForward?: (info: object) => void,
 * }} opts
 */
function createBackendProxy({ backendOrigin, fetchImpl, timeoutMs = 20000, onForward }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const note = (info) => { if (onForward) { try { onForward(info); } catch {} } };

  /** @returns {Promise<Response>} */
  return async function forward(request) {
    const url = new URL(request.url);
    if (!backendOrigin) {
      note({ path: url.pathname, status: 503, reason: 'no-backend' });
      return new Response(JSON.stringify({ error: 'no_backend_configured' }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const target = new URL(rewriteApiPath(url.pathname) + url.search, backendOrigin);

    const init = { method: request.method, headers: new Headers(request.headers) };
    // The backend is a different origin; the app:// one must not leak through.
    init.headers.delete('origin');
    init.headers.delete('referer');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    init.signal = controller.signal;

    try {
      const upstream = await doFetch(target.toString(), init);
      note({ path: url.pathname, forwardedTo: target.pathname, status: upstream.status });
      // Stream the body through untouched so SSE works.
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (error) {
      note({ path: url.pathname, status: 502, reason: error && error.name });
      return new Response(JSON.stringify({ error: 'backend_unreachable', detail: String(error && error.message) }), {
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { rewriteApiPath, isBackendPath, createBackendProxy };
