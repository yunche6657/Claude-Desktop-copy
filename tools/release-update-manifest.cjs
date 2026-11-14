#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkedUrl, versionParts, validateManifest } = require('../desktop/update-service.cjs');
async function writeReleaseManifest({ installer, version, url, arch = 'x64', output }) {
  const resolved = path.resolve(installer);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || !resolved.toLowerCase().endsWith('.exe')) throw new Error('Expected an NSIS .exe file');
  checkedUrl(url);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(resolved)) hash.update(chunk);
  const manifest = validateManifest({ version, platform: 'win32', arch, installer: 'nsis', url, size: stat.size, sha256: hash.digest('hex') }, version, 'win32', arch, false);
  const target = path.resolve(output || path.join(path.dirname(resolved), `update-win32-${arch}.json`));
  const temp = target + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(temp, target);
  return { manifest: target, installer: resolved };
}
if (require.main === module) {
  const [installer, version, url, output] = process.argv.slice(2);
  if (!installer || !version || !url) { console.error('Usage: node tools/release-update-manifest.cjs INSTALLER VERSION HTTPS_INSTALLER_URL [OUTPUT]'); process.exitCode = 1; }
  else writeReleaseManifest({ installer, version, url, output }).then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { writeReleaseManifest };
