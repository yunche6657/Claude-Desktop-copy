# 小克 · Code Desktop Reconstruction

基于 Electron 的独立桌面编程工作区重建项目，当前版本 **0.2.8**。包含 Code / Cowork 会话桥接、本地执行、模型网关、MCP 接入、会话持久化与 Windows 安装器构建工具。

本项目与 Anthropic 无隶属关系。Claude 等名称与商标属于其各自所有者。

## 下载安装（Windows x64）

**[下载小克 0.2.8 完整安装器](https://github.com/yunche6657/Claude-Desktop-copy/releases/download/v0.2.8/Xiaoke-0.2.8-x64.exe)** · [发布说明与 SHA-256](https://github.com/yunche6657/Claude-Desktop-copy/releases/tag/v0.2.8)

运行安装器并启动“小克”，随后在应用设置中配置自己的模型网关、API Key 和模型。无需安装 Node.js、npm、Electron 或 Bun。安装包已包含完整桌面前端（Code / Cowork）与代理运行时；不含发布者的账号和聊天历史。模型调用需要可用的模型服务。

安装器未经代码签名，Windows 可能显示未知发布者。当前发布平台为 Windows x64。

## 仓库内容

- `desktop/`：Electron 主进程、IPC 桥接、会话内核、网关与权限交互。
- `renderer/`：独立浏览器界面。
- `build/`：打包与 ASAR 工具。
- `tools/`：测试启动器、运行时安装和开发检查工具。
- `test/`：回归测试及测试夹具。
- `resources/i18n-overlay/`：本地化叠加资源。

此源码快照排除了本地会话、账号令牌、个人下载、调试证据、运行缓存、第三方编译运行时和安装器。开发工具与部分测试沿用重建期间的命名，引用外部样本或 evidence 的审计脚本需要自行准备输入。

## 开发

需要 Node.js 22+、npm；Windows 桌面及安装器是当前主要验证平台。

```powershell
npm ci
npm start
# 浏览器访问 http://127.0.0.1:19420
```

独立浏览器界面和生产桌面界面使用不同入口。桌面模式还需要下面列出的外部资源：

```powershell
node tools/setup-agent-core.cjs
npm run desktop
```

### 外部资源

1. `agent-core/`：由安装脚本从脚本中固定的上游版本构建并校验；包含 Claude Code Best bundle 和 Bun。首次构建需要网络与上游构建环境。使用前检查上游项目的许可与版本要求。
2. `resources/bootstrap-3p.json`：桌面启动配置，当前本地配置含账号标识，已从公开快照排除。完整桌面构建需自行提供经过审核的合成配置。
3. `resources/ion-dist/`：完整桌面所用的前端静态资源。当前开发环境由本机目录链接提供，本仓库不包含这份资源，也没有公开自动下载流程。需自行准备兼容版本。缺少该目录时，完整桌面和安装器构建不能视为可复现。

不要把本地账号、模型 API Key、OAuth 令牌或聊天历史加入仓库。模型连接在应用本地配置中设置，不在源码中写入凭据。

## 测试

```powershell
npm test -- test/session-kernel.test.mjs test/session-fork.test.mjs
npm test -- test/cowork-message-updates.test.mjs test/cowork-steer-bridge.test.mjs
```

Windows 测试统一通过 `npm test` 执行，入口限制文件并发并隐藏辅助进程控制台。全套测试包含需要外部样本、桌面资源和本地服务的集成测试；源码快照不承诺无额外输入时全套通过。

## 构建 Windows 安装器

准备好外部资源后：

```powershell
npm run package:check
npm run package
```

产物位于 `release/小克-0.2.8-x64.exe`。安装器应作为 GitHub Release 附件发布，不提交到 Git 源码历史。

## 0.2.8 近期修复

- Code 提问先于回答发布，普通发送及时返回接收回执。
- Cowork 同 UUID 流式消息更新，MCP 注册不阻塞历史加载。
- 运行中追加消息接入内核追加和排队路径。
- `/goal` 桌面命令与持久目标调度。
- 分叉会话继承原生历史、压缩边界与摘要，避免界面历史和模型上下文脱节。

仍有需要完善的部分，包括完整桌面资源的公开构建链、跨目录分叉、更多模型与长期运行场景的端到端测试。

## 许可状态

此发布准备快照尚未指定自有代码的开源许可证，默认保留相关权利；不应推定第三方资源适用同一许可证。正式公开发布前应由项目维护者选定自有代码许可证并核对依赖清单。
