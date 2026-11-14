'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');

function versionParts(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('版本必须为稳定版 x.y.z');
  const parts = value.split('.').map(Number);
  if (parts.some(n => !Number.isSafeInteger(n))) throw new Error('版本超出范围');
  return parts;
}
function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
function checkedUrl(input, allowLoopbackHttp = false) {
  const u = new URL(input);
  if (u.username || u.password || u.hash) throw new Error('更新 URL 不接受凭据或片段');
  if (u.protocol !== 'https:' && !(allowLoopbackHttp && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('更新源必须使用 HTTPS');
  return u;
}
function requestStream(input, { allowLoopbackHttp = false, redirects = 0, origin } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = checkedUrl(input, allowLoopbackHttp); } catch (e) { reject(e); return; }
    // All redirects stay on the initial origin. No cookies, authorization, or ambient session.
    if (origin && u.origin !== origin) { reject(new Error('更新重定向跨越源站')); return; }
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers: { Accept: '*/*', 'Accept-Encoding': 'identity' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location || redirects >= 3) { reject(new Error('更新重定向无效或过多')); return; }
        let next;
        try { next = new URL(res.headers.location, u).href; } catch (e) { reject(e); return; }
        requestStream(next, { allowLoopbackHttp, redirects: redirects + 1, origin: origin || u.origin }).then(resolve, reject);
      } else if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        res.resume(); reject(new Error(`更新服务器响应无效 (${res.statusCode})`));
      } else resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('更新请求超时')));
    req.on('error', reject);
  });
}
function validateManifest(m, currentVersion, platform, arch, allowLoopbackHttp) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('更新 manifest 无效');
  versionParts(m.version);
  if (compareVersions(m.version, currentVersion) < 0) throw new Error('更新源版本低于当前版本');
  if (m.platform !== platform || m.arch !== arch || platform !== 'win32' || m.installer !== 'nsis') throw new Error('更新安装包平台、架构或安装方式不匹配');
  if (!Number.isSafeInteger(m.size) || m.size <= 0 || m.size > 2 * 1024 ** 3) throw new Error('更新安装包大小无效');
  if (!/^[a-f0-9]{64}$/i.test(m.sha256 || '')) throw new Error('更新安装包 SHA-256 无效');
  const url = checkedUrl(m.url, allowLoopbackHttp);
  if (!url.pathname.toLowerCase().endsWith('.exe')) throw new Error('NSIS 安装包扩展名必须为 .exe');
  return { version: m.version, platform: m.platform, arch: m.arch, installer: 'nsis', url: url.href, size: m.size, sha256: m.sha256.toLowerCase() };
}
function verifyWindowsSignature(file) {
  return new Promise((resolve, reject) => {
    const script = '$s=Get-AuthenticodeSignature -LiteralPath $env:CCD_UPDATE_FILE; @{status=[string]$s.Status; thumbprint=[string]$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000, env: { ...process.env, CCD_UPDATE_FILE: file } }, (error, stdout) => {
      if (error) return reject(new Error('安装包签名检查失败'));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error('安装包签名检查输出无效')); }
    });
  });
}
class UpdateService extends EventEmitter {
  constructor({ source = '', currentVersion, directory, platform = process.platform, arch = process.arch, signerThumbprint = '', allowLoopbackHttp = false, verifySignature = verifyWindowsSignature, launchInstaller } = {}) {
    super();
    Object.assign(this, { source, currentVersion, directory, platform, arch, allowLoopbackHttp, verifySignature });
    versionParts(currentVersion);
    this.signerThumbprint = signerThumbprint.replace(/\s/g, '').toUpperCase();
    this.configurationError = this.signerThumbprint && !/^[A-F0-9]{40}$/.test(this.signerThumbprint) ? '签名证书指纹必须为 40 位十六进制' : '';
    this.launchInstaller = launchInstaller || (file => new Promise((resolve, reject) => {
      const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    }));
    this.state = { status: source ? 'idle' : 'manual', currentVersion, message: source ? '点击检查更新' : '未配置更新源，请手动更新', progress: 0, canInstall: false };
    this.busy = false;
  }
  getState() { return { ...this.state }; }
  setState(patch) { Object.assign(this.state, patch); this.emit('state', this.getState()); return this.getState(); }
  async operation(fn) {
    if (this.busy) return this.getState();
    this.busy = true;
    try { return await fn(); } catch (error) { return this.setState({ status: 'error', message: error.message, canInstall: false }); }
    finally { this.busy = false; }
  }
  check() {
    return this.operation(async () => {
      if (!this.source) return this.setState({ status: 'manual', message: '未配置更新源，请手动更新' });
      if (this.configurationError) throw new Error(this.configurationError);
      this.manifest = null; this.file = null;
      this.setState({ status: 'checking', message: '正在检查更新', canInstall: false, progress: 0 });
      const response = await requestStream(this.source, this);
      const chunks = []; let size = 0;
      for await (const chunk of response) { size += chunk.length; if (size > 64 * 1024) { response.destroy(); throw new Error('更新 manifest 过大'); } chunks.push(chunk); }
      this.manifest = validateManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.currentVersion, this.platform, this.arch, this.allowLoopbackHttp);
      const available = compareVersions(this.manifest.version, this.currentVersion) > 0;
      return this.setState({ status: available ? 'available' : 'current', version: this.manifest.version, message: available ? `发现新版本 ${this.manifest.version}，点击下载` : '当前已是最新版本' });
    });
  }
  download() {
    return this.operation(async () => {
      if (!this.manifest || compareVersions(this.manifest.version, this.currentVersion) <= 0) throw new Error('请先检查可用新版本');
      const m = this.manifest;
      await fsp.mkdir(this.directory, { recursive: true });
      const destination = path.join(this.directory, `update-${m.version}-${crypto.randomUUID()}.exe`);
      const partial = destination + '.part';
      let handle;
      try {
        this.setState({ status: 'downloading', message: '正在下载更新', progress: 0, received: 0, total: m.size, canInstall: false });
        const response = await requestStream(m.url, this);
        if (response.headers['content-length'] && Number(response.headers['content-length']) !== m.size) { response.destroy(); throw new Error('安装包响应长度不匹配'); }
        handle = await fsp.open(partial, 'wx');
        const hash = crypto.createHash('sha256'); let received = 0;
        for await (const chunk of response) {
          received += chunk.length;
          if (received > m.size) { response.destroy(); throw new Error('安装包超过声明大小'); }
          hash.update(chunk); await handle.writeFile(chunk);
          this.setState({ received, progress: received / m.size });
        }
        await handle.close(); handle = null;
        if (received !== m.size || hash.digest('hex') !== m.sha256) throw new Error('安装包摘要或大小校验失败');
        const signature = await this.verifySignature(partial);
        const canInstall = signature.status === 'Valid' && !!this.signerThumbprint && signature.thumbprint?.toUpperCase() === this.signerThumbprint;
        if (this.signerThumbprint && !canInstall) throw new Error('安装包签名与固定发布证书不匹配');
        await fsp.rename(partial, destination); this.file = destination;
        return this.setState({ status: 'downloaded', progress: 1, signature: signature.status, canInstall, message: canInstall ? '校验完成，可以运行安装程序' : '摘要校验完成；未固定签名证书，请手动检查并运行安装程序' });
      } catch (e) { if (handle) await handle.close().catch(() => {}); await fsp.rm(partial, { force: true }).catch(() => {}); throw e; }
    });
  }
  install() {
    return this.operation(async () => {
      if (!this.file || !this.state.canInstall) throw new Error('尚无通过发布证书验证的安装包');
      const hash = crypto.createHash('sha256'); let size = 0;
      for await (const chunk of fs.createReadStream(this.file)) { size += chunk.length; hash.update(chunk); }
      if (size !== this.manifest.size || hash.digest('hex') !== this.manifest.sha256) throw new Error('安装前摘要复核失败');
      const s = await this.verifySignature(this.file);
      if (s.status !== 'Valid' || s.thumbprint?.toUpperCase() !== this.signerThumbprint) throw new Error('安装前签名复核失败');
      await this.launchInstaller(this.file);
      return this.setState({ status: 'installing', message: '安装程序已启动，请按安装向导操作' });
    });
  }
}
module.exports = { UpdateService, compareVersions, checkedUrl, requestStream, validateManifest, verifyWindowsSignature };
