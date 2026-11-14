'use strict';

const signals = {
  off: Object.freeze({ banner: false, badge: false }),
  badge: Object.freeze({ banner: false, badge: true }),
  banner: Object.freeze({ banner: true, badge: true }),
};
const defaultSignals = Object.freeze({ banner: true, badge: false });

// setPreference replaces the bag, so read it anew for every notification.
function createNotificationPolicy({ getPreferences, getFeatureValue = () => false }) {
  function getSignals(key) {
    const value = getPreferences()?.notificationLevels?.[key];
    if (value === undefined) return getFeatureValue('879583975', false) ? signals.banner : defaultSignals;
    return signals[value];
  }
  return {
    getSignals,
    getNotificationLevel: key => {
      const value = getSignals(key);
      return value?.banner ? 'banner' : value?.badge ? 'badge' : 'off';
    },
    getSilent: () => getPreferences()?.notificationSound === 'none',
  };
}

module.exports = { createNotificationPolicy };
