'use strict';

// Users paste gateway addresses the way they write them by hand: `127.0.0.1:7863`,
// `localhost:8080`, `//host:port`. `new URL()` rejects the first two outright — and
// `localhost:7863` is worse, because it parses as scheme "localhost:" with an empty
// host, so the failure is not even a throw at the same place. Both were reported from
// the settings page as an "embedded credentials" error, which named the wrong cause.
//
// A missing scheme is a formatting detail, not a reason to reject the address, so it is
// filled in here. Embedded credentials stay rejected: those really are invalid.
const HOST_WITH_PORT = /^[^/\s:]+:\d+(?:[/?#]|$)/;

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('base_url_required');
  let text = value.trim();
  if (text.startsWith('//')) text = `http:${text}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // `host:port` and `host` are assumed to be local gateways. A bare `scheme:opaque`
    // value (mailto:, data:) also lands here, but it has no host and is rejected below.
    if (!HOST_WITH_PORT.test(text) && /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^\d/.test(text)) throw new Error('unsupported_protocol');
    text = `http://${text}`;
  }
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('http_url_required');
  }
  return url;
}

module.exports = { normalizeBaseUrl };
