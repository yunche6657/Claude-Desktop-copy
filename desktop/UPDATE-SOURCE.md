# Windows NSIS 更新源

从 0.2.9 起，应用菜单“检查更新…”、Ctrl+Shift+U 和现有 AutoUpdater.checkForUpdates 桥接默认查询 yunche6657/Claude-Desktop-copy 的 GitHub 最新稳定版。发现新版后显示发布说明，可打开浏览器下载对应架构安装器，再运行安装向导；查询失败可打开固定 GitHub 发布页。默认流程无需环境变量，不在后台下载或静默安装。0.2.8 用户需要手动安装一次 0.2.9 才能获得这个入口。

以下自托管 manifest 流程仅在设置 CCD_UPDATE_MANIFEST_URL 时覆盖默认 GitHub 检查。

启动应用前配置环境变量：

```powershell
$env:CCD_UPDATE_MANIFEST_URL = 'https://YOUR_HOST/releases/update-win32-x64.json'
$env:CCD_UPDATE_SIGNER_SHA1 = 'YOUR_40_HEX_AUTHENTICODE_CERTIFICATE_THUMBPRINT'
```

URL 必须是实际部署的 HTTPS 地址。应用不使用 Electron 登录会话、不携带 Cookie/Authorization、不接受 URL 凭据，仅允许同源、最多三次重定向。HTTP 只在单元测试显式启用且目标为 127.0.0.1 或 ::1 时可用；生产入口未开启此选项。

manifest 格式：

```json
{
  "version": "0.2.0",
  "platform": "win32",
  "arch": "x64",
  "installer": "nsis",
  "url": "https://YOUR_HOST/releases/setup-0.2.0-x64.exe",
  "size": 123456789,
  "sha256": "64_HEX_SHA256_OF_FINAL_SIGNED_INSTALLER"
}
```

仅接受稳定版三段数字版本、高于当前版本才开放下载；低版本报错。平台/架构必须匹配运行应用，安装方式必须 NSIS。manifest 上限 64 KiB，安装包上限 2 GiB。用户确认后下载到 userData/updates 的随机文件名，流式校验长度及 SHA-256，错误删除 .part。下载进度通过 updaterStateStore.StateChange 事件和 Windows 任务栏显示。请求闲置 30 秒超时；当前未实现取消、断点续传、差分下载及后台定时检查。

下载后使用 Windows PowerShell Get-AuthenticodeSignature 检查最终文件。只有系统签名状态 Valid 且签名证书 SHA-1 指纹等于固定配置，才开放“运行安装程序”。无固定证书时可下载并在文件夹中查看，由用户手动检查/执行。证书指纹不是 manifest 声明，避免更新源自行替换信任证书。

安装前再次流式检查摘要、长度与签名，然后启动交互式 NSIS 安装向导。应用不自行覆盖当前目录、不静默退出，用户按向导操作并重新启动；网络、校验、启动失败均保留当前版本。NSIS 安装进行过程由安装器负责，应用不宣称事务回滚或安装成功检测。证书续期需更改固定指纹配置。

打包完成并完成最终签名后生成 manifest：

```powershell
node tools/release-update-manifest.cjs "release/小克-0.2.0-x64.exe" 0.2.0 "https://YOUR_HOST/releases/小克-0.2.0-x64.exe"
```

该工具保留安装器，在相邻目录原子写入 update-win32-x64.json。上传安装器与 manifest 由发布者配置自己的 HTTPS 托管；仓库没有默认发布服务，也不自动提交/上传。实际发布时先上传安装器，再替换 manifest。签名必须在摘要生成前完成。

测试：`npm test -- test/update-service.test.mjs`。测试使用 HTTP loopback fixture、伪安装器字节及注入签名器/启动器；未执行真实更新安装、外部 HTTPS 托管或真实证书校验端到端流程。
