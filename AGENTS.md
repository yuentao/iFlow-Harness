# AGENTS.md

## 项目概览

**iflow-harness**（产品名「心流·驭光」）是一个 VSCode 扩展，把 iFlow CLI 的 Agent 能力图形化地接入编辑器。它通过 **ACP（Agent Client Protocol）** 驱动本地安装的 `@iflow-ai/iflow-cli`：spawn 一个 `--experimental-acp` 子进程，用 **NDJSON 分帧的 JSON-RPC 2.0** 双向通信，提供流式对话、工具审批、Diff 回退、会话持久化、API Profile 管理与 @文件补全。

- 技术栈：TypeScript（strict）+ React 19 + Tailwind CSS 4 + zustand + Vite 8 + vitest
- 目标环境：VSCode `^1.90.0`，Node 22（CI）/ node20（esbuild target）
- 仓库：`https://git.pandorastudio.cn/product/iFlow-harness.git`（非 GitHub 远端）
- 当前版本：见 `CHANGELOG.md` 顶部（`package.json` 的 version 由 CI 从 CHANGELOG 写入，不要手动改）

## 架构：三层单向数据流

```
webview/ (React 投影)  ←── 节流快照 ──  shared/ (纯 reducer)  ←── ACP 事件 ──  src/ (Extension Host)  ←── NDJSON ──  iFlow CLI 子进程
webview/ (用户操作)   ──→ WebviewToHost 消息 ──→ src/panel/panel.ts 路由 ──→ AcpClient 调用
```

**核心原则：状态只存在于 Extension Host。** WebView 从不跑协议逻辑，只渲染快照（`shared/messages.ts` 注释里的 plan §2.1）。

| 目录 | 职责 |
| --- | --- |
| `src/extension.ts` | 激活入口、命令注册、`@iflow` chat participant、编辑器选区入口 |
| `src/acp/client.ts` | spawn CLI 子进程 + initialize 握手；实现 agent→client 的 `fs/read_text_file`、`fs/write_text_file`、`session/request_permission` |
| `src/acp/jsonrpc.ts` | NDJSON 分帧 + JSON-RPC 路由。**零 VSCode 依赖**，可被任意 IDE 集成复用 |
| `src/acp/protocol.ts` | ACP wire 类型；iFlow 专有扩展点用 `// iFlow extension` 标注 |
| `src/acp/cli-locator.ts` | 定位 CLI `bundle/entry.js`（env → PATH shim → npm global → 已知路径） |
| `src/acp/auth.ts` | openai-compatible 凭据 + 命名 Profile（全部存 VSCode SecretStorage） |
| `src/acp/models-query.ts` | 实时 `GET {baseUrl}/models` 取模型列表 |
| `src/panel/panel.ts` | Webview 容器、消息路由、审批流、Diff 回退、会话持久化（最大的文件，~1400 行） |
| `src/panel/store.ts` | Host 侧 store，负责节流快照下发 |
| `shared/messages.ts` | Host ↔ WebView 消息协议 + `Block` / `SessionState` 类型（两侧共用） |
| `shared/session-state.ts` | 纯会话状态 reducer（`applySessionUpdate`、SubAgent 归组、`parseTranscriptJsonl`） |
| `webview/src/` | React UI：`App.tsx`、`store.ts`（zustand）、`components/*` |
| `scripts/harness.mjs` | M0 联调工具：直接驱动真实 CLI 跑 ACP 全流程 |

## 构建与运行

```bash
npm ci                 # 安装依赖
npm run typecheck      # tsc -p tsconfig.json --noEmit
npm test               # vitest run（单次，非 watch）
npm run build          # tsc + esbuild(host) + vite build webview
npm run webview:dev    # webview 增量构建（UI 迭代时用）
npm run harness        # 驱动真实 iFlow CLI 跑 ACP（需本机已装 CLI）
npm run package        # 打包 .vsix（vsce，含 baseContentUrl）
```

- 调试：`.vscode/launch.json` 提供扩展调试配置（F5 在 Extension Development Host 中加载）。
- 本地 F5 前必须 `npm run build`，因为 `main` 指向 `./dist/extension.cjs`，webview 读 `webview/dist/index.html`。
- 打包产物：仓库根目录的 `iflow-harness-*.vsix`（VSIX 目标体积约 200KB）。

## 开发约定

### 分层纪律
- **纯逻辑放 `shared/` 或 `src/acp/jsonrpc.ts`**，保持零 VSCode 依赖以便单测。UI 组件不 import `vscode`。
- 新增 wire 消息类型必须同时更新 `shared/messages.ts` 的 `WebviewToHost` / `HostToWebview` 联合类型，两侧共用。
- 状态变更走 `shared/session-state.ts` 的 reducer 函数，不要在 `panel.ts` 里就地改 state。

### TypeScript
- `strict: true` + `noUncheckedIndexedAccess: true`。数组索引访问必须显式处理 `undefined`（代码里普遍用 `!` 断言，但仅限已判空处）。
- `module: Node16` / `moduleResolution: Node16`，**import 必须带 `.js` 扩展名**（如 `from "./protocol.js"`），即使源文件是 `.ts`。
- `tsconfig.json` 只 include `src` + `shared`；`webview/` 有独立 `tsconfig.json`，由 Vite 构建，不参与主 typecheck。

### 构建产物
- `package.json` 有 `"type": "module"`，但 VSCode 扩展宿主要求 CJS → esbuild 输出 `dist/extension.cjs`（`.cjs` 后缀是刻意的）。
- esbuild 只 bundle `src/extension.ts`，`vscode` 标为 external。

### 本地化（l10n）
- 用户可见字符串一律 `vscode.l10n.t("中文原文", args)`，**中文是源语言**。
- 扩展清单字符串走 `package.nls.json` / `package.nls.zh-cn.json`（`%key%` 占位）；webview 走 `webview/src/i18n.ts` + `l10n/bundle.l10n.en.json`。
- 测试用 `test/vscode-stub.ts` 把 `vscode.l10n.t` 做成恒等翻译，因此断言直接写中文字面量。

### 安全与凭据
- API key **只存 VSCode SecretStorage**，不落盘、不进普通 settings、不打日志。UI 展示用 `maskKey()`（仅末 4 位）。
- 审批默认拒绝（`outcome: "cancelled"`）；审批卡 5 分钟超时自动拒绝，避免 agent 永久阻塞。
- Webview HTML 注入 nonce CSP（`script-src 'nonce-...'`），资源引用重写为 `webview.asWebviewUri`。
- 工具 diff 回退前对「编辑器有未保存修改」「内容与 diff 不一致」两种情况弹 modal 二次确认。

## 已知陷阱（代码注释里踩过并验证过的，改代码前必读）

1. **模型下拉数据源**：必须实时 `GET {baseUrl}/models`（OpenAI list models 接口）。CLI 的 `_meta.models.availableModels` 是官方硬编码目录，**不可作为回退**——端点不可达就返回空列表，仅把 `currentModelId` 补到列表头避免下拉空白。
2. **绕过全局 `fetch`**：VSCode 扩展宿主用代理 agent patch 了 `fetch`，系统代理是 SOCKS 或无 scheme 时会抛 "Invalid URL protocol"。`models-query.ts` 因此用原生 `node:http(s)` 直连。
3. **CLI 不持久化 ACP 会话**：`--experimental-acp` 模式不写 session 文件（交互模式才写）。扩展因此在 `workspaceState` 自持 transcript 副本；恢复时优先读自己的副本，再回退 CLI 的 `~/.iflow/projects/<cwd-slug>/session-<id>.jsonl`。
4. **`session/load` 不回放历史**：CLI 0.5.19 只返回 `{sessionId}`（无 modes、无 `_meta`），所以先 `newSession` 取 meta 再 `loadSession`，transcript 从文件重建。
5. **`set_mode` / `set_model` 不推通知**：agent 不 emit `current_mode_update`，必须把响应里的 `currentModeId` / `currentModelId` 乐观写回 store，否则下拉会弹回。
6. **`diff.path` 可能不可信**：CLI 可能发工具调用视角的相对路径（如 `Home.vue` 实为 `src/views/Home.vue`）。真实路径常在 `tool_call.locations` 里。定位策略：多候选（`diff.path` + `locations`）→ 按「磁盘内容 === diff.newText」优先匹配 → basename 有界搜索 → QuickPick → 文件选择器。
7. **CLI 定位别扫二进制**：nvmd 等多版本管理器可能把 `iflow` 指向原生 dispatcher 二进制，当文本读会卡死扩展宿主（曾 profile 出 100% CPU）。`cli-locator.ts` 有 256KB 上限 + 首 1KB NUL 字节检测。
8. **相对路径基准**：agent 给的相对路径要拼 `sessionCwd`（session 创建时的 workspace 根），**不是** `process.cwd()`（扩展宿主 cwd 不等于 workspace）。
9. **文件写入走 `vscode.workspace.fs`**：回退时不要用裸 `fs.writeFile`，会绕过 VSCode 的文件 watcher。
10. **SubAgent 归组双策略**：优先用 wire 上的 `agentId`；0.5.19 实测事件不带 `agentId`，退化为以 `task` tool_call 为界的状态机（pending/in_progress → completed/failed 区间内的扁平事件归入该卡）。
11. **Windows**：命令用 `process.execPath` 直接跑 `entry.js`，避开 `.cmd` shim 与 Unix shebang 的坑；`spawn` 带 `windowsHide: true`。

## 测试

- 框架：vitest，配置在 `vitest.config.ts`，`include: ["test/**/*.test.ts"]`，超时 15s。
- `vscode` 模块通过 alias 指向 `test/vscode-stub.ts`（只提供 `l10n.t` 恒等实现）。
- 现有覆盖：`jsonrpc`（NDJSON 分帧/路由）、`acp-client`（用 `test/mock-acp-agent.mjs` 起假 agent）、`auth`（SecretStorage 注入式假实现）、`models-query`（临时目录写假 settings.json）、`session-state`（reducer + transcript 解析）。
- 约定：测纯逻辑，不起真实 CLI、不碰真实 SecretStorage。需要文件 I/O 时用 `mkdtempSync` + `afterAll` 清理。
- `test/fixtures/` 存 `scripts/harness.mjs --record` 录制的真实 ACP wire 日志（`.ndjson`）与 M0 摘要（`.json`），用于对照 wire 行为。

## 联调与验证

```bash
npm run harness                                  # initialize → newSession → prompt，权限全拒（安全）
npm run harness -- --record                      # 额外录制 wire 日志到 test/fixtures
IFLOW_CLI_ENTRY=/path/to/entry.js npm run harness  # 指定 CLI 入口
```

`harness.mjs` 从 `dist/src/acp/*.js` 导入（即需要先 `npm run build`），因此它同时是「构建产物可用性」的冒烟测试。

## 发布流程

- **`CHANGELOG.md` 是版本唯一来源**：CI 从顶部 `## [x.y.z] - date` 标题读版本号写入 `package.json`，其下条目作为发布摘要。新增版本时只在 CHANGELOG 加一节，**不要手动改 `package.json` 的 version**。
- `ci.yml`：master 推送与 PR 触发，三平台矩阵（ubuntu/windows/macos）跑 typecheck → test → build。
- `release.yml`：**仅 release 分支**（或手动触发）打包 `.vsix`、上传 artifact、打 tag 建 release。
- 打包必须带 `--baseContentUrl` / `--baseImagesUrl`（指向仓库 raw 地址），否则 VSIX 内文档/图片链接失效——这是 0.2.0 修过的发布故障。

## 给后续 Agent 的建议

- 改 `panel.ts` 前先读它顶部的类字段注释，审批/会话持久化/恢复三条链路都靠私有状态字段串起来。
- 任何「CLI 行为」的假设都应在代码注释里标注验证来源（版本 + 实测方式），本仓库大量注释都是这种 `Wire behavior (probed, CLI 0.5.19)` 风格——沿用这个习惯。
- 新增 UI 组件放到 `webview/src/components/`，样式用 Tailwind 4 + oklch 设计 token（见 `webview/src/styles.css`），深/浅色主题由 Host 推送 `theme` 消息驱动，默认跟随编辑器主题。
- 想脱离 VSCode 迭代 UI：`webview/src/store.ts` 的 `createMockHost()` 提供 demo 快照，可用静态服务器直接跑 webview。
