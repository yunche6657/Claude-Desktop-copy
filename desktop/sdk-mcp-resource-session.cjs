'use strict';

// Experimental host-owned SDK endpoint; it does not attach to a CCB-owned server.
function createSdkResourceSession({ dispatch, notifyClient = () => {} }) {
  let closed = false, nextId = 0;
  const pending = new Map();
  async function request(origin, message) {
    if (closed) throw Error('SDK session closed');
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw Error('invalid request');
    if (!Object.hasOwn(message, 'id')) {
      let forwarded = message;
      if (message.method === 'notifications/cancelled') {
        // Let earlier queued requests reach the endpoint before their cancellation.
        await Promise.resolve();
        if (closed) throw Error('SDK session closed');
        const matches = [...pending.entries()].filter(([, item]) => item.origin === origin && item.originalId === message.params?.requestId);
        if (matches.length !== 1) return null;
        forwarded = { ...message, params: { ...message.params, requestId: matches[0][0] } };
      }
      await dispatch(forwarded, origin);
      return null;
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, origin, originalId: message.id });
      Promise.resolve().then(() => {
        if (!pending.has(id)) return;
        return dispatch({ ...message, id }, origin, message.id);
      }).then(response => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (!response || response.jsonrpc !== '2.0' || response.id !== id) return entry.reject(Error('invalid response'));
        entry.resolve({ ...response, id: message.id });
      }, error => {
        const entry = pending.get(id);
        if (entry) { pending.delete(id); entry.reject(error); }
      });
    });
  }
  return {
    ccb(message) { return request('ccb', message); },
    read(uri, id = 1) { return request('host', { jsonrpc: '2.0', id, method: 'resources/read', params: { uri } }); },
    notification(message) { if (closed) throw Error('SDK session closed'); return notifyClient(message); },
    close() { if (closed) return; closed = true; for (const item of pending.values()) item.reject(Error('SDK session closed')); pending.clear(); },
  };
}
module.exports = { createSdkResourceSession };
