'use strict';

const { createHash } = require('node:crypto');

function shortenId(value) {
  if (value.length <= 64) return value;
  let end = 47;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${value.slice(0, end)}~${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function attributionOf(value) {
  if (value == null) return undefined;
  const sessionId = typeof value.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId) ? value.sessionId : undefined;
  const sessionGroupingId = typeof value.sessionGroupingId === 'string' && /^(?:sgrp|chan)_[A-Za-z0-9_-]{1,64}$/.test(value.sessionGroupingId) ? value.sessionGroupingId : undefined;
  return sessionId !== undefined || sessionGroupingId !== undefined ? { sessionId, sessionGroupingId } : undefined;
}

function groupFor(tag, attribution) {
  if (!attribution) return undefined;
  const { sessionId, sessionGroupingId } = attribution;
  if (tag === undefined) return sessionGroupingId ? `group-${sessionGroupingId}` : sessionId ? `session-${sessionId}` : undefined;
  if (sessionGroupingId && tag.includes(sessionGroupingId)) return `group-${sessionGroupingId}`;
  if (sessionId && tag.includes(sessionId)) return `session-${sessionId}`;
}

function createNotificationService({ Notification, getAppIcon = () => null, onResult = () => {}, onNavigate = () => {}, now = Date.now, silent = false, getSilent = () => silent, getNotificationLevel = () => 'banner', notifiedElsewhere = () => false }) {
  const active = new Map();
  const callbacks = new Map();
  let sequence = 0;
  let appIcon = null;
  function loadAppIcon() {
    if (appIcon) return appIcon;
    try {
      appIcon = getAppIcon();
      if (appIcon?.isEmpty()) appIcon = null;
    } catch { appIcon = null; }
    return appIcon;
  }
  const report = (event, error, context) => {
    try { onResult(event, error, context); } catch { /* Diagnostics must not affect IPC. */ }
  };
  function show(title, body, tag, navigateTo, type = 'generic', rawAttribution) {
    const attribution = attributionOf(rawAttribution);
    const notificationType = ['remote_idle', 'remote_turn_complete', 'remote_requires_action', 'channel_message'].includes(type) ? type : 'generic';
    if (attribution?.sessionId !== undefined && notifiedElsewhere(attribution.sessionId)) return;
    const context = { notificationType, ...attribution };
    const callbackKey = tag ?? `notification-${now()}`;
    const remote = ['remote_idle', 'remote_turn_complete', 'remote_requires_action'].includes(notificationType);
    if (remote && getNotificationLevel(notificationType === 'remote_requires_action' ? 'permission' : 'idle') !== 'banner') return;
    const callback = navigateTo ? () => onNavigate(navigateTo, context) : undefined;
    if (callback) callbacks.set(callbackKey, callback);
    let note;
    let key;
    let reported = false;
    const reportOnce = (event, error) => {
      if (!reported) { reported = true; report(event, error, context); }
    };
    const cleanup = () => { if (active.get(key) === note) active.delete(key); };
    const failure = error => {
      if (callbacks.get(callbackKey) === callback) callbacks.delete(callbackKey);
      cleanup();
      reportOnce('failed', error);
    };
    try {
      if (!Notification || !Notification.isSupported()) {
        if (callbacks.get(callbackKey) === callback) callbacks.delete(callbackKey);
        reportOnce('unsupported');
        return;
      }
      key = callbackKey || `notification-${now()}-${++sequence}`;
      const previous = active.get(key);
      if (callbackKey && previous) { previous.close(); if (active.get(key) === previous) active.delete(key); }
      const group = groupFor(tag, attribution);
      const icon = loadAppIcon();
      note = new Notification({ title, body, silent: notificationType === 'remote_turn_complete' || getSilent(), urgency: notificationType === 'remote_turn_complete' ? 'low' : 'normal', id: shortenId(key), ...(group ? { groupId: shortenId(group), groupTitle: title } : {}), ...(icon ? { icon } : {}) });
      active.set(key, note);
      note.once('show', () => reportOnce('show'));
      note.once('failed', (_event, error) => { if (!reported) failure(error); });
      note.on('close', cleanup);
      note.on('click', () => {
        if (callback) {
          const current = callbacks.get(callbackKey);
          if (current) { current(); callbacks.delete(callbackKey); }
        }
        cleanup();
      });
      note.show();
    } catch (error) { failure(error); }
  }
  return { show, activeCount: () => active.size };
}

module.exports = { createNotificationService };
