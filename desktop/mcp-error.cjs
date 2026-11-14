'use strict';

// Desktop's M4/eKe projection retains the URL origin while removing its path,
// query, fragment and credentials from connector errors.
function formatMcpError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/(?<![a-z0-9+.-])([0-9+.-]*)([a-z][a-z0-9+.-]*:\/\/\S+)/gi, (match, prefix, url) => {
    try { return prefix + new URL(url).origin; }
    catch { return `${prefix}<url>`; }
  });
}

module.exports = { formatMcpError };
