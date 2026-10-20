# 项目知识索引

## 概览

`iflow-harness`（产品名「心流·驭光」）是一个 VSCode 扩展，通过 ACP（Agent Client Protocol）把 iFlow CLI 的 Agent 能力图形化接入编辑器。核心数据流为：`webview/`（React 投影）← 快照 / `blockPatch` ← `shared/`（纯 reducer）← ACP 事件 ← `src/`（Extension Host）← NDJSON JSON-RPC 2.0 ← 内置 CLI 子进程；用户操作反向经 WebviewToHost 消息进入 `src/panel/panel.ts` 路由。

规范会话状态只保存在 Extension Host，WebView 只消费快照并渲染。新增或扩展的能力包括资源生成与资源卡、错误建议、MCP catalog、Plan 规格与模式同步、provider presets、引导向导、会话导航、轮次变更展示、终端记录及 UI 设置；记忆、上下文来源、模型查询和 Profile 切换相关模块也有更新。

`package.json` 当前版本为 `1.7.0`，根目录已有 `iflow-harness-1.7.0.vsix`，旧的 `1.6.0` VSIX 已删除。`AGENTS.md` 摘录仍写“当前版本 1.1.2”，属于文档滞后；发布前必须按 `CHANGELOG.md` 顶部核对版本。本轮采样覆盖 193/193 个文件。

## 技术栈与运行方式

- **语言/框架**：TypeScript 7（strict）+ React 19 + Tailwind CSS 4 + zustand 5 + Vite 8 + vitest 5。`tsconfig.json` 开启 `strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`；主工程使用 Node16 模块，webview 使用 Bundler resolution、`noEmit`、React JSX。
- **运行环境**：VSCode `^1.90.0`；CI Node 22，esbuild target 为 node20；包为 ESM，扩展主入口为 `./dist/extension.cjs`，激活事件为 `onStartupFinished`。
- **执行体**：唯一执行体是内置裁剪版 iFlow CLI（`vendor/iflow-cli`，npm 源包 `@yuentao/iflow-cli` 定制 fork）。通过 spawn `--experimental-acp --stream` 子进程通信，使用 NDJSON 分帧 JSON-RPC 2.0，帧上限 8MB。扩展不探测 PATH/npm/本机 CLI，不提供 `iflow.cliPath` 或环境变量覆盖。
- **构建产物**：`dist/extension.cjs`、`webview/dist/index.html` 和根目录 VSIX。`npm run build` 依次生成图标、执行 tsc、打包 host、构建 webview。
- **本地调试**：F5 前必须先执行 `npm run build`，并至少执行一次 `npm run vendor:cli`；内置 CLI 缺失会直接报错。`.vscode/launch.json` 提供 Extension Development Host 配置。
- **对外贡献点**：Chat Participant `iflow.agent`；命令包括 `iflow.openPanel`、`iflow.newSession`、`iflow.askSelection`、`iflow.addSelectionToContext`、`iflow.rememberSelection`、`iflow.restartCli`、`iflow.exportSessionMarkdown`、`iflow.exportSessionJson`、`iflow.exportWireLog`。关键设置包括 `iflow.defaultMode`、`iflow.nodePath`、`iflow.warmStart`、`iflow.approvalMode`、`iflow.language`、`iflow.contextWindowOverrides`、`iflow.costTable` 等。

## 目录结构与关键模块

| 路径 | 职责 |
| --- | --- |
| `src/extension.ts` | 激活入口、命令注册、`@iflow` chat participant、编辑器选区入口及 `warmStart` 后台预热。 |
| `src/acp/client.ts` | spawn CLI、initialize 握手、agent→client 文件系统回调、权限请求、提问与 Plan 扩展方法、进程树清理。 |
| `src/acp/jsonrpc.ts` / `protocol.ts` | NDJSON 分帧、JSON-RPC 路由、错误分类及 ACP wire 类型；`jsonrpc.ts` 无 VSCode 依赖。 |
| `src/acp/cli-locator.ts` | 硬解析内置 `bundle/entry.js`、定位 Node、维护全局状态缓存与并发去重、种默认规则、生成 ACP 启动参数。 |
| `src/acp/auth.ts` / `models-query.ts` | SecretStorage 凭据、命名 Profile、热重认证；查询 `{baseUrl}/models`、读取 CLI settings 并归档过期 OAuth 缓存。 |
| `src/panel/panel.ts` / `store.ts` | Webview 容器和消息路由；审批、提问、Plan、Diff 回退、持久化、重试、token 用量及 toast；Host reducer、节流快照和 `blockPatch`。 |
| `src/panel/terminal.ts` | 面板终端记录相关 Host 逻辑。 |
| `src/assets/service.ts` / `src/memory/service.ts` | 资源卡/资源生成的 Host 服务，以及记忆服务。 |
| `shared/messages.ts` | Host ↔ WebView 消息协议、`Block`/`SessionState` 类型和 `applyBlockPatch`。 |
| `shared/session-state.ts` / `context-source.ts` | 纯会话 reducer、SubAgent 归组、transcript 解析、块 ID、token 估算及 MCP diff 合成；上下文来源定义。 |
| `shared/asset-gen.ts`、`error-advice.ts`、`mcp-catalog.ts`、`plan-spec.ts`、`provider-presets.ts`、`session-nav.ts`、`turn-changes.ts` | 新增的共享资源生成、错误建议、MCP catalog、Plan 规格、provider 预设、会话导航及轮次变更逻辑。 |
| `webview/src/` | React UI、zustand 展示态、`i18n.ts`、组件、提示音与 `createMockHost`；本轮新增 `AssetCard`、`OnboardingWizard`、`TurnChanges` 等组件。 |
| `scripts/` | `harness.mjs`、`vendor-cli.mjs`、`generate-icon.mjs`、`read-changelog.mjs`，以及新增的 `serve-webview.mjs` 本地服务脚本。 |
| `test/` | 当前采样为 72 个文件，新增覆盖资源、错误建议、MCP、Plan、Profile、会话导航、终端记录、轮次变更、引导和 UI 设置等；`test/transcripts/timeout-session.json` 已删除。 |
| `docs/`、`media/`、`l10n/`、`prompts/` | 文档与截图、图标资源、本地化 bundle、提示词资源。 |
| `vendor/iflow-cli`、`vendor/iflow-defaults`、`scripts/iflow-defaults` | 内置 CLI 与默认规则相关目录；由裁剪/同步流程生成，当前顶层采样未展示被忽略或生成目录。 |
| `iflow-harness-1.7.0.vsix`、`.tmp-*` | 当前 VSIX 产物；`.tmp-iflow-bundle.js`、`.tmp-patch-live-output.mjs`、`.tmp-probe-live.mjs` 和 serve 日志为根目录调试/临时产物，不属于核心产品模块。 |

## 约定与陷阱

1. **单向数据流**：规范状态只在 Extension Host；WebView 不运行协议逻辑。新增共享能力应放在 `shared/`，避免在 React 侧维护第二份会话状态。
2. **内置 CLI 是唯一执行体**：不探测或回退到本机 CLI；`vendor/` 通常因 gitignore 不存在，缺少内置 CLI 时应直接失败。
3. **`vendor:cli` 来源有文档漂移**：较新说明称默认从本地 fork `../iflow-fork` 拷贝并裁剪，npm 拉取需显式 `--version`；旧 README 仍可能写为直接拉取。CI 没有本地 fork 时，`npm run package` 会失败。
4. **版本对齐是硬性要求**：`package.json` 当前为 `1.7.0`；`AGENTS.md` 仍写 `1.1.2`，而 `CHANGELOG.md` 顶部未在摘录中展示。发布前应同时核对 `package.json`、`CHANGELOG.md` 和生成的 VSIX。
5. **测试数量不可直接引用文档**：当前采样 `test/` 有 72 个文件，但 `AGENTS.md` 仍写 11 文件 / 271 用例；实际用例数以 `npm test` 输出为准。
6. **仓库地址不一致**：`package.json` 指向 GitHub，`AGENTS.md` 称实际 `git remote` 指向内部 GitLab；修改发布配置或推送前应确认目标源。
7. **i18n 分层**：Host 使用 `vscode.l10n.t` 与 `l10n/bundle.l10n.en.json`；manifest 使用 `%key%` 与 `package.nls*.json`；webview 使用 `webview/src/i18n.ts`。新增文案不要硬编码。
8. **安全边界**：API Key 仅存 VSCode SecretStorage；审批默认拒绝并有超时；Webview 使用 nonce CSP 与 DOMPurify。扩展侧文件回调限制在工作区范围，但执行类工具仍运行在本机真实 shell，审批卡不是沙箱。
9. **协议注意点**：修改协议时注意 NDJSON 8MB 帧上限，以及 `_iflow/user/questions`、`_iflow/plan/exit`、`session/set_think` 等 iFlow 扩展方法。
10. **Checkpoint 不修改用户 `.git`**：每轮快照写入独立影子仓库，非 git 目录也可使用；容量和轮数限制以 README 与相关设置为准。
11. **根目录临时产物需区分**：新增 `.tmp-*` bundle、patch、probe 和 serve 文件不应被视作正式入口；发布前结合 `.vscodeignore` 检查打包范围。

## 常用命令

- `npm ci`：按锁文件安装依赖；README 也可能使用 `npm install`。
- `npm run typecheck`：执行 `tsc -p tsconfig.json --noEmit`，检查 host/shared 类型。
- `npm test`：执行 `vitest run` 单次运行，非 watch；测试不依赖真实 CLI/API。
- `npm run build`：图标生成 + tsc + esbuild host + vite build webview。
- `npm run webview:dev`：webview 增量构建。
- `cd webview && npx tsc --noEmit`：检查 webview 类型。
- `npx vite build webview`：构建 webview；可用静态服务器打开 `webview/dist`。
- `node scripts/serve-webview.mjs`：运行新增的本地 Webview 服务脚本，具体行为以脚本为准。
- `npm run vendor:cli`：生成/更新 `vendor/iflow-cli`；支持 `--from-dir`、`--from`、`--version` 等参数。
- `npm run defaults:sync`：把本机 `~/.iflow/` 默认规则同步到 `scripts/iflow-defaults/`。
- `npm run harness`：驱动真实 iFlow CLI 跑 ACP 全流程；`--record` 录制 wire 日志，`--probe` 探测方法行为。
- `npm run package`：执行 `vendor:cli` + `build` + `vsce package --no-dependencies`，产出包含内置 CLI 的 `.vsix`。
- `npm run icon`：仅重新生成 `media/icon.png`。
