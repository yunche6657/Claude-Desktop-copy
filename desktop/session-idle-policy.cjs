'use strict';

// This reproduces the desktop policy only. The caller supplies the feature source.
function resolveIdleTimeout({ unattended }, readFeatureValue = (_key, fallback) => fallback) {
  if (unattended) return 900000;
  const value = readFeatureValue('4041267332', null);
  return typeof value !== 'number' || Number.isNaN(value) || value <= 0
    ? 0
    : Math.min(Math.max(Math.round(value), 60000), 2 ** 31 - 1);
}

module.exports = { resolveIdleTimeout };
