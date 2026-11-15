'use strict';
const { EventEmitter } = require('node:events');
const { requestStream, compareVersions } = require('./update-service.cjs');
const REPOSITORY = 'yunche6657/Claude-Desktop-copy';
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

function releaseState(release, currentVersion, platform, arch) {
  if (!release || release.draft || release.prerelease || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name || '')) throw new Error('GitHub 最新稳定版信息无效');
  const version = release.tag_name.replace(/^v/, '');
  const releaseUrl = `${RELEASES_URL}/tag/v${version}`;
  const available = compareVersions(version, currentVersion) > 0;
  const asset = (release.assets || []).find(a => a.name === `Xiaoke-${version}-${arch}.exe` && a.state === 'uploaded');
  const expected = `https://github.com/${REPOSITORY}/releases/download/v${version}/Xiaoke-${version}-${arch}.exe`;
  if (available && (platform !== 'win32' || !asset || asset.browser_download_url !== expected)) throw new Error('新版尚未提供当前平台的完整安装包，请稍后重试');
  return { status: available ? 'available' : 'current', currentVersion, version,
    message: available ? `发现新版本 ${version}` : `当前已是最新版本（${currentVersion}）`,
    releaseUrl, downloadUrl: available ? expected : null,
    notes: typeof release.body === 'string' ? release.body.slice(0, 8000) : '',
    downloadMode: 'browser', progress: 0, canInstall: false };
}

class GitHubUpdateService extends EventEmitter {
  constructor({ currentVersion, platform = process.platform, arch = process.arch, fetchRelease } = {}) {
    super();
    Object.assign(this, { currentVersion, platform, arch });
    compareVersions(currentVersion, currentVersion);
    this.fetchRelease = fetchRelease || (async () => {
      const response = await requestStream(API_URL);
      const chunks = []; let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 512 * 1024) { response.destroy(); throw new Error('GitHub 发布信息过大'); }
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    });
    this.state = { status: 'idle', currentVersion, message: '点击检查更新', progress: 0, canInstall: false };
  }
  getState() { return { ...this.state }; }
  setState(state) { this.state = state; this.emit('state', this.getState()); return this.getState(); }
  async check() {
    if (this.pending) return this.pending;
    this.setState({ status: 'checking', currentVersion: this.currentVersion, message: '正在检查 GitHub 最新版本', progress: 0, canInstall: false });
    this.pending = (async () => {
      try { return this.setState(releaseState(await this.fetchRelease(), this.currentVersion, this.platform, this.arch)); }
      catch { return this.setState({ status: 'error', currentVersion: this.currentVersion, message: '检查更新失败，请检查网络后重试，或打开 GitHub 发布页。', releaseUrl: RELEASES_URL, progress: 0, canInstall: false }); }
      finally { this.pending = null; }
    })();
    return this.pending;
  }
}
module.exports = { GitHubUpdateService, releaseState, API_URL, RELEASES_URL };
