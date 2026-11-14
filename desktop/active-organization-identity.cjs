'use strict';

// readOrganization must return an account-bound authoritative snapshot:
// {accountId, orgId, isCurrent()}. A cookie by itself does not establish ownership.
function createActiveOrganizationIdentity({ accountStore, readOrganization }) {
  if (typeof accountStore?.getActiveAccountContext !== 'function' || typeof readOrganization !== 'function') {
    throw new TypeError('accountStore and readOrganization are required');
  }
  const same = (a, b) => !!a && !!b && a.accountId === b.accountId &&
    a.storeId === b.storeId && a.revision === b.revision;
  async function acquire() {
    try {
      const before = accountStore.getActiveAccountContext();
      if (!before) return null;
      const source = await readOrganization(Object.freeze({ ...before }));
      const accountId = source?.accountId, orgId = source?.orgId;
      if (accountId !== before.accountId || typeof orgId !== 'string' || !orgId ||
          typeof source?.isCurrent !== 'function') return null;
      const isCurrent = () => {
        try { return same(before, accountStore.getActiveAccountContext()) && source.isCurrent() === true &&
          source.accountId === accountId && source.orgId === orgId; } catch { return false; }
      };
      return isCurrent() ? Object.freeze({ accountId, orgId, isCurrent }) : null;
    } catch { return null; }
  }
  return { acquire };
}
module.exports = { createActiveOrganizationIdentity };
