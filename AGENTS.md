# AGENTS.md

## 项目概览

**iflow-harness**（产品名「心流·驭光」）是一个 VSCode 扩展，把 iFlow CLI 的 Agent 能力图形化接入编辑器：spawn 一个 `--experimental-acp --stream` 子进程，用 **NDJSON 分帧的 JSON-RPC 2.0** 双向通信，提供流式对话、工具审批、Diff 回退、会话持久化与恢复、API Profile、@文件补全、附件与选区上下文、`ask_user_question` 提问卡、Super Agent 子会话编排、QQ 远程渠道、记忆/知识库、检查点、MCP catalog 与诊断。

- **执行体固定为内置裁剪版定制 fork**：`vendor/iflow-cli`（默认源是仓库内 `vendor/iflow-fork` 快照）。扩展不探测 PATH / npm / 本机 CLI，没有 `iflow.cliPath`、没有 env 覆盖；`resolveVendoredEntry` 缺失即抛错——loader 补丁只存在于这个 bundle，跑官方包会静默改变 agent 行为，宁可报错不兜底。
- 技术栈：TypeScript 7（strict）+ React 19 + Tailwind CSS 4 + zustand 5 + Vite 8 + vitest 5。目标环境 VSCode `^1.90.0`，CI Node 22，esbuild target node20。
- 版本号规则见「发布流程」：`CHANGELOG.md` 顶部是唯一来源，`package.json` 的 `version` 必须与之同步。

## 架构:三层单向数据流

```
webview/ (React 投影)  ←── snapshot / blockPatch ←── shared/ (纯 reducer)  ←── ACP 事件 ──  src/ (Extension Host)  ←── NDJSON ──  iFlow CLI 子进程
webview/ (用户操作)   ──→ WebviewToHost 消息 ──→ src/panel/panel.ts 路由 ──→ AcpClient 调用
```

**核心原则：状态只存在于 Extension Host。** WebView 从不跑协议逻辑，只渲染快照（`shared/messages.ts` 注释里的 plan §2.1）。

| 目录 | 职责 |
| --- | --- |
| `src/extension.ts` | 激活入口、命令注册、`@iflow` chat participant、编辑器选区入口（Ask iFlow / 加入上下文 / 记住选区）、`warmStart` 预热、终端命令捕获 |
| `src/acp/client.ts` | spawn CLI + initialize 握手；实现 agent→client 的 `fs/read_text_file`、`fs/write_text_file`、`session/request_permission`、`_iflow/user/questions`、`_iflow/plan/exit`；`killTree` 进程树清理 |
| `src/acp/jsonrpc.ts` / `protocol.ts` | NDJSON 分帧（8MB 帧上限）+ JSON-RPC 路由 + `errorMessage` / `isRateLimitError` / `isContextOverflowError`；ACP wire 类型，iFlow 扩展点用 `// iFlow extension` 标注。`jsonrpc.ts` **零 VSCode 依赖** |
| `src/acp/cli-locator.ts` | `resolveVendoredEntry` 硬解析内置 `bundle/entry.js`（缺失即抛，无探测回退）；`locateNodeExecutable` 异步探测 Node（缓存 + 并发去重 + 跨窗口 globalState 持久化）；`ensureIflowDefaultConfigs` 把 `vendor/iflow-defaults/` 下的默认 `.json` 配置种到 `~/.iflow/`（只补缺失、永不覆盖）；`buildAcpCommand` 拼 `--experimental-acp --stream`，额外根以 `--include-directories` 传入（与 fs 回调边界同源） |
| `src/acp/auth.ts` / `api-profiles.ts` | openai-compatible 凭据与命名 Profile（SecretStorage）、热重认证；内核 Profile 读写 |
| `src/acp/models-query.ts` | 实时 `GET {baseUrl}/models`；读 CLI settings.json；归档过期 OAuth 缓存 |
| `src/acp/complete.ts` | 直连 `POST {baseUrl}/chat/completions`（stream），供 enhance / AI 标题 / 记忆提取 / 模型元数据等内部纯文本任务使用（陷阱 #26） |
| `src/acp/web-search.ts` + `shared/model-metadata.ts` | Bing `b_algo` → DDG 回退的宿主侧检索与页面抓取；提示词构造、JSON 信封解析与条目追加去重 |
| `src/acp/mcp-broker.ts` | MCP HTTP broker（stdio 转发 + 上游请求），`node:http(s)` 直连 |
| `src/acp/cli-tokens-limit.ts` | 上下文窗口 → `IFLOW_TOKENS_LIMIT` 的单一 resolver（user 覆写 > 接口配置档 > 内核配置 > 内核模型表 > 不推） |
| `src/acp/os-notify.ts` | 系统通知（macOS terminal-notifier / Windows SnoreToast；二进制由 `build` 从 `node-notifier` 复制到 `vendor/os-notify/`，随 VSIX 发布、不进 git） |
| `src/panel/panel.ts` | Webview 容器、消息路由、审批流、提问卡、Diff 回退、会话持久化、速率限制/上下文溢出恢复、token 用量、toast 生命周期（最大文件，新增职责优先下沉） |
| `src/panel/store.ts` | Host store：reducer 应用 + 节流快照 + 增量快照（`blockPatch`）锚定 + toast 序号/生命周期 + 流式用量刷新 |
| `src/panel/super-agent.ts` / `super-agent-host.ts` / `super-store.ts` | Super Agent 编排：并发池、每子会话独立 CLI 进程、免确认、串行自动合并/PR、看板投影、归档落盘与恢复 |
| `src/panel/worktree.ts` / `workspace-roots.ts` | worktree 隔离与合并（冲突自动 `merge --abort`）；根集合单一来源与 `@<根别名>/<路径>` 解析 |
| `src/panel/session-persistence.ts` / `session-restore.ts` | transcript 原子落盘与恢复链 |
| `src/panel/checkpoint-service.ts` / `checkpoints.ts` | 影子 git 检查点（不碰用户 `.git`，非 git 目录可用） |
| `src/panel/attachments.ts` / `tool-diff-service.ts` / `wire-log.ts` / `terminal.ts` / `status-presenter.ts` / `context-window-overrides.ts` | 附件暂存、工具 diff 合成与回退、wire 环形日志、终端命令记录、状态展示、窗口覆写推送 |
| `src/panel/qq-host.ts` / `qqbot-host.ts` | QQ 渠道宿主接线 |
| `src/memory/` | `files.ts` 记忆文件读写与事实增删、`discovery.ts` 层级发现、`service.ts` 面板服务（含知识库注入）、`knowledge.ts` 知识库扫描/提示词/托管块、`extract.ts` 候选解析 |
| `src/assets/` / `src/skills/` / `src/qq/` | 资产文档服务；Skill 根目录扫描；QQ 渠道（`service.ts` 任务派发/汇报/去重、`store.ts` 落盘、`adapter`/`qqbot/` 协议客户端、`config`/`wiring`/`settings-host`/`panel-host`） |
| `shared/messages.ts` | Host ↔ WebView 消息协议 + `Block` / `SessionState` 类型（两侧共用）+ `applyBlockPatch` + `evictBlockPayloads` |
| `shared/session-state.ts` | 纯会话 reducer（`applySessionUpdate`、SubAgent 归组、`parseTranscriptJsonl`、块 id 分配/回填、token 估算、MCP diff 合成、`withoutPlanModes`） |
| `shared/super-*.ts` | 子会话状态机（终态粘性）、委派指令解析、汇报、诊断与失败分类、波次规划、看板聚合、时间线、工具调用解析、白名单策略 |
| `shared/context-window*.ts` / `mcp-*.ts` / `turn-*.ts` / `notifications.ts` / `queue.ts` / `export.ts` / `hunks.ts` / `skills.ts` / `checkpoints.ts` / `model-metadata.ts` / `provider-presets.ts` / `error-advice.ts` / `session-nav.ts` / `context-source.ts` / `asset-*.ts` / `qq-*.ts` | 窗口与成本解析、MCP catalog/诊断、回合变更与回合末合并提示、通知门控、队列、导出、diff hunk、Skill 调用、检查点索引、模型元数据、Provider 预设、错误建议、会话导航、上下文来源、资产、QQ 纯逻辑 |
| `webview/src/` | `App.tsx` / `main.tsx` / `store.ts`（zustand + Web Audio 提示音 + `createMockHost`）/ `i18n.ts` / `styles.css` / `components/*`（控件统一收敛到 `ui.tsx`） |
| `scripts/` | `vendor-cli.mjs`（内置 CLI 裁剪与默认规则同步）、`harness.mjs`（ACP 联调）、`generate-icon.mjs`、`read-changelog.mjs`、`serve-webview.mjs` |
| `prompts/` | 提示词模板，esbuild 以 `loader: { ".md": "text" }` 内联进 bundle，VSIX 不含可读文件 |
| `test/` | vitest 用例；`test/fixtures/` 放探针/复现脚本（`*.ndjson`、`*.json` 录制产物被 gitignore） |

**Plan 模式已移除**：`withoutPlanModes` 从 `availableModes` 剔除 plan 并把落点归一到 smart/default；残留的 `_iflow/plan/exit` 由 `handleRemovedPlanExit` 记警告后自动放行（不弹卡、不入待办、不阻塞到超时）。

## 构建与运行

```bash
npm ci                 # 安装依赖
npm run typecheck      # typecheck:host (tsc -p tsconfig.json --noEmit) + typecheck:webview (webview 独立 tsconfig)
npm test               # vitest run（单次，非 watch）
npm run build          # icon + tsc + esbuild(host) + vite build webview
npm run icon           # 仅重新生成 media/icon.png
npm run webview:dev    # webview 增量构建（watch）
npm run webview:serve  # 静态服务 webview/dist（scripts/serve-webview.mjs，默认 127.0.0.1:8791）
npm run vendor:cli     # 从 vendor/iflow-fork 快照生成 vendor/iflow-cli
npm run defaults:sync  # 把本机 ~/.iflow/ 默认规则同步到 scripts/iflow-defaults/
npm run harness        # 驱动真实 CLI 跑 ACP 全流程（需先 build）
npm run lint:deps      # knip 死代码/依赖检查（CI 闸门）
npm run package        # vendor:cli --force && build && vsce package --no-dependencies
```

- 调试：`.vscode/launch.json` 提供 Extension Development Host 配置（F5）。
- 本地 F5 前必须 `npm run build`（`main` 指向 `./dist/extension.cjs`，webview 读 `webview/dist/index.html`），并至少跑一次 `npm run vendor:cli`——`vendor/iflow-cli` 被 gitignore，缺失时扩展直接报「内置 CLI 缺失」，这是刻意设计，没有本机 CLI 兜底。
- 打包产物是仓库根目录的 `iflow-harness-*.vsix`（含内置 CLI，体积以实际产物为准）。

## 内置 CLI(vendor,唯一执行体)

`scripts/vendor-cli.mjs` 把 CLI 打进 VSIX。要点：

- **默认来源是仓库内快照 `vendor/iflow-fork/`**（`IN_REPO_FORK_DIR`）：已裁剪的产物快照，进 git、被 `.vscodeignore` 排除出 VSIX，**不是 Mod 源码仓库**。CI 的普通 checkout 就能打包，不需要兄弟目录或 npm registry。
- **覆写来源**：`IFLOW_VENDOR_FORK_DIR=<外部 fork checkout>` 或 `--from-dir <dir>`；`--from <tgz>` 离线；`--version <v>` 才回到 npm registry 路径。
- **同步新 Mod 的链路**：在外部 fork checkout 注入 → `npm run vendor:cli -- --from-dir <新 fork> --force` 生成 `vendor/iflow-cli` → 把裁剪产物（去掉嵌套 `.gitignore`）同步回 `vendor/iflow-fork/` 并提交 → `npm run harness` 验收（改 PRUNE 清单尤其必须，见陷阱 #21）。
- **`--force` 不能省**：幂等检查只比 `package.json` version，同版本 ≠ 同内容（Mod 注入可以不 bump 版本）。
- **注入本体在 `bundle/iflow.js` 与 `*-loader.cjs`**（含 `super-agent-loader.cjs`），不在 `bundle/entry.js`；锚点必须唯一 + round-trip 校验，换 CLI bundle 版本后锚点会漂移、硬失败。
- **`memory-scope-loader.cjs`（save_memory 的 scope 参数）**：锚点是 `createToolRegistry()` 里的 `t(cA),`（`cA` 即上游 `save_memory` 工具类），已替换为一段 `(()=>{...})()` 注册块——`require("./memory-scope-loader.cjs").create({base:Li,kinds:Fi,icons:Mi,types:Dt,upstream:cA})` 返回的工具类同名替换，**不再保留裸 `t(cA),`**（否则会出现两个同名工具）。`scope` 可选值 `global|project`，**默认 global**（不传参与上游字节一致）；`global` 写 `Tn()/contextFileName`（`Tn()` 认 `IFLOW_HOME`，否则 `~/.iflow`），`project` 写 `config.getWorkingDir()/contextFileName`。写入本身完全委托上游 `cA.performAddMemoryEntry`，所以 `## iFlow Added Memories` 的字节布局不会漂移；`..` 段 / 绝对路径 / 越界路径一律拒绝。开关 `IFLOW_MEMORY_SCOPE=0|false` 直接返回上游类（等同原工具）；`upstream` 缺失时 `create()` 返回 null，锚点回退注册 `cA`。记忆仍在 `session/new` / `session/load` 时加载，热更新需新会话或恢复会话。
- **锚点来源**：外部 fork checkout 的 `reverse/` 分析工作区（可读化产物 + `ANALYSIS.md` 行号地图 + 指纹重扫脚本）。它不进仓库也不进 VSIX（`PRUNE_DIRS` 含 `reverse`）；单靠快照无法重做锚点定位，换版本前先在外部 fork 侧完成。
- **默认规则双目录**：源在 `scripts/iflow-defaults/`（进 git），构建复制到 `vendor/iflow-defaults/`；连接前只把 `~/.iflow/` **缺失的**规则文件种过去（`ensureIflowDefaultConfigs`），**永不覆盖**用户文件；`settings.json` / `iflow_accounts.json` / `oauth_creds*` 等携带凭据的文件固定不同步。
- **`.vscodeignore` 关键例外**：`node_modules/**` 被排除，但 `!vendor/iflow-cli/node_modules/**` 必须保留，否则 VSIX 安装后起不来（本地 dev 感知不到）。
- **Windows**：npm 调用统一走 `runNpm()`——优先 `process.execPath` 直跑 npm 自带的 `npm-cli.js`（跨平台零 shell，避开 `.cmd` shim 与 shell 转义），fallback 才是 PATH 上的 npm。解压用系统自带 bsdtar。

## 开发约定

### 分层纪律
- **纯逻辑放 `shared/` 或 `src/acp/jsonrpc.ts`**，保持零 VSCode 依赖以便单测。UI 组件不 import `vscode`。
- 新增 wire 消息类型必须同时更新 `shared/messages.ts` 的 `WebviewToHost` / `HostToWebview` 联合类型，两侧共用。
- 状态变更走 `shared/session-state.ts` 的 reducer，不要在 `panel.ts` 里就地改 state。
- 新增 transcript 块类型：加进 `Block` 联合并继承 `BlockBase`（带 `id?`），同时确认 `backfillBlockIds` 的递归路径覆盖到。

### TypeScript
- `strict: true` + `noUncheckedIndexedAccess: true` + `noUnusedLocals: true`。数组索引访问必须显式处理 `undefined`。
- `module: Node16` / `moduleResolution: Node16`，**import 必须带 `.js` 扩展名**（即使源文件是 `.ts`）。
- 主 `tsconfig.json` include `src` + `shared` + `prompts`；webview 有独立 `tsconfig.json`（Bundler resolution、DOM lib、React JSX、noEmit），由 `typecheck:webview` 检查，不参与 host 编译。
- `tsconfig.test.json` 存在但**有既有报错且未被任何 workflow 引用**，不在 CI 闸门内——修它属于独立任务，别混进发版。
- `shared/gpt-tokenizer.d.ts` 声明 `gpt-tokenizer` 模块（无官方类型）。

### 构建产物
- `package.json` 是 `"type": "module"`，但扩展宿主需要 CJS → esbuild 输出 `dist/extension.cjs`（`.cjs` 后缀刻意）。
- esbuild（`esbuild.mjs`）只 bundle `src/extension.ts`，`vscode` external，target node20，`minify` + `keepNames`，`.md` 以 text 内联；同一步把 `node-notifier` 自带的通知二进制复制到 `vendor/os-notify/`（该依赖只为取这些二进制，从不被 import）。
- tsc 同时把 `src/`、`shared/`、`prompts/` 编译到 `dist/`（`dist/src/acp/*.js` 供 `scripts/harness.mjs` 导入），这些中间产物与 sourcemap 被 `.vscodeignore` 排除出 VSIX。

### 本地化(l10n)
- 用户可见字符串一律 `vscode.l10n.t("中文原文", args)`，**中文是源语言**。
- 扩展清单字符串走 `package.nls.json` / `package.nls.zh-cn.json`（`%key%` 占位）；webview 走 `webview/src/i18n.ts` + `l10n/bundle.l10n.en.json`。
- 测试用 `test/vscode-stub.ts` 把 `vscode.l10n.t` 做成恒等翻译，断言直接写中文字面量。
- 双轨 l10n 是已知架构债：host 走 VSCode l10n 工具链、webview 走运行时字典，合并属架构级重构，当前维持现状。

### 控件体系(UI Kit)
- **控件之家只有一个**：所有表单/交互控件住在 `webview/src/components/ui.tsx`，组件文件不得自绘控件、不得复制按钮/输入框类串。原生 `<input>` / `<textarea>` / `<select>` / `type="checkbox"` / `type="range"` **只允许出现在 ui.tsx**；唯一例外是 `Composer.tsx` 的提示输入 textarea（多行提示 + 历史召回 + slash 弹窗 + IME 安全 Enter，守卫断言恰好 1 处）。
- **控件清单**：`Button`(variant × size)、`IconButton`(tone default/danger/primary)、`DisclosureButton`、`TextInput` / `TextArea` / `CommitTextInput` / `CommitTextArea` / `CommitNumberInput` / `LinesCommitTextArea` / `SearchInput`、`Select`(自定义浮层下拉，非原生 `<select>`)、`MenuItem`(主文案 + 可选 `description` / `icon` / 勾标，值选择用 `role="menuitemradio"` + `aria-checked`)、`Switch`、`Checkbox`、`ToggleChip`、`OptionGroup` + `OptionCard`(`emphasis` 表达推荐态而非已选中，`ariaLabel` 供可访问名与可见文案不同时)、`Segmented`(页内分段选择，必须是 `radiogroup`)、`Slider`、`TabButton` + `rovingTabKeyDown`、`Dropdown`、`ModalShell` / `ConfirmDialog` / `ImageLightbox`、`Chip` / `HelpTip` / `Field` / `FieldLabel` / `Hint` / `ActionRow` / `ToolbarRow` / `SettingsGroup` / `SettingsRow` / `SettingsDisclosure`、`FloatPill` / `FloatChip` / `CountdownSeconds` / `CountdownBar` / `ToastStack`、`FileRef`。同屏值选择用 `Segmented`（设置页经 `SettingsModal` 的 `ChoiceRow` 包装），不要改用 `Select`。
- **命名约定**：受控值一律 `value` + `onChange`；提交类字段用 `onCommit`；按钮 `variant` / `size`；输入 `mono`（等宽值）与 `invalid`（错误态）；图标按钮必须给 `aria-label`（与 `title` 同文）；禁用统一 `disabled:pointer-events-none disabled:opacity-40`。
- **可访问名**：单控件字段用 `Field`（渲染 `<label>` 包裹控件，隐式关联），不要「裸 div + `FieldLabel` span」；多控件分组逐个给显式 `aria-label`；`placeholder` 只是弱标签，不算可访问名。
- **语义分离（同一功能不得多通道）**：跨页导航用 tab（`role=tablist` + `TabButton` + `rovingTabKeyDown`）；同屏值选择用 `Segmented` / `ToggleChip` / `OptionGroup`；开关用 `Switch`、勾选用 `Checkbox`；数值用 `Slider`。不要为省事把 tab 降级成按钮组，反之亦然。`Segmented` 的选中项是唯一 tab 停靠点（`tabIndex` 0/-1），Arrow/Home/End 移动并跳过 `disabled`——旧 `role="group"` + `aria-current` 按钮组已废弃。
- **提交语义两档**：设置页字段走草稿 + blur/Enter 提交（`Commit*` 系列，IME 安全：`isComposing || keyCode === 229` 时不提交）；表单/向导字段走实时受控。
- **视觉档位**（不新增任意值）：控件高度 28px(`md`) / 24px(`sm`)，图标按钮 28×28 / 24×24；圆角五档 `inner 4` / `control 6` / `card 8` / `overlay 12` / `bubble 16`（嵌套按外大内小降一级）；图标三档 `ICON_INLINE` 14 / `ICON_TOOLBAR` 16 / `ICON_DISPLAY` 20（按钮内用 flex gap，不手工偏移）；字号只用语义类 `text-ui-title/body/label/caption/micro`（+ `display`），禁止 `text-[Npx]`；圆角禁止 `rounded-[Npx]`；字号/密度由 `--ui-font-scale`、`--ui-density` 缩放，普通 CSS 固定 padding/gap 也要响应密度；布局间距 token 为 2/4/8/12/16/24，控件内部光学间距（chip、图标与文字、紧凑按钮）保留 2/6/10 不强行归入网格。
- **阴影按表面选 token**：次级按钮边框即表面（无阴影），主按钮渐变 + `shadow-btn` / `hover:shadow-btn-hover`，canvas chip 走 `shadow-card`，浮层胶囊与下拉菜单走 `shadow-float`（负 spread 的 `--shadow-panel` / `--shadow-card` 在 24–38px 高的浮层上会塌陷）；`acrylic-pop` 自带的面板投影只留给 `ModalShell`，浮层必须同带 `shadow-float`。
- **浏览器原生字段外观由 kit 接管**：`styles.css` 的 kit 段负责 number 微调箭头、autofill 黄底、`caret-color`、`::selection`；textarea 一律 `resize-none`，高度由 `.ui-resize` 手柄负责（调用点不得写 `resize-*`，自带尺寸编辑器传 `resizable={false}`）；密码字段用 `TextInput revealable`（kit `IconButton` 替代 Chrome 内置眼睛）。
- **Button 是单行物种**：固定 28/24px 高，只放一行文案；两行内容用 `OptionCard` / `MenuItem`，**不要**给 `Button` 加 `py-*` 撑高（内容会溢出自身边框）。
- **按钮跟随所在表面的色调**：警告/错误表面上的动作按钮穿该色调（`variant="warning-soft"` / `"danger-soft"`，即 `WARNING_SOFT` / `DANGER_SOFT`），中性表面仍用 `secondary` / `canvas`，粘性决策卡保留 primary。`ErrorBoundary` 内联回退卡是琥珀底 → `warning-soft`，整页回退是中性底 → `canvas`。
- **浮层与边界**：下拉/浮层需视口夹取，窄屏右对齐菜单用 `align=right` 向内展开；`ModalShell` 给 `initialFocus`；审批卡/提问卡**不受 streaming 门控**（陷阱 #12）；渐进披露用 `group-hover` / `group-focus-within` 的 opacity 组，不靠 `hidden`；`data-variant="danger"` 只被 Dropdown 的键盘导航选择器消费，非菜单按钮的危险语义由 `tone="danger"` 承担；浮卡内的全屏弹框必须 `createPortal(..., document.body)`（陷阱 #22）。
- **守卫**：`test/ui-kit-guard.test.ts`（`npx vitest run test/ui-kit-guard.test.ts`）静态扫描 `webview/src`，断言原生控件只在 ui.tsx（+ Composer 那 1 处 textarea）、主按钮渐变串与按钮基串只在 ui.tsx、无 `accent-[` / `text-[Npx]` / `rounded-[Npx]`、`icon={<… className="size-3.5" />}` 走 `ICON_INLINE`、`Button` 不带 `py-*`、`type="password"` 必须同元素带 `revealable`、颜色 utility 必须命中主题 token、`acrylic-pop … dropdown-in` 必须带 `shadow-float`、kit 导出成员齐全；含手柄拖拽与显隐切换的 jsdom 行为用例。**新增控件要把成员名加进守卫清单并一起提交。**

### 安全与凭据
- 审批默认拒绝（`outcome: "cancelled"`）；审批卡与提问卡共用 `APPROVAL_TIMEOUT_MS`（5 分钟）超时兜底——审批超时按拒绝、提问超时按空答案继续，避免 agent 永久阻塞。
- Webview HTML 注入 nonce CSP（`script-src 'nonce-...'` + `cspSource`），资源引用重写为 `webview.asWebviewUri`；markdown 渲染过 DOMPurify，显式 `FORBID_TAGS: ["iframe","form"]` + `FORBID_ATTR: ["style","target"]`（`webview/src/components/Markdown.tsx`）。
- 附件上限：data URL 图片 8MB（`MAX_IMAGE_ATTACHMENT_BYTES`），>5MB 图片（`ATTACHMENT_IMAGE_MAX_BYTES`）降级为文件附件；附件暂存目录有 7 天清理。
- `openExternal` 仅放行 `^https?://`。
- API key / token 只存 VSCode SecretStorage，不落盘、不进日志；写 `~/.iflow/settings.json` 用 tmp + 覆盖式 rename（去掉先 unlink，避免「文件瞬空」被 CLI 整文件回写吞键），rename 遇占用按退避重试、失败可见。
- 扩展侧文件回调限制在工作区范围（`allowedRoots` / `--include-directories` 同源），但执行类工具跑在本机真实 shell，审批卡不是沙箱。

### 记忆与知识库
- CLI 层级记忆 loader 硬编码 `os.homedir()/.iflow`（不认 `IFLOW_HOME`），面板统一用 `memoryHome()`；`~/.iflow/memory.md` 当前 loader 不读取，只能作遗留文件展示；ACP 下 `/memory add` 不执行，快捷记忆必须由扩展直接写文件；记忆在 `session/new` / `session/load` 时加载，热更新要重启 CLI 并恢复会话。**注意两条路径口径不同**：`save_memory` 写 `Nz() = join(Tn(), contextFileName)`，而 `Tn()` **认 `IFLOW_HOME`**（未设置才回落 `~/.iflow`）；层级 loader 才是不认 `IFLOW_HOME` 的那个。`memory-scope-loader.cjs` 新增可选 `scope`（`global` 默认 / `project` 写 `config.getWorkingDir()`），写入仍委托上游 `performAddMemoryEntry`。
- 事实追加/删除按 `## iFlow Added Memories` 节处理（`MEMORY_MARKER`），项目记忆文件名遵循 CLI `contextFileName`，不硬编码 `AGENTS.md`。
- 知识库注入用文末的托管块（`setManagedKnowledgeBlock` 生成 `## 项目知识库` + `@.iflow/knowledge/index.md`，由一对 `iflow-harness:knowledge` 注释标记包裹）；检测/注入/取消必须遍历所有项目记忆文件（陷阱 #30）。**正文里不要内联写那对标记的字面量**——`setManagedKnowledgeBlock` 取第一个匹配，重复出现会把中间段落当成托管块内容替换掉。

## 已知陷阱(代码注释里踩过并验证过的,改代码前必读)

> 编号被代码注释与测试注释直接引用（`pitfall #N` / `陷阱 #N`），**不要重排**。

1. **模型下拉数据源**：必须实时 `GET {baseUrl}/models`。CLI 的 `_meta.models.availableModels` 是硬编码目录，**不可作为回退**——端点不可达就返回空列表，仅把 `currentModelId` 补到列表头避免下拉空白。
2. **绕过全局 `fetch`**：扩展宿主被代理 agent patch 过，SOCKS 或无 scheme 的系统代理会抛 "Invalid URL protocol"。`models-query.ts`、`complete.ts`、`mcp-broker.ts`、`web-search.ts` 一律用原生 `node:http(s)` 直连。
3. **CLI 的 ACP 会话持久化**：`--experimental-acp` **不写**交互模式的 `~/.iflow/projects/.../session-*.jsonl`，但每轮 `session/prompt` 的 `finally` 都会写 `~/.iflow/acp/sessions/<sessionId>.json`（`{sessionId, cwd, createdAt, lastActivity, chatHistory}`）。`session/load` 读该文件并 `setHistory()` 重建内存历史——这正是「删除用户消息」做上下文真删除的机制（截断 chatHistory + reload）。扩展仍在 `storageUri/transcripts/` 自持渲染真值副本。
4. **`session/load` 不回放历史**：CLI 只返回 `{sessionId}`（无 modes、无 `_meta`），所以先 `newSession` 取 meta 再 `loadSession`，transcript 从文件重建；probe 会话被有意丢弃，非泄漏。
5. **`set_mode` / `set_model` 不推通知**：agent 不 emit `current_mode_update`，必须把响应里的 `currentModeId` / `currentModelId` 乐观写回 store，否则下拉会弹回；入口必须判空 `sessionId`（空串照发会被 CLI 乱绑定）。
6. **`diff.path` 可能不可信**：CLI 可能发工具调用视角的相对路径。真实路径常在 `tool_call.locations`。定位策略：多候选（`diff.path` + `locations`）→ 按「磁盘内容 === diff.newText」优先 → basename 有界搜索 → QuickPick → 文件选择器；MCP diff 合成同理。
7. **CLI 定位别扫二进制**：多版本管理器可能把入口指向原生 dispatcher，当文本读会卡死扩展宿主。任何 shelling out 的探测都必须异步 + 有上限；二进制内容不能用 utf8 往返（`tool-diff-service` 用首 1KB NUL 字节判定）。
8. **相对路径基准**：agent 给的相对路径要拼 `sessionCwd`（session 创建时的 workspace 根），**不是** `process.cwd()`；`openLocation` 行号 clamp 到 `[0, lineCount - 1]`。
9. **文件写入走 `vscode.workspace.fs`**：不要用裸 `fs.writeFile`，会绕过 VSCode 的文件 watcher。
10. **SubAgent 归组双策略**：优先 wire 上的 `agentId`（位置在 **`update.agentId`**，`extractAgentId` 三处都读）；这些事件由独立适配器推送，sessionId 是硬编码哨兵。无 `agentId` 时退化为按 `toolCallId` 精确归属对应卡，匹配不到才开新卡；`adoptUnboundSubAgent` 按 **FIFO** 收养。**不要退回旧的「区间状态机」**（并行 task 会把第二个 task 的 tool_call 混进第一张卡）。新增丢弃规则前必须实证 CLI 侧事件生产者的字段形态，守卫基于「可归属」而非 sessionId 一刀切。
11. **Windows**：命令用 `process.execPath` 直接跑 `entry.js`，避开 `.cmd` shim 与 Unix shebang；`spawn` 带 `windowsHide: true`。
12. **提问卡不能被 streaming 门控**：提问在 prompt 进行中到达（`status: streaming`），agent 正阻塞等答案，按钮必须可用；不要复用「生成中禁用操作」的防呆逻辑。生成中禁用的下拉触发要用显式 disabled 硬门控（点击会穿透到 Dropdown 内部代理）。
13. **prompt 无超时**：`AcpClient.promptTimeoutMs` 默认 `0`——真实任务可能跑数小时，中断只由用户显式 Stop（`session/cancel`）驱动。`sendPrompt` 的 `initializing`/`streaming` 并发闸门必须保留（`iflow.askSelection` 与 `@iflow` participant 绕过 webview 的 busy 锁）。
14. **空设置教训**：曾声明 `iflow.idleTimeoutMinutes` 但 `src/` 零引用，长期是空设置（已删除）。新增设置项必须同步实现、同步两份 nls；`test/settings-declared.test.ts` 是「manifest 声明 → 键集合 → nls 引用可达」的对账回归锁。
15. **`--baseContentUrl` 不可用**：`docs/**` 被 `.vscodeignore` 排除，README 里的 `docs/images/*` 链接在 Marketplace 预览中打不开——刻意取舍，别「好心」把 docs 加回包。
16. **blockPatch 锚定**：`baseVersion` 与接收端 `blockVersion` 不一致、或 `tailStart` 越界，都必须回退到全量重同步（webview 发 `ready`），不能硬合并。
17. **reducer 就地改 blocks**：`tailOnly` 依赖尾部指纹，中段变更对指纹不可见，会保守清 flag 回退全量——别为了「优化」去掉；中段工具更新走 store 的 `mutatedFrom` 增量路径。
18. **外部进程探测必须异步**：`where.exe` / `node --version` 在 Windows 可达数秒，`execFileSync` 会冻结整个扩展宿主。`locateNodeExecutable` 是 async + 缓存 + 并发去重 + globalState 持久化，成功结果用 `existsSync` 复验、失败不缓存。此纪律适用于任何 shelling out 的探测。
19. **`chatForward` 等待条件**：必须在 `idle || error` 时退出（prompt 失败后 status 永不回 idle），cancel 只发一次，并有 10 分钟总超时兜底。
20. **连接失败要 dispose 子进程**：initialize 超时/握手失败后 CLI 进程会继续存活；`AcpClient.connect()` 内部与 `ensureClient` catch 两处都要 `dispose()`（幂等，双重调用安全）。
21. **vendor 裁剪变更必须重测**：增删 `PRUNE_DIRS` / `PRUNE_PKGS` 前先对裁剪副本跑 `npm run harness` 全流程；`.vscodeignore` 的 `!vendor/iflow-cli/node_modules/**` 例外一旦丢失，只有 VSIX 安装才炸。
22. **亚克力材质**：`.acrylic` 只写标准 `backdrop-filter`（esbuild 会把 `-webkit-` 别名折叠掉，现代 Chromium 忽略前缀写法，模糊会静默消失）；带 `backdrop-filter` 的祖先会形成 backdrop root，其内部浮层改用近不透明 tint 而不是再叠模糊；`.acrylic` 的 `backdrop-filter` 会给 `fixed` 后代建立包含块，叠加 `overflow-hidden` 会裁切弹框，浮卡内全屏弹框必须 `createPortal(..., document.body)`。
23. **CLI 模型双变量**：`set_model` 只改 `contentGeneratorConfig.model`，**永不回写** `Config.model` / settings.json；而 `session/new` 的 `_meta.models.currentModelId` 取自 `Config.model`（CLI 启动值）。所以面板 store 的 `currentModelId` 是权威，`startNewSession` / `restoreSession` 的回退链必须含它，新会话前用 `validateModelForPush` 对 live 列表校验——模型已下架则回退启动模型并警告。不要反过来信任 `session/new` 的上报值。
24. **流式渲染会 CRASH 面板**：病态 markdown 块或 hooks 数量不一致会让 React 整树卸载只剩 body 渐变。`ErrorBoundary`（page 在 `main.tsx`、inline 在 `MessageList`）+ `resetKey` 自愈是底线；所有 hooks 必须在条件返回之前。
25. **模型下架陷阱**：盲赋值一个已不在 live `/models` 列表的模型，每次 prompt 都会 `model_not_found`。`validateModelForPush` 只对「能证明下架」的结果降级；空/失败的查询不构成证据，照常推送。
26. **内部纯文本任务不走 CLI 会话**：enhance / AI 标题 / 记忆提取 / 模型元数据 / 资产草稿这类任务不需要工具面，而 CLI 会话固定携带系统提示 + 全量工具 schema（约 61K tokens 固定输入），慢网关会把它推进长时间思考甚至永不 settle。现行实现是 `src/acp/complete.ts` 的 `streamChatCompletion` 直连 OpenAI 兼容端点，发送前 `stripFileMentions` 去掉 `@` 标记（`@路径` 是循环诱因），超时 180s / idle 90s / timeout·stalled 时 salvage 已流出的正文、transport 失败丢弃。给 LLM 调用选通道先问「这任务需要工具面吗」。
27. **长会话内存三纪律**：转录全量驻留 host + webview 两份，重 payload 块数无上界。①webview 侧 `evictBlockPayloads` 释放保留窗口之外的重 payload，块数 `EVICT_KEEP_BLOCKS`（须大于 MessageList 的 `MAX_WINDOW`）与字节预算 `EVICT_BUDGET_CHARS` 双上限谁先触谁算，**host 全量是保真承诺**，绝不在 host 裁；②`WireRingBuffer` 帧数 + 字符预算双上限，最新一帧恒保留；③`Collapse` 折叠体首次打开才挂载；④`DiffView` 只渲染 `INITIAL_RENDER_ROWS` 前缀、接近底部再追加。
28. **记忆文件路径与写入**：见「记忆与知识库」——loader 认 homedir 不认 `IFLOW_HOME`，`memory.md` 不注入，`/memory add` 在 ACP 下不执行。
29. **记忆写入回包串包**：`memorySaved` 是广播消息，快捷添加弹窗必须按 `requestId` 过滤，否则会把别的写入当成自己的成功回包并吞掉真实失败。
30. **知识库注入不能只看 primary 记忆文件**：CLI 会加载 primary + 祖先 additional + 递归 hierarchy 的 `AGENTS.md`/`IFLOW.md`；`knowledgeState` / `setKnowledgeInjection` / `ensureKnowledgeImport` 必须遍历所有 exists && editable 的项目记忆文件并做重复检查，取消注入要从所有文件移除，目标文件名遵循 CLI `contextFileName`。
31. **多子会话打破「单会话单进程」**：子会话走**独立 CLI 进程**（各带 cwd 与凭据），转录不进主 `blocks`（会污染主转录并破坏 blockPatch 锚），状态投影到 `SessionState.superSessions`，提问落 `SuperSessionUi.pending`——**审批不产生待办**（子会话始终免确认，宿主直接放行 `request_permission` / `plan/exit`）。新增子会话消息先确认不与主会话的 pending 槽位抢位。子会话 `allowedRoots` 只含 worktree 根、`--include-directories` 传空，否则 CLI 侧路径判定会放行写主工作区。自动合并必须在串行 promise 链里（`super-agent-host.ts`），且先验 `MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` 再 `git merge-tree --write-tree` 预演，只有「预演路径 ∩ 用户未提交的已跟踪改动」非空才让路，绝不自作主张替用户 commit / stash / 撤销改动。免确认 + shell 工具不受 `allowedRoots` 约束，看板与汇报必须如实标注「免确认」。
32. **子会话 worktree 的 `node_modules` 不能与 `npm ci` 共存**：worktree 里指向主仓 `node_modules` 的目录联接本身安全（`npx vitest` / `tsc` / `vite build` 只读不写），但**永远不要**在联接存在时执行 `npm install` / `npm ci`——`npm ci` 第一步就删 `node_modules`，会顺着联接清掉主仓那份。要真装依赖先删联接再在 worktree 内 `npm ci`。派发子会话的任务书必须写明这条。
33. **设置持久化禁止整文件重写**：历史回归——曾用「读全量 JSON → 改 → 整文件写回」的路径把 `settings.json` 完全覆写，用户所有设置丢失。纪律：VSCode 配置只走 `vscode.workspace.getConfiguration(...).update(key, value, ConfigurationTarget)` 单键合并；`~/.iflow/settings.json` 只能走现有的 `updateCliSettings`（tmp + 覆盖式 rename，单键合并，见「安全与凭据」节），禁止另写一套、禁止裸 `fs.writeFile`。任何涉及设置落盘的改动，验证时必须确认「原有键不丢」。另外「设置写入失败」类 toast 必须带上真实错误信息，否则用户无法定位（只读 / JSON 损坏 / Settings Sync 冲突 / 旧 vsix）。

## 测试

- 框架 vitest 5，配置在 `vitest.config.ts`（`include: ["test/**/*.test.{ts,tsx}"]`，`testTimeout` / `hookTimeout` 5000ms）。用例数量以 `npm test` 输出为准，不要引用文档里的数字。
- `vscode` 模块通过 alias 指向 `test/vscode-stub.ts`（只提供 `l10n.t` 恒等实现）。`test/fixtures/` 放探针与复现脚本；`--record` 产物（`*.ndjson` / `*.json`）被 gitignore，不入库。
- 约定：测纯逻辑，不起真实 CLI、不碰真实 SecretStorage；需要文件 I/O 用 `mkdtempSync` + `afterAll` 清理；UI 组件用 jsdom（`// @vitest-environment jsdom`）。
- **vitest 参数口径**：**全量回归用 `npx vitest run`**（保持默认 per-file 隔离）。`--no-isolate` 会让 `vi.mock` 跨文件泄漏，产生大量假失败；`--no-file-parallelism --no-isolate --pool=forks` 只在单文件定向排查时用。
- Windows 上 `test/attachments.test.ts` 的 broken-symlink 用例需要创建符号链接权限，非特权环境会 EPERM——属环境限制，不是回归。
- 已知技术债：①`tsconfig.test.json` 有既有报错且不在 CI 闸门内；②测试会把 worktree 夹具写进真实的 `~/.iflow/super/worktrees/`（无界增长，体积可忽略）；③CLI 侧 `saveSettings` 仍是非原子整文件写——上游未根治，宿主只是不再放大成「永久丢键」。

## 联调与验证

```bash
npm run harness                                  # initialize → newSession → prompt，权限全拒（安全）
npm run harness -- --record                      # 额外录制 wire 日志（gitignore，不入库）
npm run harness -- --probe                       # 探 set_mode / set_model / set_think（不发 prompt）
npm run harness -- --prompt "..."                # 自定义 prompt
IFLOW_CLI_ENTRY=/path/to/entry.js npm run harness  # 覆盖入口（vendor 裁剪验收用）
```

`harness.mjs` 从 `dist/src/acp/*.js` 导入（需先 `npm run build`），因此它同时是「构建产物可用性」的冒烟测试；对裁剪后的 `vendor/iflow-cli` 跑它也是 vendor 变更的验收手段（陷阱 #21）。任何「CLI 行为」的假设都应在代码注释里标注验证来源（版本 + 实测方式），沿用 `Wire behavior (probed, CLI 0.5.19)` 的风格。

## 发布流程

- **`CHANGELOG.md` 是版本唯一来源但「双处同步」**：release 流程从顶部 `## [x.y.z] - date` 读版本与摘要（`scripts/read-changelog.mjs`），再写进 `package.json`。新增版本时**同时更新 CHANGELOG 与 `package.json.version`** 再提交——单独 bump `package.json` 会被 CI 覆写回 CHANGELOG 里的旧号，商店与仓库永远对不上。
- 两个 workflow 都**只针对 `release` 分支**，master 不跑 CI：`ci.yml` 在 push 与 PR 到 release 时触发；`release.yml` 在 push 到 release 与手动 `workflow_dispatch` 时触发。
- `ci.yml`：三平台矩阵（ubuntu/windows/macos）跑 `npm ci` → typecheck → lint:deps → test → build。
- `release.yml`：npm ci → typecheck → lint:deps → test → 读 CHANGELOG → 写 version 进 package.json → `npm run package` → 原生 `gh` 三态发版 → `vsce publish --oidc`。
- **release 三态幂等**：已存在 draft → `upload --clobber` + `edit --draft=false`；已发布 → 仅 refresh asset（绝不 re-edit，否则会重置回 draft）；不存在 → `gh release create`（默认发布态，必须带 `--target $GITHUB_SHA`，否则 tag 会落在默认分支 HEAD）。别退回 `softprops/action-gh-release`。
- 打包命令是 `vsce package --no-dependencies`，**不带** `--baseContentUrl` / `--baseImagesUrl`（`docs/**` 已排除，见陷阱 #15）。
- 发布前若改过本机 `~/.iflow/` 默认规则，先 `npm run defaults:sync` 再提交；新增用户可见设置项要同步 `package.nls.json` + `package.nls.zh-cn.json`。

<!-- iflow-harness:knowledge:start -->
## 项目知识库
@.iflow/knowledge/index.md
<!-- iflow-harness:knowledge:end -->
