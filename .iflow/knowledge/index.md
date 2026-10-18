# 项目知识索引

## 概览

`iflow-harness`（产品名「心流·驭光」）是一个 VSCode 扩展，通过 ACP（Agent Client Protocol）把 iFlow CLI 的 Agent 能力图形化接入编辑器。核心数据流为：`webview/`（React 投影）← 快照 / `blockPatch` ← `shared/`（纯 reducer）← ACP 事件 ← `src/`（Extension Host）← NDJSON JSON-RPC 2.0 ← 内置 CLI 子进程；用户操作反向经 WebviewToHost 消息进入 `src/panel/panel.ts` 路由。

状态只存在于 Extension Host，WebView 只渲染快照。功能覆盖流式对话、工具审批、行号 Diff 与逐块回退、轮级 Checkpoint、会话持久化、API Profile 热切换、`@` 文件/诊断/git/网页上下文、提问卡、Plan 审批、限流退避与上下文溢出恢复等。

`package.json` 声明版本 `1.6.0`，根目录存在 `iflow-harness-1.6.0.vsix`。注意 `AGENTS.md` 文本中仍写“当前版本 1.1.2”，属于文档滞后；发布前必须按 CHANGELOG 对齐规则核对。本索引基于 159 个采样文件及摘录，未展示的配置细节不推断。

## 技术栈与运行方式

- **语言/框架**：`AGENTS.md` 声明 TypeScript 7（strict）+ React 19 + Tailwind CSS 4 + zustand 5 + Vite 8 + vitest 5。`tsconfig.json` 开启 `strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`，模块为 Node16；webview 使用 Bundler resolution、`noEmit`、React JSX。
- **运行环境**：VSCode `^1.90.0`；CI Node 22，esbuild target 为 node20；包为 ESM（`"type": "module"`），扩展主入口 `./dist/extension.cjs`，激活事件 `onStartupFinished`。
- **执行体**：面板唯一执行体是扩展内置裁剪版 iFlow CLI（`vendor/iflow-cli`，源为定制 fork）。通过 spawn `--experimental-acp --stream` 子进程通信，NDJSON 分帧 JSON-RPC 2.0，帧上限 8MB。扩展不探测、不使用本机安装的 CLI，也没有 `iflow.cliPath` 设置。
- **构建产物**：`dist/extension.cjs`、`webview/dist/index.html`、根目录 `.vsix`。`npm run build` 依次执行图标生成、tsc、esbuild（host）、vite（webview）。
- **本地调试**：F5 前必须先 `npm run build`，且至少执行一次 `npm run vendor:cli`；否则内置 CLI 缺失会直接报错。`.vscode/launch.json` 提供 Extension Development Host 配置。
- **对外贡献点**：Chat Participant `iflow.agent`；命令包括 `iflow.openPanel`、`iflow.newSession`、`iflow.askSelection`、`iflow.addSelectionToContext`、`iflow.rememberSelection`、`iflow.restartCli`、`iflow.exportSessionMarkdown`、`iflow.exportSessionJson`、`iflow.exportWireLog`。关键设置包括 `iflow.defaultMode`、`iflow.nodePath`、`iflow.warmStart`、`iflow.approvalMode`、`iflow.language`、`iflow.contextWindowOverrides`、`iflow.costTable` 等。

## 目录结构与关键模块

| 路径 | 职责 |
| --- | --- |
| `src/extension.ts` | 激活入口、命令注册、`@iflow` chat participant、编辑器选区入口、`warmStart` 后台预热。 |
| `src/acp/client.ts` | spawn CLI、initialize 握手、实现 agent→client 的 fs 回调、权限请求、提问/Plan 扩展方法、进程树清理。 |
| `src/acp/jsonrpc.ts` | NDJSON 分帧、JSON-RPC 路由、错误分类（限流/上下文溢出）。零 VSCode 依赖，可复用。 |
| `src/acp/protocol.ts` | ACP wire 类型；iFlow 专有扩展点用 `// iFlow extension` 标注。 |
| `src/acp/cli-locator.ts` | 硬解析内置 CLI `bundle/entry.js`；定位 Node 可执行文件；种默认规则；拼 ACP 启动命令与 `--include-directories`。 |
| `src/acp/auth.ts` / `models-query.ts` | SecretStorage 凭据与命名 Profile、热重认证；实时查询 `{baseUrl}/models`、读取 CLI settings。 |
| `src/panel/panel.ts` | Webview 容器、消息路由、审批流、提问卡、Plan 审批、Diff 回退、会话持久化、重试、token 用量、toast 生命周期。约 3250 行，是最大文件。 |
| `src/panel/store.ts` | Host 侧 store：reducer、节流快照、增量 `blockPatch` 锚定、toast 序号/生命周期、流式用量刷新。 |
| `shared/messages.ts` | Host ↔ WebView 消息协议、`Block`/`SessionState` 类型、`applyBlockPatch`。 |
| `shared/session-state.ts` | 纯会话状态 reducer、SubAgent 归组、transcript 解析、块 id 分配、token 估算、MCP diff 合成。 |
| `webview/src/` | React UI、zustand store、`i18n.ts`、组件、Web Audio 提示音、`createMockHost`。 |
| `scripts/` | `harness.mjs`（真实 CLI ACP 联调/录制/探测）、`vendor-cli.mjs`（内置 CLI 裁剪打包）、`generate-icon.mjs`、`read-changelog.mjs`。 |
| `test/` | vitest 测试，包含 mock ACP agent 集成测试；共 56 个文件，实际用例数文档不一致。 |
| `docs/`、`media/`、`l10n/`、`prompts/` | 文档与截图、图标资源、本地化 bundle、提示词资源。 |
| `vendor/iflow-cli`、`vendor/iflow-defaults` | 文档说明的内置 CLI 与默认规则；未出现在顶层文件树，因被 gitignore/需生成。 |

## 约定与陷阱

1. **单向数据流**：状态只在 Extension Host；WebView 不跑协议逻辑，只消费 snapshot / `blockPatch`。新增交互应走 `shared/messages.ts` 协议，避免在 React 侧维护第二份会话状态。
2. **内置 CLI 是唯一执行体**：不探测 PATH/npm/本机 CLI，缺失即抛错。`vendor/` 被 gitignore，开发 checkout 通常没有；F5 前必须 `npm run build` + `npm run vendor:cli`。
3. **`vendor:cli` 来源有文档漂移**：`AGENTS.md` 较新说明称默认从本地 fork `../iflow-fork` 拷贝并裁剪，npm 拉取需显式 `--version`；README 仍写“拉取”。CI 环境若没有本地 fork checkout，`release.yml` 跑 `npm run package` 会失败，需先准备 fork 或本地打包。
4. **版本对齐是硬性要求**：`CHANGELOG.md` 顶部 `## [x.y.z]` 是发布版本唯一来源，CI 会用它覆写 `package.json`。提交前确保 `package.json` version 与 CHANGELOG 顶部一致。当前 `package.json` 为 `1.6.0`，但 `AGENTS.md` 文本仍写 `1.1.2`，存在文档滞后；CHANGELOG 顶部未在摘录中展示，发布前务必核对。
5. **文档间测试数量不一致**：`AGENTS.md` 写 11 文件 / 271 用例，README 写 30 文件 / 557 用例；`test/` 目录实际 56 个文件。实际数量未从文件中确认，以 `npm test` 输出为准。
6. **仓库地址不一致**：`package.json` 的 repository 指向 GitHub，`AGENTS.md` 称实际 `git remote` 仍指向内部 GitLab。修改发布配置或推送前注意目标源。
7. **i18n 约定**：Host 用 `vscode.l10n.t` 并补 `l10n/bundle.l10n.en.json`；manifest 用 `%key%` 并补 `package.nls*.json`；webview 用 `webview/src/i18n.ts` 字典。新增 UI 文案不要硬编码。
8. **安全边界**：API Key 仅存 VSCode SecretStorage；审批默认拒绝、5 分钟超时自动拒答；Webview 使用 nonce CSP + DOMPurify。扩展侧 fs 回调只允许会话目录 + 已打开工作区根，拒绝 `..` 上逃和范围外绝对路径。但 `run_shell_command` 等执行类工具运行在本机真实 shell，审批卡不是沙箱。
9. **协议注意点**：`src/acp/jsonrpc.ts` 零 VSCode 依赖，可独立复用；修改协议时注意 NDJSON 8MB 帧上限与 iFlow 扩展方法（`_iflow/user/questions`、`_iflow/plan/exit`、`session/set_think`）。
10. **Checkpoint 不碰用户 `.git`**：每轮快照写入独立影子 git 仓库，非 git 目录也可用；相关容量/轮数设置见 README，`package.json` 摘录未完整展示全部默认值。

## 常用命令

- `npm ci`：按锁文件安装依赖（`AGENTS.md` 推荐）；README 开发步骤也使用 `npm install`。
- `npm run typecheck`：执行 `tsc -p tsconfig.json --noEmit`，检查 host/shared 类型。
- `npm test`：`vitest run` 单次运行，非 watch；测试不依赖真实 CLI/API。
- `npm run build`：图标 + tsc + esbuild（host）+ vite build（webview）。
- `npm run webview:dev`：webview 增量构建，UI 迭代时使用。
- `cd webview && npx tsc --noEmit`：webview 侧类型检查。
- `npx vite build webview`：构建 webview 后可用静态服务器打开 `webview/dist`，内置 mock host 便于浏览器调试。
- `npm run vendor:cli`：生成/更新 `vendor/iflow-cli`；支持 `--from-dir` / `--from` / `--version` 等参数（详见脚本与 AGENTS.md）。
- `npm run defaults:sync`：把本机 `~/.iflow/` 默认规则同步到 `scripts/iflow-defaults/`。
- `npm run harness`：驱动真实 iFlow CLI 跑 ACP 全流程；`--record` 录 wire 日志，`--probe` 探测方法行为。
- `npm run package`：`vendor:cli` + `build` + `vsce package --no-dependencies`，产出含内置 CLI 的 `.vsix`。
- `npm run icon`：仅重新生成 `media/icon.png`。
