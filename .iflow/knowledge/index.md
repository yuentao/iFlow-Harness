# 项目知识索引

## 概览

`iflow-harness`（产品名「心流·驭光」）是一个 VSCode 扩展，通过 ACP（Agent Client Protocol）把 iFlow CLI 的 Agent 能力图形化接入编辑器。

- 通信：spawn 内置 CLI 的 `--experimental-acp --stream` 子进程，NDJSON 分帧的 JSON-RPC 2.0 双向通信（单帧上限 8MB）。
- 数据流：`webview/`（React 投影）← 快照 / `blockPatch` ← `shared/`（纯 reducer）← ACP 事件 ← `src/`（Extension Host）← NDJSON ← 内置 CLI；用户操作反向经 `WebviewToHost` 进入 `src/panel/panel.ts` 路由。**规范状态只在 Extension Host**，WebView 只渲染快照。
- 执行体固定为内置裁剪版 CLI（`vendor/iflow-cli`，默认源为仓库内 `vendor/iflow-fork` 快照）；不探测 PATH / npm / 本机 CLI，无 `iflow.cliPath` 与 env 覆盖，缺失即报错。
- 能力面：流式对话与工具审批、Diff 回退、会话持久化与恢复、检查点（影子 git）、API Profile 与凭据、@文件补全与多根引用、附件与选区上下文、提问卡、Super Agent 子会话编排、QQ 远程渠道、记忆与知识库、MCP catalog/诊断、上下文窗口与成本解析、导出。

## 技术栈与运行方式

- TypeScript 7（strict、`noUncheckedIndexedAccess`、`noUnusedLocals`）+ React 19 + Tailwind CSS 4 + zustand 5 + Vite 8 + vitest 5。
- 主工程 Node16 模块解析（import 必须带 `.js`）；webview 独立 tsconfig（Bundler resolution、DOM lib、noEmit），由 `typecheck:webview` 检查。
- VSCode `^1.90.0`；CI Node 22；esbuild target node20。包是 ESM，但扩展入口是 CJS 产物 `dist/extension.cjs`（`vscode` external，`.md` 以 text 内联）。
- 产物：`dist/extension.cjs`、`webview/dist/index.html`、`vendor/os-notify/`（build 时从 node-notifier 复制）、根目录 VSIX。
- 本地调试：F5 前先 `npm run build` 并至少跑一次 `npm run vendor:cli`；webview 用 `npm run webview:serve` 走 HTTP 打开（`file://` 会因绝对路径资源被 CORS 拒绝而白屏）。
- 对外贡献点：Chat Participant `iflow.agent`；命令 `iflow.openPanel` / `newSession` / `askSelection` / `addSelectionToContext` / `rememberSelection` / `restartCli` / `exportSessionMarkdown` / `exportSessionJson` / `exportWireLog`（均以 `iflow.` 为前缀）；设置项完整清单以 `package.json` 的 `contributes.configuration` 为准（`test/settings-declared.test.ts` 对账）。

## 目录结构与关键模块

| 路径 | 职责 |
| --- | --- |
| `src/extension.ts` | 激活入口、命令注册、`@iflow` chat participant、选区入口、`warmStart` 预热、终端命令捕获。 |
| `src/acp/` | `client.ts` spawn/握手/文件回调/权限与提问扩展方法；`jsonrpc.ts` 分帧与错误分类（零 VSCode 依赖）；`protocol.ts` wire 类型；`cli-locator.ts` 内置入口解析、Node 异步定位、默认规则、ACP 参数；`auth.ts`/`api-profiles.ts` 凭据与 Profile；`models-query.ts` live 模型；`complete.ts` 直连补全；`web-search.ts` 宿主检索；`mcp-broker.ts`；`cli-tokens-limit.ts` 窗口 → `IFLOW_TOKENS_LIMIT`；`os-notify.ts` 系统通知。 |
| `src/panel/` | `panel.ts` 容器与消息路由（审批/提问/Diff/持久化/恢复/限流与溢出恢复/用量/toast，最大文件）；`store.ts` 节流快照与 `blockPatch`；`super-agent*.ts`+`super-store.ts`+`worktree.ts`+`workspace-roots.ts` 子会话编排与隔离；`session-persistence.ts`/`session-restore.ts`/`checkpoint-service.ts`/`checkpoints.ts` 持久化与影子 git 检查点；`attachments.ts`/`tool-diff-service.ts`/`wire-log.ts`/`terminal.ts`/`status-presenter.ts`/`context-window-overrides.ts`；`qq-host.ts`/`qqbot-host.ts` QQ 宿主接线。 |
| `src/memory/`、`src/assets/`、`src/skills/`、`src/qq/` | 记忆读写与层级发现、面板服务（含知识库托管块）、知识库扫描与提示词、候选解析；资产文档服务；Skill 根扫描与调用解析；QQ 任务派发/汇报/去重、落盘、协议客户端、配置与设置。 |
| `shared/` | `messages.ts` 协议与 `Block`/`SessionState`/`applyBlockPatch`/`evictBlockPayloads`；`session-state.ts` 纯 reducer（SubAgent 归组、transcript 解析、块 id、token 估算、MCP diff、`withoutPlanModes`）；`super-*.ts` 子会话状态机/委派/汇报/诊断/波次/看板/时间线/工具调用/白名单；其余为上下文窗口与成本、MCP catalog/诊断、回合变更与回合末合并提示、通知门控、队列、导出、hunk、Skill、检查点索引、模型元数据、Provider 预设、错误建议、会话导航、上下文来源、资产、QQ 纯逻辑。 |
| `webview/src/` | `App.tsx`/`main.tsx`/`store.ts`（zustand + `createMockHost`）/`i18n.ts`/`styles.css`/`components/*`；控件统一收敛到 `components/ui.tsx`。 |
| `scripts/`、`prompts/`、`test/` | `vendor-cli.mjs`/`harness.mjs`/`generate-icon.mjs`/`read-changelog.mjs`/`serve-webview.mjs`；提示词模板构建时内联进 bundle；vitest 用例与 `test/fixtures/` 探针脚本（录制产物被 gitignore）。 |
| `vendor/` | `iflow-fork`（进 git 的 CLI 产物快照）、`iflow-cli`（`vendor:cli` 生成的裁剪副本，进 VSIX）、`iflow-defaults`（随包默认规则）、`os-notify`（build 复制的通知二进制）；后三者被 gitignore。 |

## 约定与陷阱

1. **单向数据流**：新增共享能力放 `shared/`；新增 wire 消息必须同时更新 `WebviewToHost` / `HostToWebview`。
2. **内置 CLI 是唯一执行体**：不探测、不回退本机 CLI；`vendor/iflow-cli` 被 gitignore，缺失即报错。`vendor:cli` 默认源是仓库内 `vendor/iflow-fork/` 快照（不是 Mod 源码仓库），覆写用 `IFLOW_VENDOR_FORK_DIR` / `--from-dir` / `--from`，`--version` 才走 npm registry；改 PRUNE 清单后必须 `npm run harness` 验收。
3. **版本对齐是硬性要求**：`CHANGELOG.md` 顶部是唯一来源，`package.json` 的 `version` 必须同步；发布前用 `grep '"version"' package.json` 与 `head -6 CHANGELOG.md` 自检。
4. **测试数量不可引用文档**：用例数以 `npm test` 输出为准；全量回归用 `npx vitest run`（`--no-isolate` 会造成大量 mock 串味假失败）。
5. **i18n 分层**：Host 用 `vscode.l10n.t`（中文为源语言）与 `l10n/bundle.l10n.en.json`；manifest 用 `%key%` 与 `package.nls*.json`；webview 用 `webview/src/i18n.ts`。新增文案不要硬编码。
6. **安全边界**：API key / token 只存 SecretStorage；审批默认拒绝，审批卡与提问卡共用 5 分钟超时（审批按拒绝、提问按空答案继续）；Webview 用 nonce CSP，markdown 过 DOMPurify；附件 8MB 上限 / 5MB 降级；`openExternal` 只放行 http(s)。执行类工具跑在本机真实 shell，审批卡不是沙箱。
7. **协议注意点**：8MB 帧上限；`set_mode` / `set_model` 不推通知，需乐观写回；`session/load` 不回放历史，先 `newSession` 取 meta；prompt 无超时，只由用户 Stop 中断；`diff.path` 不可信，按多候选定位。
8. **路径与探测**：相对路径拼 `sessionCwd`（不是 `process.cwd()`）；写入走 `vscode.workspace.fs`；`where.exe` / `node --version` 必须异步，`execFileSync` 会冻结扩展宿主。
9. **Plan 模式已移除**：`withoutPlanModes` 剔除 plan 并归一落点；残留 `_iflow/plan/exit` 记警告后自动放行，不弹卡、不阻塞。
10. **内部纯文本任务直连端点**：enhance / 标题 / 记忆提取 / 资产草稿走 `streamChatCompletion`，发送前去 `@` 文件标记，带超时与 idle watchdog 与部分结果 salvage。
11. **长会话内存**：webview 侧按块数 + 字节预算释放重 payload（host 全量保真）、wire 日志双上限、折叠体懒挂载、DiffView 前缀渲染。
12. **子会话隔离**：独立 CLI 进程与 worktree，`allowedRoots` 只含 worktree 根、`--include-directories` 空；免确认 + shell 工具不受路径围栏约束，必须如实标注；自动合并串行执行并先做 merge 预演，绝不替用户 commit / stash / 撤销改动；worktree 里的 `node_modules` 联接不能与 `npm ci` 共存。
13. **知识库注入**：由 `setManagedKnowledgeBlock` 在项目记忆文件末尾维护一个托管块（`## 项目知识库` + `@.iflow/knowledge/index.md`，由一对 `iflow-harness:knowledge` 注释标记包裹）；检测/注入/取消要遍历所有项目记忆文件，目标文件名遵循 CLI `contextFileName`，且不要在正文里内联写那对标记的字面量。
14. **亚克力材质**：`.acrylic` 只写标准 `backdrop-filter`（前缀写法会被构建链折叠掉）；带 `backdrop-filter` 的祖先形成 backdrop root，浮层用近不透明 tint；浮卡内全屏弹框用 `createPortal`。
15. **UI kit 唯一来源**：控件只住在 `webview/src/components/ui.tsx`（Composer 的提示 textarea 是唯一原生例外）；禁止 `text-[Npx]` / `rounded-[Npx]`；浮层菜单必须带 `shadow-float`；`Button` 是单行物种，不加 `py-*`。守卫 `test/ui-kit-guard.test.ts` 断言这些不变量。

## 常用命令

- `npm ci`：按锁文件安装依赖。
- `npm run typecheck`：`typecheck:host` + `typecheck:webview`。
- `npm test`：`vitest run` 单次运行，不依赖真实 CLI / API。
- `npm run build`：图标 + tsc + esbuild(host) + vite build webview。
- `npm run webview:dev` / `npm run webview:serve`：webview 增量构建 / 静态服务 `webview/dist`。
- `npm run vendor:cli` / `npm run defaults:sync`：生成裁剪内置 CLI / 同步本机默认规则。
- `npm run harness`（可加 `--record` / `--probe` / `--prompt`）：驱动真实 CLI 跑 ACP 全流程，需先 `npm run build`。
- `npm run lint:deps`：knip 死代码与依赖检查。
- `npm run package`：`vendor:cli --force` + `build` + `vsce package --no-dependencies`。
- `npm run icon`：仅重新生成 `media/icon.png`。
