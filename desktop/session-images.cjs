'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createSessionFileAccess } = require('./session-file-access.cjs');
// Native file helper: index.chunk-Bn6onBlX.js @999677 / @1003085.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.bmp':'image/bmp', '.avif':'image/avif', '.svg':'image/svg+xml' };
function userContent(message, images) {
  const content = [{ type:'text', text:String(message ?? '') }];
  if (images === undefined || images === null) return content;
  if (!Array.isArray(images)) throw new TypeError('images must be an array');
  for (const image of images) {
    if (!image || typeof image.base64 !== 'string' || typeof image.mimeType !== 'string'
      || !image.mimeType.startsWith('image/') || !image.base64.length
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) {
      throw new TypeError('Invalid image attachment');
    }
    content.push({ type:'image', source:{ type:'base64', media_type:image.mimeType, data:image.base64 } });
  }
  return content;
}
function createSessionImages({ getSession, mediaProtocol = null }) {
  const media = mediaProtocol || require('./session-media-protocol.cjs').createSessionMediaProtocol({ getSession });
  const access = createSessionFileAccess({ getSession });
  async function readSessionImageAsDataUrl(sessionId, requested) {
    const target = await access.resolveForReveal(sessionId, requested);
    if (!target) return null;
    const mime = IMAGE_MIME[path.extname(target.path).toLowerCase()];
    if (!mime) return null;
    let file;
    try {
      file = await fs.promises.open(target.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
      // Re-resolve after opening: reject a substituted parent/root before returning bytes.
      const confirmed = await access.resolveForReveal(sessionId, requested);
      if (!confirmed || confirmed.path !== target.path) return null;
      const bytes = Buffer.alloc(stat.size + 1);
      let used = 0;
      while (used < bytes.length) {
        const read = await file.read(bytes, used, bytes.length - used, null);
        if (!read.bytesRead) break;
        used += read.bytesRead;
      }
      if (used > MAX_IMAGE_BYTES || used > stat.size) return null;
      return 'data:' + mime + ';base64,' + bytes.subarray(0, used).toString('base64');
    } catch { return null; }
    finally { if (file) await file.close().catch(() => {}); }
  }
  return { readSessionImageAsDataUrl, getSessionImageStreamUrl:(sessionId,requested)=>media.mintImageUrl(sessionId,requested), mediaProtocol:media };
}
module.exports = { userContent, createSessionImages, MAX_IMAGE_BYTES, IMAGE_MIME };
