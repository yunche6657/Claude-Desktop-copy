'use strict';

// The host must exclude all writers and keep the kernel stopped through commit.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {installStagedTranscript} = require('./history-import-install.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function createHistoryImportResume({host}) {
  if (!host || typeof host.runExclusive !== 'function') throw new TypeError('Trusted exclusive host required');
  async function confirm(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return {status:'invalid'};
    return host.runExclusive(async lease => {
      if (!lease || ['read','isCurrent','commit'].some(name => typeof lease[name] !== 'function')) throw new TypeError('Invalid host lease');
      const record = await lease.read(sessionId);
      if (!record || record.sessionId !== sessionId || record.importedFrom !== 'terminalCli' || record.resumeConfirmed ||
          !UUID.test(record.cliSessionId || '') || !SHA256.test(record.sha256 || '') ||
          ![record.cwd,record.homeDir,record.stagingRoot,record.stagingPath,record.projectDir].every(v => typeof v === 'string' && path.isAbsolute(v))) return {status:'invalid'};
      const current = async () => await lease.isCurrent(record) === true;
      if (!await current()) return {status:'stale'};
      const staged = await fs.readFile(record.stagingPath);
      if (staged.length > 64 * 1024 * 1024 || crypto.createHash('sha256').update(staged).digest('hex') !== record.sha256) return {status:'digest-mismatch'};
      let receiptPath;
      if (typeof lease.preparePublication === 'function') {
        const publication = await lease.preparePublication(record);
        if (!publication || typeof publication.receiptPath !== 'string' || !await current()) return {status:'stale'};
        receiptPath = publication.receiptPath;
      }
      const installed = await installStagedTranscript({...record,isCurrent:current,receiptPath});
      if (installed.status !== 'installed') return installed;
      // A published file may now belong to a different owner; leave it intact.
      if (installed.sha256 !== record.sha256 || !await current()) return {status:'installed-stale'};
      const result = await lease.commit(record, {targetPath:installed.targetPath,sha256:installed.sha256,isCurrent:current});
      return result === true ? {status:'confirmed',targetPath:installed.targetPath} : {status:'installed-unconfirmed'};
    });
  }
  return {confirm};
}
module.exports = {createHistoryImportResume};
