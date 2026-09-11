# AGENTS.md

## 项目概览

**iflow-harness**（产品名「心流·驭光」）是一个 VSCode 扩展，把 iFlow CLI 的 Agent 能力图形化地接入编辑器。它通过 **ACP（Agent Client Protocol）** 驱动本地安装的 `@iflow-ai/iflow-cli`：spawn 一个 `--experimental-acp --stream` 子进程，用 **NDJSON 分帧的 JSON-RPC 2.0** 双向通信，提供流式对话、工具审批、Diff 回退、会话持久化、API Profile 管理、@文件补全、附件与选区上下文、ask_user_question 提问卡、Plan 模式审批、速率限制与上下文溢出的自动恢复。**扩展内置裁剪版 CLI（`vendor/`），未安装 CLI 的机器也能开箱即用**——本地安装的 CLI 仍优先探测。

- 技术栈：TypeScript 7（strict）+ React 19 + Tailwind CSS 4 + zustand 5 + Vite 8 + vitest 5
- 目标环境：VSCode `^1.90.0`，Node 22（CI）/ node20（esbuild target）
- 仓库：`package.json` 声明 GitHub（`https://github.com/yuentao/iFlow-Harness.git`），但实际 `git remote` 仍指向内部 GitLab（`https://git.pandorastudio.cn/product/iFlow-harness.git`）——两处不一致，改发布配置时注意别踩空
- 当前版本：见 `CHANGELOG.md` 顶部（现为 `1.0.1` / 2026-09-12）；`package.json` 的 version 由发布流程从 CHANGELOG 写入，**不要手动改**（工作区常见一个未提交的 version bump 属正常现象）
- 版本历史：0.1.0（2026-08-30 首版）→ 0.2.0（2026-09-07 全新 UI）→ 1.0.0（2026-09-11 提问卡/附件/内置 CLI 等）→ 1.0.1（2026-09-12 模型下拉修复）

## 架构：三层单向数据流

```
webview/ (React 投影)  ←── snapshot / blockPatch ──  shared/ (纯 reducer)  ←── ACP 事件 ──  src/ (Extension Host)  ←── NDJSON ──  iFlow CLI 子进程
webview/ (用户操作)   ──→ WebviewToHost 消息 ──→ src/panel/panel.ts 路由 ──→ AcpClient 调用
```

**核心原则：状态只存在于 Extension Host。** WebView 从不跑协议逻辑，只渲染快照（`shared/messages.ts` 注释里的 plan §2.1）。

| 目录 | 职责 |
| --- | --- |
| `src/extension.ts` | 激活入口、命令注册、`@iflow` chat participant、编辑器选区入口（Ask iFlow / 加入上下文）、`warmStart` 后台预热 |
| `src/acp/client.ts` | spawn CLI 子进程 + initialize 握手；实现 agent→client 的 `fs/read_text_file`、`fs/write_text_file`、`session/request_permission`、`_iflow/user/questions`、`_iflow/plan/exit`；`killTree` 进程树清理 |
| `src/acp/jsonrpc.ts` | NDJSON 分帧（8MB 帧上限）+ JSON-RPC 路由 + `errorMessage` / `isRateLimitError` / `isContextOverflowError`。**零 VSCode 依赖**，可被任意 IDE 集成复用 |
| `src/acp/protocol.ts` | ACP wire 类型；iFlow 专有扩展点用 `// iFlow extension` 标注（`_iflow/user/questions`、`_iflow/plan/exit`、`session/set_think`） |
| `src/acp/cli-locator.ts` | 定位 CLI `bundle/entry.js` 与可用 Node 可执行文件（异步探测 + 缓存 + 并发去重 + **跨窗口 globalState 持久化** + **vendor 回退**）；`seedDefaultRuleConfigs` 把内置默认规则种到 `~/.iflow/`；`buildAcpCommand` 拼 `--experimental-acp --stream` |
| `src/acp/auth.ts` | openai-compatible 凭据 + 命名 Profile（全部存 VSCode SecretStorage）；支持热重认证（切换 Profile 免重启 CLI） |
| `src/acp/models-query.ts` | 实时 `GET {baseUrl}/models` 取模型列表；读 CLI settings.json；归档过期 OAuth 缓存 |
| `src/panel/panel.ts` | Webview 容器、消息路由、审批流、提问卡、Plan 审批、Diff 回退、会话持久化、速率限制/上下文溢出重试（最大的文件，~2500 行） |
| `src/panel/store.ts` | Host 侧 store：reducer 应用 + 节流快照 + P-1 增量快照（`blockPatch`）锚定 |
| `shared/messages.ts` | Host ↔ WebView 消息协议 + `Block` / `SessionState` 类型（两侧共用）+ `applyBlockPatch` |
| `shared/session-state.ts` | 纯会话状态 reducer（`applySessionUpdate`、SubAgent 归组、`parseTranscriptJsonl`、块 id 分配/回填、`toAgentPromptText`） |
| `webview/src/` | React UI：`App.tsx`、`store.ts`（zustand + Web Audio 提示音 + `createMockHost`）、`i18n.ts`、`components/*`（8 个组件，Win12 风格亚克力材质） |
| `scripts/harness.mjs` | M0 联调工具：驱动真实 CLI 跑 ACP 全流程，`--record` 录 wire 日志，`--probe` 探方法行为 |
| `scripts/vendor-cli.mjs` | 内置 CLI 裁剪打包：`vendor:cli`（拉取+裁剪 CLI 进 `vendor/iflow-cli`）、`--sync-defaults`（同步本地默认规则到 `scripts/iflow-defaults/`） |
| `scripts/generate-icon.mjs` | 由 SVG 生成 `media/icon.png`（@resvg/resvg-js），`npm run build` 首步调用 |
| `scripts/read-changelog.mjs` | CI 用：从 CHANGELOG 顶部读版本号与摘要写入 GITHUB_OUTPUT |
| `vendor/iflow-cli/` | 裁剪后的内置 CLI（~40MB，源为 `@yuentao/iflow-cli` 定制 fork），`package` 时进 VSIX |
| `vendor/iflow-defaults/` | 随包发布的默认规则配置（kimi 请求覆写、多模态模型、输出 token 限制、思考模型 4 个 json），连接前种到 `~/.iflow/` |
| `docs/code-review-2026-09-08.md` | 全面代码审查报告 + 逐条修复记录（改安全/性能相关代码前值得先看） |

## 构建与运行

```bash
npm ci                 # 安装依赖
npm run typecheck      # tsc -p tsconfig.json --noEmit
npm test               # vitest run（单次，非 watch；当前 6 文件 / 136 用例）
npm run build          # icon + tsc + esbuild(host) + vite build webview
npm run icon           # 仅重新生成 media/icon.png
npm run webview:dev    # webview 增量构建（UI 迭代时用）
npm run vendor:cli     # 拉取并裁剪 CLI 到 vendor/iflow-cli（详见下节）
npm run defaults:sync  # 把本机 ~/.iflow/ 的默认规则同步到 scripts/iflow-defaults/
npm run harness        # 驱动真实 iFlow CLI 跑 ACP（需本机已装 CLI 或已 vendor）
npm run package        # vendor:cli && build && vsce package --no-dependencies
```

- 调试：`.vscode/launch.json` 提供扩展调试配置（F5 在 Extension Development Host 中加载）。
- 本地 F5 前必须 `npm run build`，因为 `main` 指向 `./dist/extension.cjs`，webview 读 `webview/dist/index.html`。调试内置 CLI 回退时还需先跑一次 `npm run vendor:cli`（vendor/ 在 dev checkout 可能不存在）。
- 打包产物：仓库根目录的 `iflow-harness-*.vsix`（内置 CLI 后 VSIX 约 13MB，不再是 0.2.0 时代的 200KB）。

## 内置 CLI 回退（vendor）

`scripts/vendor-cli.mjs` 把 CLI 打进 VSIX，使扩展在**完全没装 CLI** 的机器上可用。要点：

- **来源是定制 fork**：npm 源为 `@yuentao/iflow-cli@0.5.19-custom.1`（tag `custom`），带本地注入的 `*.loader.cjs` 定制 bundle——官方 `@iflow-ai` 包不含。loader 源码来自 [iFlow-Mods](https://github.com/yuentao/iFlow-Mods) Mod 仓库：patch 型 Mod（thinking-mode / multimodal-image / output-token-limit / kimi-request-override / context-window refactor）在 CLI 源码同一插入点以 1 行 require 注入 loader，monkey-patch 模型规则并外置到 `~/.iflow/*.json`；Mod 可用 [iFlow-Mod-Builder](https://github.com/yuentao/iFlow-Mod-Builder)（Tauri+Vue3 GUI）打包成 `.iflow-mod` 安装。`--from <tgz>` / `--from-dir <dir>` 可完全绕开 npm 源（离线/本地定制场景——`--from-dir` 正是装载带新 loader 的本地定制 CLI 的路径，`--from-dir` 自带 node_modules 会跳过安装）。
- **裁剪有实测背书，不是猜的**：每个被裁项（node-pty 62.6MB、devtools、jimp 图像链等，共 182.7MB → 39.3MB）都于 2026-09-11 用 `npm run harness` 对裁剪副本跑完整 ACP 流程验证过——被裁的只服务交互 TUI，ACP headless 路径不碰。**增删 PRUNE 清单前必须重跑 harness 验证**。
- **版本幂等**：`vendor/iflow-cli/package.json` 的 version 与目标一致就跳过；`--force` 强制重做。注意 `--from-dir` 时「同版本 ≠ 同内容」，本地 loader 定制不在 npm 源里。
- **默认规则双目录**：源在 `scripts/iflow-defaults/`（进 git），构建时复制到 `vendor/iflow-defaults/`；扩展连接前把 `~/.iflow/` **缺失的**规则文件种过去（`seedDefaultRuleConfigs`），**永不覆盖用户已有文件**；`settings.json` / `iflow_accounts.json` 携带凭据，固定清单之外一概不同步。
- **`.vscodeignore` 有关键例外**：`node_modules/**` 被排除，但 `!vendor/iflow-cli/node_modules/**` 必须保留——内置 CLI 的运行时依赖靠它进包。
- **Windows 陷阱**：`npm pack` 用单命令字符串 + `shell:true`（Node ≥20.12 下无 shell spawn `.cmd` 会抛 EINVAL CVE-2024-27980，shell:true 带 args 数组又触发 DEP0190）；解压用系统自带 bsdtar。
- 探测优先级（`locateIflowEntry`）：`IFLOW_CLI_ENTRY` 环境变量 → PATH shim → npm 全局 root → 平台已知路径 → **vendor 副本（最后手段）**。显式安装的 CLI 永远赢过 vendor，用户可自由升级自己的安装。

## 开发约定

### 分层纪律
- **纯逻辑放 `shared/` 或 `src/acp/jsonrpc.ts`**，保持零 VSCode 依赖以便单测。UI 组件不 import `vscode`。
- 新增 wire 消息类型必须同时更新 `shared/messages.ts` 的 `WebviewToHost` / `HostToWebview` 联合类型，两侧共用。
- 状态变更走 `shared/session-state.ts` 的 reducer 函数，不要在 `panel.ts` 里就地改 state。
- 新增 transcript 块类型：加进 `Block` 联合并继承 `BlockBase`（带 `id?`），同时确认 `backfillBlockIds` 的递归路径覆盖到。

### TypeScript
- `strict: true` + `noUncheckedIndexedAccess: true`。数组索引访问必须显式处理 `undefined`（代码里普遍用 `!` 断言，但仅限已判空处）。
- `module: Node16` / `moduleResolution: Node16`，**import 必须带 `.js` 扩展名**（如 `from "./protocol.js"`），即使源文件是 `.ts`。
- `tsconfig.json` 只 include `src` + `shared`；`webview/` 有独立 `tsconfig.json`，由 Vite 构建，不参与主 typecheck。

### 构建产物
- `package.json` 有 `"type": "module"`，但 VSCode 扩展宿主要求 CJS → esbuild 输出 `dist/extension.cjs`（`.cjs` 后缀是刻意的）。
- esbuild（`esbuild.mjs`）只 bundle `src/extension.ts`，`vscode` 标为 external，target `node20`。
- tsc 同时把 `src/`、`shared/` 编译到 `dist/`（`dist/src/acp/*.js` 供 `scripts/harness.mjs` 导入），这些中间产物被 `.vscodeignore` 排除出 VSIX。

### 本地化（l10n）
- 用户可见字符串一律 `vscode.l10n.t("中文原文", args)`，**中文是源语言**。
- 扩展清单字符串走 `package.nls.json` / `package.nls.zh-cn.json`（`%key%` 占位）；webview 走 `webview/src/i18n.ts` + `l10n/bundle.l10n.en.json`。
- 测试用 `test/vscode-stub.ts` 把 `vscode.l10n.t` 做成恒等翻译，因此断言直接写中文字面量。
- 双轨 l10n 是已知架构债（审查报告 W7）：host 走 VSCode l10n 工具链、webview 走运行时字典，合并属架构级重构，当前维持现状。

### 安全与凭据
- API key **只存 VSCode SecretStorage**，不落盘、不进普通 settings、不打日志。UI 展示用 `maskKey()`（仅末 4 位）。
- 审批默认拒绝（`outcome: "cancelled"`）；审批卡 5 分钟超时自动拒绝，避免 agent 永久阻塞。
- Webview HTML 注入 nonce CSP（`script-src 'nonce-...'`），资源引用重写为 `webview.asWebviewUri`；DOMPurify 显式 `FORBID_TAGS: ["iframe","form"]` + `FORBID_ATTR: ["style","target"]`。
- 工具 diff 回退前对「编辑器有未保存修改」「内容与 diff 不一致」两种情况弹 modal 二次确认。
- webview 提供的 data URL 附件有 8MB 上限（`MAX_IMAGE_ATTACHMENT_BYTES`），超限在落盘前拒绝。
- `openExternal` 仅放行 `^https?://`。
- vendor 默认规则链路**永不触碰凭据文件**（settings.json / iflow_accounts.json），见上节。
- **未闭合项**：`client.ts` 的 `resolveAgentPath` 只做相对→绝对拼接，无 session cwd 前缀校验（审查报告 S1，CRITICAL）——agent 可通过 `fs/write_text_file` 写任意路径。动这块时优先补护栏。

## 1.0.0 的关键能力（细节在 CHANGELOG 只有一句话，技术要点在此）

- **ask_user_question 提问卡**：`_iflow/user/questions`（iFlow 扩展方法）→ `QuestionCard.tsx`，支持单选/多选/自由文本，答案按 question `header` 建 map 回传；该方法未注册时 CLI 侧返回 MethodNotFound，工具必失败。
- **Plan 模式审批**：`_iflow/plan/exit` → 复用审批卡形态，`{approved, reason}` 回传。
- **速率限制自动重试**：`RATE_LIMIT_RETRY_DELAYS_MS = [5s, 15s, 30s]` 递增退避（单次 5s 重试不够，平台限流窗口常超过 5s）；`isRateLimitError` 匹配 429 / "rate limit" / 中文「速率限制」措辞。
- **上下文溢出自动压缩**：`isContextOverflowError` → 自动发 `/compress`（桥接 CLI 强制全量压缩，绕过比例门控）→ 重发原 prompt；压缩结果以 `CompressionBlock` 折叠卡呈现，不泄漏原始 JSON。
- **提示音**：Web Audio 合成（无资源文件），`playSound` 消息驱动；Host 按 `iflow.soundFeedback` 与面板可见性门控；AudioContext 必须在用户手势中创建/恢复（否则 autoplay 策略下永久 suspended，提示音静默）。
- **代码上下文卡**：右键「加入 iFlow 上下文」→ `CodeContextUi` 卡片（可移除、最多一张），发送时由 Host 拼成 fenced block 前置到 prompt。
- **附件**：`pickAttachments`（OS 选择器，图片走 base64、其他文件走真实路径）+ `stageFiles`（拖拽/粘贴的非图片文件由 Host 写入会话临时目录）；>5MB 的图片降级为普通文件附件。
- **CLI 启动优化**：`locateNodeExecutable` 优先用 PATH 上的独立 Node（≥20）而非 Electron 的 `Code.exe`（实测 initialize 13s → 6s，并针对「GUI 启动继承陈旧 PATH」补了绝对路径 node 候选）；入口与 node 并行探测；`iflow.nodePath` 可强制指定；`killTree` 清理进程树；`retireStaleOAuthCreds` 把过期 OAuth 缓存改名归档（否则 CLI 每次 authenticate 卡 ~60s 做无用的 Google 刷新）；探测结果经 `LocatorPersistence` 持久化到 globalState，跨窗口免重复探测（成功结果缓存、失败永不缓存）。
- **`iflow.warmStart`**（默认开）：窗口打开后台预热 CLI 进程，首次打开面板无需等待（每窗口约 100MB 内存代价）。
- **热重认证**：切换 API Profile 免重启 CLI（`_iflow` 会话替换 + 并行探测防护）；注意 CLI 会回写 `~/.iflow/settings.json`，热重认证后要防 `currentApiProfile` 回退旧配置。
- **增量快照（P-1）**：`blockPatch` 消息只重发 transcript 尾部 + 全部非 blocks 元数据，`blockVersion` 锚定；锚不匹配 → webview 发 `ready` 全量重同步。
- **transcript 持久化（P2）**：`context.storageUri/transcripts/<sanitized-sessionId>.json` 每会话一文件，promise 串行链 + temp 写 + rename 原子替换；`migrateLegacyTranscripts` 一次性迁移旧数据（必须在会话过滤前执行，否则未迁移数据会被误判为不可恢复）。
- **块稳定 id（P4）**：`BlockBase.id` + `nextBlockId()` 单调计数器 + `backfillBlockIds` 回填旧数据；MessageList 用 `block.id` 作 key + `React.memo(BlockView)`，修掉 index key 导致的折叠状态错位。
- **`--stream` 参数**：`buildAcpCommand` 必须带，否则 CLI 的 ACP prompt 处理器等整轮 SSE 结束才一次性 dump，面板显示为分段而非流式。
- **状态栏**：agent 状态（连接中/就绪/生成中/等待审批/出错）+ 当前模型，点击打开面板。
- **下拉实时刷新 + 模糊搜索**：`refreshAuth`（profile 列表，SecretStorage + CLI settings.json）与 `refreshModels`（`GET {baseUrl}/models`）在对应下拉打开时重算——外部工具会偷偷改写 settings.json；模型下拉支持模糊搜索。
- **长会话渲染**：超长转录离屏渲染 + 后缀挂载窗口；滚动跟随用 ResizeObserver 覆盖全部内容增长路径。
- **Win12 亚克力材质**：webview 视觉系统（见陷阱 #22 的 backdrop-filter 压缩陷阱）。

## 已知陷阱（代码注释里踩过并验证过的，改代码前必读）

1. **模型下拉数据源**：必须实时 `GET {baseUrl}/models`（OpenAI list models 接口）。CLI 的 `_meta.models.availableModels` 是官方硬编码目录，**不可作为回退**——端点不可达就返回空列表，仅把 `currentModelId` 补到列表头避免下拉空白（1.0.1 修复：会话启动延迟推送路径也要补，否则下拉整个消失）。
2. **绕过全局 `fetch`**：VSCode 扩展宿主用代理 agent patch 了 `fetch`，系统代理是 SOCKS 或无 scheme 时会抛 "Invalid URL protocol"。`models-query.ts` 因此用原生 `node:http(s)` 直连。
3. **CLI 不持久化 ACP 会话**：`--experimental-acp` 模式不写 session 文件（交互模式才写）。扩展因此在 `storageUri/transcripts/` 自持 transcript 副本；恢复时优先读自己的副本，再回退 CLI 的 `~/.iflow/projects/<cwd-slug>/session-<id>.jsonl`。
4. **`session/load` 不回放历史**：CLI 0.5.19 只返回 `{sessionId}`（无 modes、无 `_meta`），所以先 `newSession` 取 meta 再 `loadSession`，transcript 从文件重建。probe 会话被有意丢弃（只用其 meta/modes），非泄漏。
5. **`set_mode` / `set_model` 不推通知**：agent 不 emit `current_mode_update`，必须把响应里的 `currentModeId` / `currentModelId` 乐观写回 store，否则下拉会弹回。入口必须判空 `sessionId`（空串照发会被 CLI 乱绑定，响应值再被乐观写回）。
6. **`diff.path` 可能不可信**：CLI 可能发工具调用视角的相对路径（如 `Home.vue` 实为 `src/views/Home.vue`）。真实路径常在 `tool_call.locations` 里。定位策略：多候选（`diff.path` + `locations`）→ 按「磁盘内容 === diff.newText」优先匹配 → basename 有界搜索 → QuickPick → 文件选择器。
7. **CLI 定位别扫二进制**：nvmd 等多版本管理器可能把 `iflow` 指向原生 dispatcher 二进制，当文本读会卡死扩展宿主（曾 profile 出 100% CPU）。`cli-locator.ts` 有 256KB 上限 + 首 1KB NUL 字节检测。
8. **相对路径基准**：agent 给的相对路径要拼 `sessionCwd`（session 创建时的 workspace 根），**不是** `process.cwd()`（扩展宿主 cwd 不等于 workspace）。`openLocation` 也走同一套 `resolveAgentPathToAbsolute`，行号要 clamp 到 `[0, doc.lineCount - 1]`。
9. **文件写入走 `vscode.workspace.fs`**：回退时不要用裸 `fs.writeFile`，会绕过 VSCode 的文件 watcher。
10. **SubAgent 归组双策略**：优先用 wire 上的 `agentId`；0.5.19 实测事件不带 `agentId`，退化为以 `task` tool_call 为界的状态机（pending/in_progress → completed/failed 区间内的扁平事件归入该卡）。`parseTranscriptJsonl` 的 sidechain 归组依赖行序，并发 task 交错写入会把多张卡合并成一张（已知限制）。
11. **Windows**：命令用 `process.execPath` 直接跑 `entry.js`，避开 `.cmd` shim 与 Unix shebang 的坑；`spawn` 带 `windowsHide: true`。
12. **提问卡与 Plan 审批不能被 streaming 门控**：两者在 prompt 进行中到达（status 为 `streaming`），agent 正阻塞等答案；按钮必须可用，不要复用「生成中禁用操作」的防呆逻辑。
13. **prompt 无超时**：`AcpClient.promptTimeoutMs` 默认 `0`（无限等待）——真实任务可能跑数小时，任何超时都会误杀长任务；中断完全由用户显式 Stop（`session/cancel`）驱动。`sendPrompt` 的 `initializing`/`streaming` 并发闸门必须保留（`iflow.askSelection` 与 `@iflow` participant 绕过 webview 的 busy 锁）。
14. **`iflow.idleTimeoutMinutes` 仍是空设置**：package.json manifest 与两个 nls 文件还声明着它，但 `src/` 零引用、README 已于 0.3.0 移除。实现或从 manifest 删除前不要对外承诺该行为。
15. **`--baseContentUrl` 不可用**：0.2.0 起把 `docs/**` 排除出 VSIX（`.vscodeignore`），README 里的 `docs/images/*` 链接在 Marketplace 预览中打不开——刻意的取舍，别「好心」把 docs 加回包。
16. **blockPatch 锚定**：`baseVersion` 与接收端 `blockVersion` 不一致、或 `tailStart` 越界，都必须回退到全量重同步（webview 发 `ready`），不能硬合并。
17. **reducer 就地改 blocks**：`tailOnly` 判断依赖尾部指纹，中段变更对指纹不可见，会保守地清 flag 回退全量快照——不要为了「优化」去掉这个保守回退。
18. **CLI 探测必须异步**：`where.exe` / `npm root -g` 在 Windows 上可达数秒，`execFileSync` 会冻结整个扩展宿主（其他扩展一起卡）；`locateIflowEntry` / `locateNodeExecutable` 都是 async + 缓存 + 并发去重 + globalState 持久化，成功结果缓存（用 `existsSync` 复验）、失败不缓存（会话中装的 CLI 下次能发现）。
19. **`chatForward` 等待条件**：必须在 `idle || error` 时退出（prompt 失败后 status 永不回 idle），cancel 只发一次，并有 10 分钟总超时兜底——旧实现三处叠加会导致 participant 永久挂死 + interval 泄漏。
20. **连接失败要 dispose 子进程**：initialize 超时/握手失败后 CLI 进程会继续存活；`AcpClient.connect()` 内部与 `ensureClient` catch 两处都要 `dispose()`（幂等，双重调用安全）。
21. **vendor 裁剪变更必须重测**：增删 `PRUNE_DIRS` / `PRUNE_PKGS` 前先对裁剪副本跑 `npm run harness` 全流程；同理 `.vscodeignore` 的 `!vendor/iflow-cli/node_modules/**` 例外一旦丢失，打包出的扩展会因缺依赖直接起不来（本地 dev 感知不到，只有 VSIX 安装才炸）。
22. **backdrop-filter 被构建链折叠**：Vite CSS 压缩只留 webkit 前缀写法，经 esbuild 属性折叠后 Chromium 反而忽略模糊——亚克力材质必须同时保留标准与前缀写法的正确顺序，改 `webview/src/styles.css` 材质相关代码前先看 3ff19b9 / 0a26782 两个修复提交。

## 测试

- 框架：vitest 5，配置在 `vitest.config.ts`，`include: ["test/**/*.test.ts"]`，超时 15s。当前 **6 个测试文件 / 136 个用例**全部通过（2026-09-12 实测）。
- `vscode` 模块通过 alias 指向 `test/vscode-stub.ts`（只提供 `l10n.t` 恒等实现）。
- 现有覆盖：`jsonrpc`（NDJSON 分帧/路由/超长帧丢弃）、`acp-client`（用 `test/mock-acp-agent.mjs` 起假 agent）、`auth`（SecretStorage 注入式假实现）、`models-query`（临时目录写假 settings.json）、`session-state`（reducer + transcript 解析 + 块 id 不变量）、`store-snapshot`（节流快照 + blockPatch 锚定）。
- 约定：测纯逻辑，不起真实 CLI、不碰真实 SecretStorage。需要文件 I/O 时用 `mkdtempSync` + `afterAll` 清理。
- `test/fixtures/` 存 `scripts/harness.mjs --record` 录制的真实 ACP wire 日志（`.ndjson`）与 M0 摘要（`.json`），当前为 2026-09-05 的两组，用于对照 wire 行为。

## 联调与验证

```bash
npm run harness                                  # initialize → newSession → prompt，权限全拒（安全）
npm run harness -- --record                      # 额外录制 wire 日志到 test/fixtures
npm run harness -- --probe                       # 探 set_mode / set_model / set_think 行为（不发 prompt，不耗 token）
npm run harness -- --prompt "..."                # 自定义 prompt 文本
IFLOW_CLI_ENTRY=/path/to/entry.js npm run harness  # 指定 CLI 入口（也可指向 vendor 副本）
```

`harness.mjs` 从 `dist/src/acp/*.js` 导入（即需要先 `npm run build`），因此它同时是「构建产物可用性」的冒烟测试；对裁剪后的 `vendor/iflow-cli` 跑它也是 vendor 变更的验收手段（见陷阱 #21）。

## 发布流程

- **`CHANGELOG.md` 是版本唯一来源**：release 流程从顶部 `## [x.y.z] - date` 标题读版本号与摘要，写入 `package.json`（`scripts/read-changelog.mjs` + CI 内联脚本）。新增版本时只在 CHANGELOG 加一节，**不要手动改 `package.json` 的 version**。
- `ci.yml` 与 `release.yml` **都只在 `release` 分支触发**（push + PR / 手动 dispatch）——master 不再跑 CI。
- `ci.yml`：三平台矩阵（ubuntu/windows/macos）跑 typecheck → test → build。
- `release.yml`：npm ci → typecheck → test → 读 CHANGELOG → 写 version 进 package.json → `npm run package`（含 `vendor:cli`，从 npm 拉定制 CLI 裁剪进包）→ `softprops/action-gh-release@v3` 打 tag `v*`、建 GitHub release 并附 `.vsix`。
- **release 卡 Draft 陷阱**：action-gh-release 的发布是「先以 draft 创建 → 上传 assets → finalization 时 publish」两阶段流程，finalization 未发生 release 就永远停留 Draft（Draft 对匿名 API/访客不可见，表现为 release 页面空）。必须显式 `draft: false` 强制 publish；`make_latest` 按输入表是 String，须写带引号的 `"true"`（裸 YAML boolean 有歧义）；v2 线已停止维护，用 @v3。已产生的存量 Draft 不会被 workflow 修复追溯，需在 GitHub Releases 页手动 Publish。
- 打包命令是 `vsce package --no-dependencies`，**不带** `--baseContentUrl` / `--baseImagesUrl`——`docs/**` 已被 `.vscodeignore` 排除（见陷阱 #15）。
- 发布前若改过本机 `~/.iflow/` 默认规则，先 `npm run defaults:sync` 同步到 `scripts/iflow-defaults/` 再提交。
- 新增用户可见设置项时记得同步 `package.nls.json` + `package.nls.zh-cn.json`。

## 给后续 Agent 的建议

- 改 `panel.ts` 前先读它顶部的常量区与类字段注释，审批/提问/会话持久化/恢复/重试五条链路都靠私有状态字段串起来；该文件已 ~2500 行，新增职责优先考虑下沉到 `src/acp/` 或 `shared/`。
- 任何「CLI 行为」的假设都应在代码注释里标注验证来源（版本 + 实测方式），本仓库大量注释都是这种 `Wire behavior (probed, CLI 0.5.19)` 风格——沿用这个习惯；vendor 裁剪清单同理（`vendor-cli.mjs` 顶部注释记录了逐项验证依据）。
- `docs/code-review-2026-09-08.md` 记录了 3 个 CRITICAL + 8 个 MAJOR 的审查发现及逐条修复记录；未闭合项（S1 路径约束、P-1 全量 COW、列表虚拟化）在动手前先读对应条目。
- 新增 UI 组件放到 `webview/src/components/`，样式用 Tailwind 4 + oklch 设计 token（见 `webview/src/styles.css`），深/浅色主题由 Host 推送 `theme` 消息驱动，默认跟随编辑器主题；图标统一用 `lucide-react`（不要 emoji/字符）；动亚克力材质前先看陷阱 #22。
- 想脱离 VSCode 迭代 UI：`webview/src/store.ts` 的 `createMockHost()` 提供 demo 快照，可用静态服务器直接跑 webview。
- 新增设置项要确认它真的实现了——`iflow.idleTimeoutMinutes` 就是声明了但没实现的先例（陷阱 #14）。
- 碰 vendor 链路（vendor:cli / defaults:sync / 探测优先级 / .vscodeignore 例外）时，先读「内置 CLI 回退」一节与 `scripts/vendor-cli.mjs` 顶部注释，改动后必须 `npm run harness` 验收并打一个 VSIX 装到干净环境冒烟。
