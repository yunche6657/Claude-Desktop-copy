'use strict';

// Fixed desktop QRt redacts internal grants before exposing preferences.
function publicPreferences(preferences) {
  const result = { ...preferences };
  for (const key of ['launchPreviewPrivateNetworkReadOrigins','launchPreviewPrivateNetworkTrustedOrigins',
    'launchPreviewAllowedDomainTransitions','remoteFolderConsentFromSettings','remoteChatFolderAdoptionChecked',
    'ccSshHostToolGrants','simulatorAccessibilityAutomationAsserted','simulatorAppAccessibilityAsserted',
    'growthBookHybridAuthedOrigins']) result[key] = [];
  for (const key of ['launchPreviewPrivateNetworkReadPins','launchPreviewPrivateNetworkTrustPins',
    'remoteSessionFolderGrants','remoteChatFolderGrants','remoteChatFolderAccessReports','routineFolderGrants',
    'coworkHasBoundRoutineSeeded','simulatorDeviceConsent']) result[key] = {};
  result.coworkLegacyRootGrantsPruned = false;
  result.selfHostedGrantsHost = '';
  result.ancientJournal = 'stable';
  if (result.hushedHeronKey && typeof result.hushedHeronKey === 'object') {
    result.hushedHeronKey = { accelerator: result.hushedHeronKey.accelerator };
  }
  return result;
}
module.exports = { publicPreferences };
