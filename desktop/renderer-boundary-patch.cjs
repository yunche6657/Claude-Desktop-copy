'use strict';
const { safeRendererError } = require('./renderer-error-log.cjs');
const LABEL = '[SESSION_RENDER_ERROR]';
const NEEDLE = 'componentDidCatch(e){this.props.onError?.(e),!this.hasCaptured&&';
// Sanitization runs before console emission; the main-process sink sanitizes again.
const INJECT = String.raw`try{if(this.props.componentName==='EpitaxyChatPanel'){const frames=String(e?.stack||'').match(/app:\/\/localhost\/assets\/v1\/[A-Za-z0-9_.-]+\.js:\d+:\d+/g)||[];console.error('${LABEL}',JSON.stringify({componentName:this.props.componentName,errorName:/^(Error|TypeError|RangeError|ReferenceError|SyntaxError|ChunkLoadError|URIError|EvalError)$/.test(e?.name)?e.name:'Error',stack:frames.slice(0,24).join('\\n'),route:location.pathname,sessionId:this.props.metadata?.sessionId}))}}catch{};`;
function patchRendererBoundary(source) {
  if (source.includes(LABEL)) return { text: source, changed: false, alreadyApplied: true };
  if (source.split(NEEDLE).length !== 2) return { text: source, changed: false };
  return { text: source.replace(NEEDLE, 'componentDidCatch(e){' + INJECT + 'this.props.onError?.(e),!this.hasCaptured&&'), changed: true };
}
function parseRendererBoundaryConsole(message) {
  if (typeof message !== 'string' || !message.startsWith(LABEL)) return null;
  try { return safeRendererError(JSON.parse(message.slice(LABEL.length).trim())); } catch { return null; }
}
module.exports = { patchRendererBoundary, parseRendererBoundaryConsole, LABEL };
