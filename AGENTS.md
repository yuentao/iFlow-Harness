# AGENTS.md

## 项目概览

**iflow-harness**(产品名「心流·驭光」)是一个 VSCode 扩展,把 iFlow CLI 的 Agent 能力图形化地接入编辑器。它通过 **ACP(Agent Client Protocol)** 驱动 CLI:spawn 一个 `--experimental-acp --stream` 子进程,用 **NDJSON 分帧的 JSON-RPC 2.0** 双向通信,提供流式对话、工具审批、Diff 回退、会话持久化、API Profile 管理、@文件补全、附件与选区上下文、ask_user_question 提问卡、Plan 模式审批、速率限制与上下文溢出的自动恢复。**执行体固定为扩展内置的裁剪版定制 fork(`vendor/iflow-cli`,源 `@yuentao/iflow-cli`)**——loader 补丁只存在于这个 bundle 里,扩展不探测、不使用本机安装的 CLI,也没有任何 env/设置覆盖(2026-10-07 移除探测回退链)。

- 技术栈:TypeScript 7(strict)+ React 19 + Tailwind CSS 4 + zustand 5 + Vite 8 + vitest 5
- 目标环境:VSCode `^1.90.0`,Node 22(CI)/ node20(esbuild target)
- 仓库:`package.json` 声明 GitHub(`https://github.com/yuentao/iFlow-Harness.git`),但实际 `git remote` 仍指向内部 GitLab(`https://git.pandorastudio.cn/product/iFlow-harness.git`)——两处不一致,改发布配置时注意别踩空
- 当前版本:见 `CHANGELOG.md` 顶部(现为 `3.11.2` / 2026-11-23,与 `package.json` 的 `version` 一致)。**版本对齐硬性要求**:`package.json` 的 version 必须与 CHANGELOG 顶部 `## [x.y.z]` 保持一致再提交——release workflow 从 CHANGELOG 读版本并覆写 package.json,若两者漂移(如为覆盖商店缓存手动 bump 版本却不改 CHANGELOG),CI 会把版本覆写回旧号,商店与仓库永远对不上(2026-09-13 实际踩坑:商店已 1.0.3,仓库 CHANGELOG 还停留在 1.0.2、package.json 停留在 1.0.1)。发布前自检:`grep '"version"' package.json` 与 `head -6 CHANGELOG.md` 必须一致。
- 版本历史:0.1.0(2026-08-30 首版)→ 0.2.0(2026-09-07 全新 UI)→ 1.0.0(2026-09-11 提问卡/附件/内置 CLI 等)→ 1.0.1(2026-09-12 模型下拉修复)→ 1.0.3/1.0.4(2026-09-13 商店上架/倒计时与视觉升级)→ 1.0.5(2026-09-13 下拉硬门控/滚动锚定修复)→ 1.1.0(2026-09-15 token 用量/toast 浮层/Plan 确认卡/消息编辑回归)→ 1.1.1(2026-09-15 白屏崩溃/输入框拖拽/vendor bin 修复)→ 1.1.2(2026-09-19 Plan 计划编辑/历史下拉/set_model 对齐)→ 1.2.0(2026-09-21)→ 1.2.1(2026-09-21)→ 1.2.2(2026-09-21)→ 1.2.3(2026-09-27)→ 1.2.4/1.2.5(2026-10-02)→ 1.2.6/1.2.7(2026-10-04)→ 1.2.8(2026-10-05)→ 1.2.9(2026-10-07)→ 1.3.0(2026-10-10)→ 1.4.0(2026-10-10)→ 1.5.0(2026-10-11)→ 1.6.0(2026-10-13)→ 2.0.0(2026-10-23)→ 2.1.0(2026-10-27)→ 2.2.0(2026-11-09)→ 3.0.0/3.0.1(2026-11-15)→ 3.1.0/3.1.1(2026-11-15)→ 3.2.0/3.2.1(2026-11-15)→ 3.2.2(2026-11-16)→ 3.11.2(2026-11-23 当前)

## 架构:三层单向数据流

```
webview/ (React 投影)  ←── snapshot / blockPatch ←── shared/ (纯 reducer)  ←── ACP 事件 ──  src/ (Extension Host)  ←── NDJSON ──  iFlow CLI 子进程
webview/ (用户操作)   ──→ WebviewToHost 消息 ──→ src/panel/panel.ts 路由 ──→ AcpClient 调用
```

**核心原则:状态只存在于 Extension Host。** WebView 从不跑协议逻辑,只渲染快照(`shared/messages.ts` 注释里的 plan §2.1)。

| 目录 | 职责 |
| --- | --- |
| `src/extension.ts` | 激活入口、命令注册、`@iflow` chat participant、编辑器选区入口(Ask iFlow / 加入上下文)、`warmStart` 后台预热 |
| `src/acp/client.ts` | spawn CLI 子进程 + initialize 握手;实现 agent→client 的 `fs/read_text_file`、`fs/write_text_file`、`session/request_permission`、`_iflow/user/questions`、`_iflow/plan/exit`;`killTree` 进程树清理 |
| `src/acp/jsonrpc.ts` | NDJSON 分帧(8MB 帧上限)+ JSON-RPC 路由 + `errorMessage` / `isRateLimitError` / `isContextOverflowError`。**零 VSCode 依赖**,可被任意 IDE 集成复用 |
| `src/acp/protocol.ts` | ACP wire 类型;iFlow 专有扩展点用 `// iFlow extension` 标注(`_iflow/user/questions`、`_iflow/plan/exit`、`session/set_think`) |
| `src/acp/cli-locator.ts` | `resolveVendoredEntry` 硬解析内置 CLI `bundle/entry.js`(唯一入口,缺失即抛错,无探测回退)与定位可用 Node 可执行文件(异步探测 + 缓存 + 并发去重 + **跨窗口 globalState 持久化**);`seedDefaultRuleConfigs` 把内置默认规则种到 `~/.iflow/`;`buildAcpCommand` 拼 `--experimental-acp --stream`,并把额外 workspace 根以 `--include-directories` 传入(与 fs 回调边界同源) |
| `src/acp/auth.ts` | openai-compatible 凭据 + 命名 Profile(全部存 VSCode SecretStorage);支持热重认证(切换 Profile 免重启 CLI) |
| `src/acp/models-query.ts` | 实时 `GET {baseUrl}/models` 取模型列表;读 CLI settings.json;归档过期 OAuth 缓存 |
| `src/panel/panel.ts` | Webview 容器、消息路由、审批流、提问卡、Plan 审批、Diff 回退、会话持久化、速率限制/上下文溢出重试、token 用量估算、toast 生命周期(最大的文件,~3250 行) |
| `src/panel/store.ts` | Host 侧 store:reducer 应用 + 节流快照 + P-1 增量快照(`blockPatch`)锚定 + toast 序号/生命周期 + 流式期间 500ms 用量刷新 |
| `src/panel/super-agent.ts` | Super Agent 子会话编排:并发池(默认 5、范围 1–20、设置面板可调 + FIFO 排队)、每子会话一个独立 CLI 进程、**子会话始终免确认**(推 `yolo` + 宿主直接放行审批/Plan 退出,只有提问路由到看板)、完成后**串行自动合并/PR**、状态汇报回主会话、按主会话归属的归档/恢复;心跳/汇报车道/看门狗/看板投影已从 `panel.ts` 下沉到 `src/panel/super-agent-host.ts` |
| `src/panel/super-store.ts` | 子会话归档的落盘(按主会话分文件、原子写、读回/删除/孤儿列举) |
| `src/panel/worktree.ts` | git worktree 隔离:建/删 worktree、分支未合并检测、合并回主分支(冲突自动 `merge --abort`) |
| `shared/messages.ts` | Host ↔ WebView 消息协议 + `Block` / `SessionState` 类型(两侧共用)+ `applyBlockPatch`(含 `toast`/`dismissToast`、`regenerate`、`openDiff` 消息) |
| `shared/session-state.ts` | 纯会话状态 reducer(`applySessionUpdate`、SubAgent 归组、`parseTranscriptJsonl`、块 id 分配/回填、`toAgentPromptText`、BPE token 估算、MCP 编辑 diff 合成) |
| `shared/super-agent.ts` | Super Agent 纯逻辑:子会话模型与状态机(终态粘性)、委派指令(`super-agent` 代码块)解析、汇报文本、诊断事件(`SuperDiagnosticEvent`/`applySuperDiagnostic`)、失败四分类(`SuperFailureKind`/`applySuperFailure`)、`planSuperWaves`、`groupSuperReportsByWave`;看板聚合 `buildSuperBoardAggregate` 在 `shared/super-board.ts` |
| `shared/turn-followup.ts` | 回合末合并提示词构造 + JSON 信封解析(AI 标题 / 下一步建议 / 记忆提取拼成一次请求;按开启项只写对应键与节,缺项降级 `null`/`[]`,绝不伪造) |
| `webview/src/` | React UI:`App.tsx`、`store.ts`(zustand + Web Audio 提示音 + `createMockHost`)、`i18n.ts`、`components/*`(10 个组件,Win12 风格亚克力材质) |
| `scripts/harness.mjs` | M0 联调工具:驱动真实 CLI 跑 ACP 全流程,`--record` 录 wire 日志,`--probe` 探方法行为 |
| `scripts/vendor-cli.mjs` | 内置 CLI 裁剪打包:`vendor:cli`(自 2026-10-17 默认把本地 fork `../iflow-fork` 拷贝+裁剪进 `vendor/iflow-cli`,npm 拉取 only 显 `--version` opt-in)、`--sync-defaults`(同步本地默认规则到 `scripts/iflow-defaults/`) |
| `scripts/generate-icon.mjs` | 由 SVG 生成 `media/icon.png`(@resvg/resvg-js),`npm run build` 首步调用 |
| `scripts/read-changelog.mjs` | CI 用:从 CHANGELOG 顶部读版本号与摘要写入 GITHUB_OUTPUT |
| `vendor/iflow-cli/` | 裁剪后的内置 CLI(~40MB,源为 `@yuentao/iflow-cli` 定制 fork),`package` 时进 VSIX |
| `vendor/iflow-defaults/` | 随包发布的默认规则配置(kimi 请求覆写、多模态模型、输出 token 限制、思考模型 4 个 json),连接前种到 `~/.iflow/` |

## 构建与运行

```bash
npm ci                 # 安装依赖
npm run typecheck      # tsc -p tsconfig.json --noEmit
npm test               # vitest run(单次,非 watch;当前 11 文件 / 271 用例)
npm run build          # icon + tsc + esbuild(host) + vite build webview
npm run icon           # 仅重新生成 media/icon.png
npm run webview:dev    # webview 增量构建(UI 迭代时用)
npm run vendor:cli     # 把本地 fork(../iflow-fork)拷贝+裁剪进 vendor/iflow-cli(npm 拉取不再默认,详见下节)
npm run defaults:sync  # 把本机 ~/.iflow/ 的默认规则同步到 scripts/iflow-defaults/
npm run harness        # 驱动真实 iFlow CLI 跑 ACP(需本机已装 CLI 或已 vendor)
npm run package        # vendor:cli && build && vsce package --no-dependencies
```

- 调试:`.vscode/launch.json` 提供扩展调试配置(F5 在 Extension Development Host 中加载)。
- 本地 F5 前必须 `npm run build`,因为 `main` 指向 `./dist/extension.cjs`,webview 读 `webview/dist/index.html`。还需先跑一次 `npm run vendor:cli`(vendor/ 被 gitignore,dev checkout 通常不存在,缺了扩展直接报「内置 CLI 缺失」——这是刻意设计,没有本机 CLI 兜底)。
- 打包产物:仓库根目录的 `iflow-harness-*.vsix`(内置 CLI 后 VSIX 约 13MB,不再是 0.2.0 时代的 200KB)。

## 内置 CLI(vendor,唯一执行体)

`scripts/vendor-cli.mjs` 把 CLI 打进 VSIX。自 2026-10-07 起内置 fork 是面板**唯一**的 CLI 来源:扩展宿主不探测 PATH/npm/已知路径,没有 `iflow.cliPath` 设置,`resolveVendoredEntry` 缺失即抛错(定制 loader 补丁只在这个 bundle 里,跑官方包=静默丢补丁改变 agent 行为,宁可报错不兜底)。要点:

- **Vendor source(2026-10-17 改)**:`vendor:cli` 默认把**本地 fork checkout** `../iflow-fork`(repo root 相对,即 J:\git\iflow-fork,remote `product/iflow-fork.git`)拷贝+裁剪进 `vendor/iflow-cli`,**npm 拉链不再默认**——定制 fork custom.12+ 未 npm publish,npm registry 永久滞后本地 Mod 注入,静退 npm 会 vendor 滞后 fork(硬 fail 缺 checkout,报错不兜底同理)。`IFLOW_VENDOR_FORK_DIR`/`--from-dir` 覆写源;显 `--version` 仍走 npm pack path(registry 验收/未来 publish)。**CI caveat**:release.yml 跑 `npm run package`,CI 环境里没有本地 fork checkout → release 打包要么跑本地或把 fork 进 CI 先 checkout。below 里反复 "**尚未发布 npm**——发布后 `npm run vendor:cli` 才能默认拉到,当前 vendor 经 `--from-dir` 装载本地产物" 现读:local 照 default source,Mod 注入随每次 package 自动带上。fork checkout 里 `reverse/`(deobfuscation workspace,reverse/*.readable.js ~23 万行)与 `.git` 照 prune/strip(npm tarball path never had them),PRUNE_DIRS 里 ["scripts","reverse"]。

- **开发期同步新 Mod 与锚点来源(2026-11-15 迁入 in-repo 快照后,与上面 2026-10-17 旧描述冲突处以代码为准)**:项目内 `vendor/iflow-fork/` 是**已裁剪的产物快照**(`.gitignore` 放开进 git、`.vscodeignore` 排除不进 VSIX),由 `scripts/vendor-cli.mjs` 的 `IN_REPO_FORK_DIR` 作默认源,CI 与运行期只要这份产物,**它不是 Mod 源码仓库**;注入本体在 `bundle/iflow.js` 与 15 个 `*-loader.cjs`(含 `super-agent-loader.cjs`),不在 `bundle/entry.js`。新增 Mod 的同步链路:在外部 fork checkout 注入 → `IFLOW_VENDOR_FORK_DIR=<新 fork>` 或 `npm run vendor:cli -- --from-dir <新 fork> --force` 生成 `vendor/iflow-cli` → 把裁剪产物(去掉嵌套 `.gitignore`)同步回 `vendor/iflow-fork/` 并提交 → `npm run harness` 验收(改 PRUNE 清单尤其必须,见陷阱 #21);`--force` 不能省,快照版本号仍可能是 `0.5.19-custom.12`,幂等检查只比 package.json version(同版本 ≠ 同内容)。源 fork 的 `reverse/` **没有随迁移进项目**,仍留在外部 fork checkout:它是 deobfuscation 分析工作区(`reverse/iflow.readable.js` ~23 万行 esbuild 可读化产物、`reverse/ANALYSIS.md` 功能区行号地图、`reverse/map.mjs` 关键词指纹重扫),用来在 2MB 单行 minified bundle 里定位唯一插入锚点;不是运行时依赖,也不进 VSIX(PRUNE_DIRS 含 `reverse`,2026-09-11 `npm run harness` 实测背书)。新增 Mod / 换 CLI 版本时:锚点去外部 fork 的 `reverse/iflow.readable.js` 找,按 `reverse/ANALYSIS.md` 的复现命令重跑可读化、用 `reverse/map.mjs` 重扫关键词指纹(与「给后续 Agent 的建议」同纪律);iFlowMods 的 `apply-patch.mjs` 要求锚点唯一 + round-trip 校验,**换 CLI bundle 版本后必须重新生成 code.js / 锚点,漂移会硬失败**;而 `code.js` 需要 pristine bundle 叠加全部 Mod、本地无 pristine 副本,现行交付路径是直接在 fork bundle 上注入 loader。**若连外部 fork 都不再保留,必须另行纳入「pristine 重建流程」与轻量锚点地图(`ANALYSIS.md` / `map.mjs` 这类文本脚本),否则换 CLI 版本会卡在重新定位锚点**——快照里没有 `reverse/`,单靠 `vendor/iflow-fork/` 无法重做这一步。

- **来源是定制 fork**:npm 源为 `@yuentao/iflow-cli@0.5.19-custom.3`(tag `custom`),带本地注入的 `*.loader.cjs` 定制 bundle——官方 `@iflow-ai` 包不含。loader 源码来自 [iFlow-Mods](https://github.com/yuentao/iFlow-Mods) Mod 仓库:patch 型 Mod(thinking-mode / multimodal-image / output-token-limit / kimi-request-override / context-window refactor)在 CLI 源码同一插入点以 1 行 require 注入 loader,monkey-patch 模型规则并外置到 `~/.iflow/*.json`;Mod 可用 [iFlow-Mod-Builder](https://github.com/yuentao/iFlow-Mod-Builder)(Tauri+Vue3 GUI)打包成 `.iflow-mod` 安装。`--from <tgz>` / `--from-dir <dir>` 可完全绕开 npm 源(离线/本地定制场景——`--from-dir` 正是装载带新 loader 的本地定制 CLI 的路径,`--from-dir` 自带 node_modules 会跳过安装;脚本会剔除源目录的 `.git` 防进 VSIX)。custom.3 新增 `mcp-background-loader.cjs`(方法体委托型,不经过 L950):CLI 0.5.19 在 `--experimental-acp` 下 `isNonInteractive` 为 true,`discoverAllTools` 走**同步** `await discoverAllMcpTools()` 分支且 MCP `connect()` 无超时——npx 型服务器在 npm registry 不可达时无限挂起、ACP initialize 握手永久卡死(交互 TUI 反而走后台分支不受影响);loader 让 ACP 场景改走 CLI 自带的 `startMcpDiscoveryInBackground()`(MCP 工具连接完成后陆续注册),`-p` 一次性模式保持同步,`IFLOW_MCP_BACKGROUND=0` 退回原行为。
- **版本幂等**:`vendor/iflow-cli/package.json` 的 version 与目标一致就跳过;`--force` 强制重做。注意 `--from-dir` 时「同版本 ≠ 同内容」,本地 loader 定制不在 npm 源里。
- **默认规则双目录**:源在 `scripts/iflow-defaults/`(进 git),构建时复制到 `vendor/iflow-defaults/`;扩展连接前把 `~/.iflow/` **缺失的**规则文件种过去(`seedDefaultRuleConfigs`),**永不覆盖用户已有文件**;`settings.json` / `iflow_accounts.json` 携带凭据,固定清单之外一概不同步。
- **`.vscodeignore` 有关键例外**:`node_modules/**` 被排除,但 `!vendor/iflow-cli/node_modules/**` 必须保留——内置 CLI 的运行时依赖靠它进包。
- **Windows 陷阱**:npm 调用统一走 `runNpm()`——优先用 `process.execPath` 直跑 npm 自带的 `npm-cli.js`(跨平台零 shell,避开 `.cmd` shim 的 EINVAL CVE-2024-27980 与 DEP0190;旧实现「单命令字符串 + 仅 win32 开 shell」在 ubuntu runner 上把整串命令当二进制名 spawn,实测 ENOENT);fallback 才是 PATH 上的 npm(win32 带 shell 单字符串、POSIX argv 数组)。解压用系统自带 bsdtar。1.1.1 修过一处 vendor 嵌套 `node_modules/.bin` 符号链接导致 vsce 在 Linux CI 打包失败。
- **无探测链(2026-10-07)**:`resolveVendoredEntry(extensionPath)` 同步拼 `vendor/iflow-cli/bundle/entry.js` + existsSync,缺失即抛。曾经的 `IFLOW_CLI_ENTRY` env、PATH shim、npm root、well-known 探测与 `iflow.cliPath` 设置已全部移除——`IFLOW_CLI_ENTRY` 仅 `scripts/harness.mjs` / repro fixture 支持,用于 vendor 裁剪验收指向任意 entry,扩展进程不读。

## 开发约定

### 分层纪律
- **纯逻辑放 `shared/` 或 `src/acp/jsonrpc.ts`**,保持零 VSCode 依赖以便单测。UI 组件不 import `vscode`。
- 新增 wire 消息类型必须同时更新 `shared/messages.ts` 的 `WebviewToHost` / `HostToWebview` 联合类型,两侧共用。
- 状态变更走 `shared/session-state.ts` 的 reducer 函数,不要在 `panel.ts` 里就地改 state。
- 新增 transcript 块类型:加进 `Block` 联合并继承 `BlockBase`(带 `id?`),同时确认 `backfillBlockIds` 的递归路径覆盖到。

### TypeScript
- `strict: true` + `noUncheckedIndexedAccess: true`。数组索引访问必须显式处理 `undefined`(代码里普遍用 `!` 断言,但仅限已判空处)。
- `module: Node16` / `moduleResolution: Node16`,**import 必须带 `.js` 扩展名**(如 `from "./protocol.js"`),即使源文件是 `.ts`。
- 主 `tsconfig.json` 只 include `src` + `shared`,且开 `noUnusedLocals`;webview 有独立 `tsconfig.json`(noUnusedLocals + moduleResolution Bundler),由 Vite 构建,不参与主 typecheck。测试有自己的 `tsconfig.test.json`(noEmit)。
- `shared/gpt-tokenizer.d.ts` 声明 `gpt-tokenizer` 模块(v4 无官方类型)。

### 构建产物
- `package.json` 有 `"type": "module"`,但 VSCode 扩展宿主要求 CJS → esbuild 输出 `dist/extension.cjs`(`.cjs` 后缀是刻意的)。
- esbuild(`esbuild.mjs`)只 bundle `src/extension.ts`,`vscode` 标为 external,target `node20`。
- tsc 同时把 `src/`、`shared/` 编译到 `dist/`(`dist/src/acp/*.js` 供 `scripts/harness.mjs` 导入),这些中间产物被 `.vscodeignore` 排除出 VSIX。

### 本地化(l10n)
- 用户可见字符串一律 `vscode.l10n.t("中文原文", args)`,**中文是源语言**。
- 扩展清单字符串走 `package.nls.json` / `package.nls.zh-cn.json`(`%key%` 占位);webview 走 `webview/src/i18n.ts`(约 128 键)+ `l10n/bundle.l10n.en.json`。
- 测试用 `test/vscode-stub.ts` 把 `vscode.l10n.t` 做成恒等翻译,因此断言直接写中文字面量。
- 双轨 l10n 是已知架构债:host 走 VSCode l10n 工具链、webview 走运行时字典,合并属架构级重构,当前维持现状。

### 控件体系(UI Kit)
- **控件之家只有一个**:所有表单/交互控件住在 `webview/src/components/ui.tsx`,组件文件不得自绘控件、不得复制按钮/输入框类串。原生 `<input>` / `<textarea>` / `<select>` / `type="checkbox"` / `type="range"` **只允许出现在 ui.tsx**;唯一例外是 `Composer.tsx` 的提示输入 textarea(stage 专属物种:多行提示 + 历史召回 + slash 弹窗 + IME 安全 Enter,守卫断言它恰好 1 处)。
- **控件清单**:`Button`(variant × size)、`IconButton`(图标按钮,`tone` default/danger/primary)、`TextInput` / `TextArea` / `CommitTextInput` / `CommitTextArea` / `CommitNumberInput` / `SearchInput`、`Select`(自定义浮层下拉,不再是原生 `<select>`:触发器沿用 `BTN_INPUT` 字段材质 + `ChevronDown`,`size` md/sm,菜单至少等于字段宽并过 Dropdown 视口夹取)、`MenuItem`(下拉菜单行:主文案 + 可选 `description` 副文案 + 可选 `icon` + 选中勾标;值选择用 `role="menuitemradio"`+`aria-checked`)、`Switch`、`Checkbox`、`ToggleChip`、`OptionGroup` + `OptionCard`(单选/多选组;`emphasis`=一次性选择里的推荐项(primary 描边 + 浅底,`checked` 仍为 false,不宣称已选中),`ariaLabel`=可访问名与可见文案不同时指定)、`Segmented`(页内分段选择)、`Slider`、`TabButton` + `rovingTabKeyDown`、`Dropdown`、`ModalShell` / `ConfirmDialog`、`Chip` / `HelpTip` / `Field` / `FieldLabel` / `Hint` / `ActionRow` / `ToolbarRow` / `SettingsGroup` / `SettingsDisclosure`、浮层物种 `FloatPill` / `FloatChip` / `CountdownSeconds` / `CountdownBar` / `ToastStack`。
- **命名约定**:受控值一律 `value` + `onChange`;提交类字段用 `onCommit`;按钮 `variant` / `size`;输入 `mono`(等宽值,如传输类型/命令/路径)与 `invalid`(错误态);图标按钮必须给 `aria-label`(与 `title` 同文,可访问名即 tooltip);禁用统一 `disabled:pointer-events-none disabled:opacity-40`。
- **可访问名**:单个控件字段用 `Field`(它渲染 `<label>` 包裹控件,隐式关联),不要用「裸 div + `FieldLabel` span」——屏幕阅读器读不出控件用途;含多个控件的分组(参数行/环境变量行/header 行)不能套单个 label,逐个控件给显式 `aria-label`(带序号或实体名,如 `t("环境变量 {0}", keyName)`);`placeholder` 只是弱标签,不算可访问名。
- **语义分离(同一功能不得多通道)**:跨页导航用 tab(`role=tablist` + `TabButton` + `rovingTabKeyDown`,roving tabindex);同一屏内的值选择用 `Segmented` / `ToggleChip` / `OptionGroup`(`radiogroup` / `checkboxgroup`);开关用 `Switch`(role=switch)、勾选用 `Checkbox`;数值用 `Slider`;不要为了省事把 tab 降级成按钮组,反之亦然。`Segmented` **必须是 radiogroup**:选中项是唯一 tab 停靠点(`tabIndex` 0/-1),Arrow/Home/End 移动选择并跳过 `disabled` 选项(复用 `rovingTabKeyDown`)——旧的 `role="group"` + `aria-current` 按钮组既不播报选中值也没有键盘导航,已废弃。
- **提交语义两档**:设置页字段走 **草稿 + blur/Enter 提交**(`Commit*` 系列,IME 安全:`isComposing || keyCode === 229` 时不提交),表单/向导字段走实时受控(`TextInput` / `TextArea`)。
- **视觉档位**(沿用项目既有语言,不新增任意值):控件高度两档 28px(`md`)/ 24px(`sm`);图标按钮 28×28 / 24×24;圆角 `control 6`(按钮/输入) / `overlay 12`(下拉/浮层/卡片弹窗) / `card 8`;图标三档 `ICON_INLINE` 14 / `ICON_TOOLBAR` 16 / `ICON_DISPLAY` 20(按钮内用 flex gap 排版,不用手工偏移);字号一律语义类(`text-ui-*`),禁止 `text-[Npx]`;圆角禁止 `rounded-[Npx]`;阴影按表面选 token——次级按钮 **边框即表面(无阴影)**,主按钮渐变 + `shadow-btn`/`hover:shadow-btn-hover`,canvas chip 走 `shadow-card`,浮层胶囊走 `shadow-float`(负 spread 的 `--shadow-card`/`--shadow-panel` 在 24–38px 高的浮层上会塌陷)。
- **浮层菜单阴影统一 `shadow-float`**:`Dropdown` 菜单外壳与 Composer 的 slash/@ 弹窗都是 `acrylic-pop shadow-float`(styles.css 的 `.acrylic-pop.shadow-float` 保留 inset rim、把投影换成浮层档);`acrylic-pop` 自带的 `--shadow-panel` 只留给大面板(`ModalShell`)。守卫 `test/ui-kit-guard.test.ts` 断言同一行里 `acrylic-pop … dropdown-in` 必须带 `shadow-float`。
- **浏览器原生字段外观由 kit 接管**:`styles.css` 的 kit 段负责 Chromium 自绘的装饰——数值微调箭头(`input[type=number]::-webkit-*-spin-button` 关掉,键盘 ↑/↓ 步进保留)、自动填充黄底(`input:-webkit-autofill` 覆写成 `--editor` 底 + `--foreground` 文字并保留焦点光晕)、光标 `caret-color: var(--primary)`、选择高亮 `::selection` 用 primary 28% 染色。
- **多行字段高度走 kit 手柄**:textarea 一律 `resize-none`,调整高度由 `.ui-resize`(右下斜纹手柄,与 Composer 顶边拖拽同一语言,`aria-hidden`、仅鼠标)负责;调用点不得写 `resize-*`,自带尺寸编辑器传 `resizable={false}`(MessageList 内联编辑器)。
- **密码字段显隐走 `TextInput revealable`**:kit `IconButton`(Eye/EyeOff)替代 Chrome 内置眼睛(原生按钮 CSS 无法覆写),`aria-label` 与 tooltip 同文。
- **Button 是单行物种**:`Button` 固定 28px(`md`)/ 24px(`sm`)高,只放一行文案(图标 + 文案);需要「图标 + 标题 + 副描述」这种两行内容时用 `OptionCard` / `MenuItem`,**不要**给 `Button` 加 `py-*` 撑高——内容会溢出按钮自己的边框(Profile 切换卡曾如此:紫色描边只画在 28px 高的框上,文字溢出到框外)。守卫 `test/ui-kit-guard.test.ts` 断言组件里的 `Button` 不带 `py-*` 内边距覆写。
- **按钮跟随所在表面的色调**:落在带语义底色的表面(警告/错误 toast 胶囊、警告横幅、错误横幅)里的动作按钮必须穿该色调(`variant="warning-soft"` / `"danger-soft"`,kit 里的 `WARNING_SOFT` / `DANGER_SOFT`),不能沿用中性次级按钮或 primary 渐变——灰 chip 浮在琥珀色提示上会读成无关控件(上下文接近上限提示的「立即压缩」曾如此),靛蓝 primary 压在红色错误横幅上同样读成另一个产品(该横幅的「重试」现为 `danger-soft`)。中性表面上的普通动作仍是 `secondary`;`ErrorBoundary` 的内联回退卡是琥珀底 → `warning-soft`,整页回退是中性底 → `canvas`。`test/notification-merge.test.tsx` 与 `test/error-boundary.test.tsx` 断言这些动作按钮带对应色调且不含 `bg-editor`。
- 守卫 `test/ui-kit-guard.test.ts` 断言:styles.css 必含上述重置规则与 `.ui-resize` 物种、`resize-*` 只允许出现在 ui.tsx(+ Composer 例外)、`type="password"` 必须与 `revealable` 同元素,并含手柄拖拽/显隐切换的 jsdom 行为用例。
- **边界条件**:下拉/浮层需视口夹取,窄屏右对齐菜单用 `align=right` 向内展开;`ModalShell` 给 `initialFocus`;审批卡/提问卡/Plan 卡**不受 streaming 门控**(陷阱 #12);渐进披露(行内删除等)用 `group-hover` / `group-focus-within` 的 opacity 组,不靠 `hidden`;`data-variant="danger"` 只被 Dropdown 的键盘导航选择器消费(`ui.tsx`),非菜单按钮的危险语义由 `tone="danger"` 承担。
- **约束**:`test/ui-kit-guard.test.ts`(`npx vitest run test/ui-kit-guard.test.ts`)静态扫描 `webview/src`,断言原生控件只在 ui.tsx(+ Composer 那 1 处 textarea)、主按钮渐变串与按钮基串只在 ui.tsx、无 `accent-[`、无 `text-[Npx]` / `rounded-[Npx]`、`icon={<… className="size-3.5" />}` 走 `ICON_INLINE`、套件导出成员存在。新增控件请同时把成员名加进守卫清单。

### 安全与凭据
- 审批默认拒绝(`outcome: "cancelled"`);审批卡/提问卡 5 分钟超时自动拒绝,避免 agent 永久阻塞。
- Webview HTML 注入 nonce CSP(`script-src 'nonce-...'`),资源引用重写为 `webview.asWebviewUri`;DOMPurify 显式 `FORBID_TAGS: ["iframe","form"]` + `FORBID_ATTR: ["style","target"]`。
- webview 提供的 data URL 附件有 8MB 上限(`MAX_IMAGE_ATTACHMENT_BYTES`),超限在落盘前拒绝;>5MB 图片(`ATTACHMENT_IMAGE_MAX_BYTES`)降级为文件附件。
- `openExternal` 仅放行 `^https?://`。

- **记忆管理(F3 Phase 1,2026-10-18)**:设置页新增「记忆」tab,读取/编辑 CLI 实际加载的全局与项目 `AGENTS.md` / `IFLOW.md`;支持内联编辑、按 `## iFlow Added Memories
` 追加/删除事实、新建项目记忆、token 成本展示与冲突检测。CLI 侧实证(`test/fixtures/probe-memory.mjs`):全局记忆目录硬编码为 `os.homedir()/.iflow`(**不认 IFLOW_HOME**),`memory.md` 当前 loader 不读取(仅作遗留文件展示、不注入),`@relative/path` 导入可用(为 Phase 3 `.iflow/knowledge` 铺路),ACP 下 `/memory add` 只返回 tool action 不执行(面板必须直接写文件)。记忆在 `session/new` / `session/load` 时加载;当前会话需重启 CLI(恢复当前会话)才生效。
- **ErrorBoundary 自愈**:流式渲染期间 markdown 解析病态块导致的 React 整树卸载白屏,`ErrorBoundary`(page=main.tsx 顶层 / inline=MessageList 外层)+ `resetKey`(下一个 snapshot/blockPatch 自动重试)兜底;`aria-live` 播报与 `/` 聚焦快捷键。1.1.1 修过 liveMessage `useMemo` 位于早返回之后导致的 hooks 数量不一致。
- **transcript 持久化(P2)**:`context.storageUri/transcripts/<sanitized-sessionId>.json` 每会话一文件,promise 串行链 + temp 写 + rename 原子替换;`migrateLegacyTranscripts` 一次性迁移旧数据(必须在会话过滤前执行,否则未迁移数据会被误判为不可恢复)。
- **块稳定 id(P4)**:`BlockBase.id` + `nextBlockId()` 单调计数器 + `backfillBlockIds` 回填旧数据;MessageList 用 `block.id` 作 key + `React.memo(BlockView)`,修掉 index key 导致的折叠状态错位;`reassignBlockIds` 处理恢复会话后的 id 唯一性。
- **`--stream` 参数**:`buildAcpCommand` 必须带,否则 CLI 的 ACP prompt 处理器等整轮 SSE 结束才一次性 dump,面板显示为分段而非流式。
- **长会话渲染**:超长转录离屏渲染 + 后缀挂载窗口;滚动跟随用 ResizeObserver 覆盖全部内容增长路径。
- **Win12 亚克力材质**:webview 视觉系统(见陷阱 #22 的 backdrop-filter 压缩陷阱)。用户气泡/品牌头像/工具图标渐变砖块等视觉体系 1.0.4 起持续迭代。
- Windows 上 `test/attachments.test.ts` 的 broken-symlink 用例会因创建符号链接需要权限而 EPERM，属 AGENTS.md 记录的环境限制，不是回归；`npm test` 出现该失败可忽略。
- 验证流程：`npx vitest run <测试文件>` 跑定向单测，`npm run typecheck` 分别检查 host 与 webview，`npm test` 跑全量；提交前按此顺序验证并在汇报中列出结果。
- 全局快捷键安全约束：隐藏卡片（上层有 modal）、SELECT 聚焦、事件已 defaultPrevented 时不得响应，防止误触与快捷键穿模。
- UI 说明组件约定：ui.tsx 的 HelpTip 通过 hover/focus/点击触发、role=tooltip，用于审批卡、Plan 卡、提问卡；操作行同时直接展示快捷键提示。
- 项目发布流程：验证后，提交未提交改动（通常含对应测试）→ 新增 CHANGELOG 下一版本条目 → 同步 bump package.json → 提交 → push master + 同步 release branch（通常 fast-forward，触发 release CI）。
- 项目版本同步约定：CHANGELOG 顶部版本与 package.json version 应保持一致；发布 commit 更新 both together.
- 设置面板视觉规范：字号阶梯统一为行标签 13px / 说明 12px / 分组标题 11.5px；降低信息密度，各分区主操作（新建/刷新/添加配置）置于列表上方，模型元数据等次要内容默认收起。
- UI 改动的验收方式：在 mock webview 中用 frontend-tester 逐项点击验证（焦点、滚动、布局、交互），除单测/typecheck 外作为前端行为验收环节。
- webview 字号系统统一为 5 档语义 token：text-ui-title 16px / text-ui-body 14px / text-ui-label 13px / text-ui-caption 12px / text-ui-micro 11px，另有 display 20px 用于启动页/空状态品牌图形；禁止再新增任意 text-[Npx] 字号。
- 字号缩放变量 --ui-font-scale 默认 1.0，三档预设为紧凑 0.92 / 标准 1 / 大 1.1；按原有效尺寸映射，避免半像素字号。
- 设置页字号层级：标题 16px / 侧栏与行标签 14px / 说明 13px / 分组标题 12px / 辅助信息 11px；弹窗标题 16px。
- 样式表中字号缩放应使用语义字号变量，body 基准 14px；不再使用 calc(Npx * var(--ui-font-scale)) 的写法。
- 布局间距 token 为 2/4/8/12/16/24px，并随 --ui-density 缩放；密度预设为紧凑 0.92 / 标准 1 / 宽松 1.12，普通 CSS 的固定 padding/gap 也应响应密度设置。
- 结构间距归一化约定：卡片/弹窗正文 py-3、设置行 py-4、列表/卡片堆叠 space-y-2、区块 gap-3、转录底部 pb-4、Composer 输入区 py-3 与操作行 pt-2；避免 py-[1px]、py-[2px]、mt-[3px] 等任意值。
- 子代理卡头部布局应优先保证状态 chip 完整可见：窄屏时先收缩/隐藏 agentType chip 和标题，避免状态 chip 被推出卡片或出现横向溢出。
- 控件内部的光学间距保留 2/6/10px（chip、图标与文字、紧凑按钮等），不强行归入 2/4/8/12/16/24 的布局间距网格，以免牺牲可读性与点击区。
- Composer 占位符应保持简短单行（如「向 iFlow 提问…」），不承载功能清单；完整功能提示放到空状态底部。
- 项目圆角体系为五档语义 token：inner 4px / control 6px / card 8px / overlay 12px / bubble 16px；Tailwind rounded-sm/md/lg/xl/2xl 分别映射 4/6/8/12/16px，嵌套元素按外大内小降一级。
- 圆角应用约定：工具卡/设置分组/转录卡等卡片表面用 8px；下拉、浮层、审批/Plan/提问卡、设置弹窗用 12px；按钮/输入框/ConfirmDialog/发送停止排队用 6px；用户消息气泡 16px，右下内角 8px，内部高光层同步。
- VSCode 桌面端点击区尺寸约定：以鼠标/键盘为主，不必所有目标都做到 44px；行内操作约 28px、卡片按钮 28–32px，触控场景再用 @media (pointer: coarse) 放大。
- 按钮体系约定：共享按钮基元分两档高度，常规/工具栏按钮 28px，卡片内密集操作 24px；图标按钮 28×28；审批卡、Plan 卡、提问卡、ConfirmDialog 的操作按钮用 24px。
- 图标尺寸约定：内联图标统一 14px，工具栏图标 16px，展示型图标 20px；按钮内图标用 flex gap 排版，不再用 mr/align 手工偏移。
- 下拉菜单/浮层需做视口夹取；窄屏右对齐菜单应通过 align=right 向内侧展开，避免负坐标或超出视口。
- 空状态示例提示应做成明确可点击的 chip：带边框、卡片底色、轻阴影、左侧 Sparkles 图标，整行 hover 反馈，点击区高度约 28px；不要用裸文字按钮。
- 项目自定义 `.shadow-card` 直接设置 `box-shadow`，会覆盖 Tailwind `ring`（ring 也编译为 box-shadow），导致边框消失；需要不占布局高度的边框时改用 `outline`（outline 不走 box-shadow，也不参与高度计算）。
- 面板模式与 CLI 模式必须单一权威：每轮 prompt（含重新生成）拿到 sessionId 后，先调用 assertModeForPrompt 把面板保存的模式推给 CLI，再发送；CLI 侧同值推送为 no-op，失败只记日志不挡发送。
- 当 Stop 确实打断 Plan 退出卡时，session/cancel 之后必须立即重推当前模式，把打断瞬间产生的模式漂移当场拉回；cancelAllPlanExits 应返回被取消的 Plan 退出请求数，供判断是否发生打断。
- 调试 webview 构建产物时使用 `npm run webview:serve`（`scripts/serve-webview.mjs`，默认端口 8791、目录 `webview/dist`），作为长期保留的静态服务入口。
- Vite 构建产物不能直接用 `file://` 打开，因为产物以绝对路径引用 `/assets/...`，在本地文件协议下会被 CORS 拒绝导致空白页；调试时应走 HTTP 静态服务器。
- Webview 改动后除 typecheck 与测试外，还应运行 npx vite build 验证构建产物。
- 通知系统按层级统一：Composer note 通过 notify 进入共用 toast stack；host toast 保留底部自动消失；错误与未配置凭据提示作为 header 下方的同一层 inline banner，不再以悬浮层遮挡转录。
- 错误横幅展开态采用“正文独占整行、操作行下移”的响应式布局，以保证 320/480px 窄屏下正文可读且无横向溢出。
- 流式生成期间，限流或流中断倒计时通知合并进 sticky“生成中”pill，并从底部 toast stack 跳过；带不可执行 action 的通知不得合并，host 倒计时继续以绝对 deadline 驱动。
- 设置面板返回交互统一为单一通道：所有子页（详情/编辑/表单/目录浏览）均通过壳层 header 的返回箭头返回；底部操作区不再放置「返回」按钮，只保留推进流操作（如编辑、保存）。
- 通知 toast 栈不能使用固定 bottom，否则可能与 sticky 生成中 pill 重叠；需通过 ResizeObserver 将通知带高度镜像到 --stream-pill-h，并计算栈底为 2.5rem + --pending-card-h + --stream-pill-h，保留 1rem 间距。
- 负 spread 阴影 token（--shadow-panel 0 24px 60px -24px、--shadow-card 第三层 -12px）适合大面板/卡片，但用在约 24–38px 高的浮层胶囊或按钮上会塌陷成不可见投影；浮层应使用 spread 收在自身高度内的 --shadow-float。
- Tailwind v4 中 shadow-panel 会被解析为 shadow 颜色修饰符而只输出 --tw-shadow-color；自定义浮层阴影需要在 styles.css 中显式写 .shadow-panel/.shadow-float 规则，且 float 这类 utility 不在 @theme inline 时必须手动补规则。
- 项目控件体系约定：控件统一收敛到 ui.tsx；原生控件外观残留（textarea resize 手柄、number 微调箭头、password reveal、autofill、selection/caret）应通过 styles.css 重置或 kit 自绘覆盖，避免浏览器默认外观。
- 项目原生控件统一采用 kit 外观：无 select，checkbox、range、数值输入、密码显隐和 textarea 手柄均由项目自绘；Composer 提示输入作为既有例外。
- Button 是单行控件，不得用 py-* 强行增高；两行内容应使用 OptionCard 或 MenuItem。
- OptionCard 用于单次选择中的多行选项，可用 emphasis 表达推荐态，并用 ariaLabel 提供与可见文案不同的可访问名。
- 新增 UI kit 导出时，ui-kit-guard 的导出清单必须按源码实际声明精确匹配，并确保守卫改动与源码一起提交。
- 按钮需跟随所在表面的语义色：警告表面用 warning-soft，错误表面用 danger-soft；中性表面用 secondary/canvas，粘性决策卡保留 primary。
- ACP 无 session/close；一次性辅助会话结束需删除 CLI 会话状态文件，会话对象随 CLI 进程生命周期驻留，代价与 probe 会话相同。
- 用户要求涉及接口、模型或消耗的问题时，必须使用当前 API 实测并提供可验证数据，禁止凭猜测下结论。
- 当前环境中 CLI 自带的 web_search 工具不可用，但宿主机侧 Bing 搜索实测可达并能返回结果。
- **「联网补充模型数据」走宿主侧，不走 CLI 会话(2026-10-22)**:旧实现用 throwaway ACP 会话让 agent 检索，实测(本地 capture proxy + gpt-tokenizer o200k_base，商汤 `sensenova-6.8-flash-lite`)一次平凡 prompt 就 **56,287 tokens**——其中 system **39,992**(内置模板 + `# AGENTS.md` 28,240 + 知识库 + 记忆 + CLI env/git 段)、tools schema **12,160**(28 个工具，含 8 个 apipost MCP 工具，`mcpServers: []` 挡不住 settings.json 里的 MCP)，检索本身只值几千 token。且 CLI 侧 `getFunctionDeclarations()` 在 `!getSearchApiKey()` 时把 `web_search`/`web_fetch`/`xinliu_web_fetch` 全部过滤(`~/.iflow/settings.json` 的 `searchApiKey` 为空串)，agent 拿不到检索工具直接回 `{"models":[]}`。现行链路:`src/acp/web-search.ts`(Bing `b_algo` → DDG 回退，node:http(s) 直连避开 fetch 代理 patch，陷阱 #2 同源；`cn.bing.com` 实测 200 且 10 条结果，`www.bing.com` 302→cn，DDG 在本机不可达)+ `fetchPageText` 抓相关页面原文 → `shared/model-metadata.ts` 的 `buildModelMetadataPrompt` 把资料原文交给 `streamChatCompletion` 直连(实测同任务 **11,273 tokens**) → 模型返回单 JSON 信封 → 宿主 `parseModelMetadata` 解析/校验/**追加去重**(不覆盖已有条目)。分工纪律:**宿主只做采集、传输、校验、追加，提炼与结构化一律由 AI 完成**(不得关键词预筛、不得手动拼值)。不伪造的结构性保证:条目必须引用存在的 `source` 编号、该 source 文本必须提到模型名、且模型报出的每个数字必须能在该 source 中找到(单位感知 `200000`↔"200K"、`1000000`↔"1M")，任一不满足即整条丢弃。**2026-10-23 用 DeepSeek 真实 API 全链路实测后修掉三处硬伤**:①端点——`www.bing.com/search?q=…&ensearch=0` 会让**任何查询**都返回同一组品牌卡片(厂商首页/百度百科/下载页/GitHub/App Store/HuggingFace，6 条固定结果)，必须用裸 `https://cn.bing.com/search?q=…`;②查询形态同样是硬约束——`<id> pricing`、`<id> context window`、`<id> 上下文窗口 1M` 都退回品牌卡片，而 `<id> 价格`、`<id> 上下文长度` 能命中官方定价页，市面查询只有「大模型 API 价格 对比 2026」可用(「主流大模型…」会退化成词典结果);③来源去重——`.filter` 里 `claimed.add` 会把全部命中提前认领(实测 30 命中只剩 2 条来源)，而「先认领页面候选、再由 push 去重」会让成功抓取的页面被自己的检查吞掉(官方定价页排第一却整页消失)，现行写法是候选阶段只按 URL(去查询串)去重、由 push 在成功时认领。另:官方中文定价页给的是人民币，设置项口径是美元，提示词明确禁止汇率换算(非美元来源省略价格字段)。实测产出(端点 `https://api.deepseek.com`，模型 `deepseek-flash`):5 条查询 / 30 命中 / 29 条去重来源(15,099 字符) / 提示词 8,559 tokens / 20.7s 返回，解析出 2 条 grounded 条目(两模型各 1M 上下文，v4-pro 输入 $1.32、输出 $3.96 高峰价)→ 追加 2 条窗口 + 1 条成本 + 2 条思考规则。
- SettingsDisclosure 的 body 使用 divide-y 给每个直接子元素加 border-top；动作行与状态行必须包在同一容器，否则状态行会多出边线，配合负 margin 会压在文字和按钮上。
- 设置项的从属配置应跟随对应开关：关闭时完全不显示，开启时显示在对应条目下方，而不是仅禁用控件。
- 子会话 worktree 目录名 slug 需截断到 24 字符，以规避 Windows/git 路径长度限制；创建失败时要把 git 的真实报错透传给子会话，不要静默退化为空目录。
- `.acrylic` 的 `backdrop-filter` 会给 `fixed` 后代建立包含块，叠加 `overflow-hidden` 会裁切弹框；浮卡内的全屏弹框应使用 `createPortal(..., document.body)`，与 `ConfirmDialog` 一致。
- 顶部浮卡高度测量不能用空依赖的 effect：首帧 splash 早返回时 ref 为 null，之后不会重跑；应改用 callback ref，在浮卡真正挂载时创建/更新 ResizeObserver。
- AcpClient 的 JSON-RPC 拒绝是普通对象 {code,message,data}，错误展示必须复用 src/acp/jsonrpc.ts 的 errorMessage，直接用 String(error) 会得到 [object Object]。
- `Dropdown` 菜单使用 `absolute` 且没有 portal，放进带 `overflow-y-auto`/`overflow-hidden` 的看板容器会被裁剪；子会话行内动作因此下沉到行详情，若要在行末放下拉需新增 portal 浮层基元。
- `vendor/iflow-fork` 下的改动（如 super-agent loader 校验）在下次 `vendor:cli` 从外部 fork 重新生成快照时会被覆盖，必须同步回 iFlowMods 源仓库（如 `super-agent-tool-refactor`），否则闭环能力丢失。
- 同屏值选择优先使用 ui.tsx 的 ChoiceRow（内部 Segmented），不要用 Select；控件应收敛到 ui.tsx，避免同类功能出现不同控件形态。
- CI 中 knip/lint:deps 告警要按用户要求通过真正删除死代码修复，不接受新增豁免；修到零告警是发布前质量门的一部分。
- 当前 iFlowMods 同步决策：不做远程同步/PR，只保留本地改动（vendor/iflow-fork 产物快照）。
- 用户决定 iFlowMods 相关改动只保留在本地，不做 GitHub 远程同步/PR；项目里说的“外部 fork”指本地定制 fork checkout，不是 GitHub 上的 iFlowMods 仓库。
- vendor/iflow-fork 是本地外部 fork 的产物快照；改 vendor 快照后要同步本地 fork 源仓库，否则下次 npm run vendor:cli --from-dir 重生成会覆盖。
- 影响 CLI 运行时行为的 mod 需要多场景冒烟测试后再确认完成：默认路径不变、标记开启、关闭开关、argv/ACP 门控、自定义规则路径、畸形输入、与子会话模板叠加、端到端连续会话，以及构建/typecheck/定向和全量测试。
- 新增或调整设置面板一级分类时，需要同步检查并更新 `test/ui-settings.test.tsx` 的 tab 数断言、`test/super-agent-settings.test.ts` 的渲染 helper，以及 `test/ui-kit-guard.test.ts` 的相关断言/注释。

## 已知陷阱(代码注释里踩过并验证过的,改代码前必读)

1. **模型下拉数据源**:必须实时 `GET {baseUrl}/models`(OpenAI list models 接口)。CLI 的 `_meta.models.availableModels` 是官方硬编码目录,**不可作为回退**——端点不可达就返回空列表,仅把 `currentModelId` 补到列表头避免下拉空白。`refreshLiveModels` 失败保留下拉现有列表,`applyLiveModels` 对会话启动的延迟推送同理。
2. **绕过全局 `fetch`**:VSCode 扩展宿主用代理 agent patch 了 `fetch`,系统代理是 SOCKS 或无 scheme 时会抛 "Invalid URL protocol"。`models-query.ts` 因此用原生 `node:http(s)` 直连。
3. **CLI 的 ACP 会话持久化(2026-10 从 bundle 逐行更正,CLI 0.5.19)**:`--experimental-acp` 模式**不写**交互模式的 `~/.iflow/projects/<cwd-slug>/session-<id>.jsonl`,但每轮 `session/prompt` 的 `finally { saveSessionState() }` 都会写 `~/.iflow/acp/sessions/<sessionId>.json`(`{sessionId, cwd, createdAt, lastActivity, chatHistory}`,chatHistory 是 Gemini API 形态的完整对话)。`session/load` 读该文件并 `setHistory(chatHistory)` 重建内存历史,**但不回放 `session/update`**(见 #4)——这正是「删除用户消息」能做上下文真删除的机制:截断该文件的 chatHistory + 重新 load,模型即忘掉被删轮次。扩展仍在 `storageUri/transcripts/` 自持 transcript 副本(渲染真值、恢复优先);CLI 的 jsonl 只作交互模式会话的回退源。bundle 行号锚点见 iflow-fork `reverse/ANALYSIS.md`(prompt finally 的 `saveSessionState()` 在 iflow.readable.js L230,268、本体 L230,531、load 路径 `setHistory` L230,201)。
4. **`session/load` 不回放历史**:CLI 0.5.19 只返回 `{sessionId}`(无 modes、无 `_meta`),所以先 `newSession` 取 meta 再 `loadSession`,transcript 从文件重建。probe 会话被有意丢弃(只用其 meta/modes),非泄漏。
5. **`set_mode` / `set_model` 不推通知**:agent 不 emit `current_mode_update`,必须把响应里的 `currentModeId` / `currentModelId` 乐观写回 store,否则下拉会弹回。入口必须判空 `sessionId`(空串照发会被 CLI 乱绑定,响应值再被乐观写回)。`set_mode` 进 Plan 前记录 `planReturnModeId` 供审批后切回。
6. **`diff.path` 可能不可信**:CLI 可能发工具调用视角的相对路径(如 `Home.vue` 实为 `src/views/Home.vue`)。真实路径常在 `tool_call.locations` 里。定位策略:多候选(`diff.path` + `locations`)→ 按「磁盘内容 === diff.newText」优先匹配 → basename 有界搜索 → QuickPick → 文件选择器。MCP diff 合成同理按多候选读取(`parsed.path` + `locations`)。
7. **CLI 定位别扫二进制**:nvmd 等多版本管理器可能把 `iflow` 指向原生 dispatcher 二进制,当文本读会卡死扩展宿主(曾 profile 出 100% CPU)。`cli-locator.ts` 有 256KB 上限 + 首 1KB NUL 字节检测。
8. **相对路径基准**:agent 给的相对路径要拼 `sessionCwd`(session 创建时的 workspace 根),**不是** `process.cwd()`(扩展宿主 cwd 不等于 workspace)。`openLocation` 也走同一套 `resolveAgentPathToAbsolute`,行号要 clamp 到 `[0, doc.lineCount - 1]`。
9. **文件写入走 `vscode.workspace.fs`**:回退时不要用裸 `fs.writeFile`,会绕过 VSCode 的文件 watcher。
10. **SubAgent 归组双策略**:优先用 wire 上的 `agentId`——0.5.19 实测适配器事件确实带 `agentId`,但位置在 **`update.agentId`**(不是 notification 顶层,`extractAgentId` 三处都读:notification.agentId / update.agentId / update._meta.agentId);这些事件由独立适配器推送,**sessionId 是硬编码哨兵 `"default-session"`**(bundle 实测:工厂 `createAdapter(client, eventEmitter)` 不传第三参)。`dropSessionUpdate` 对**外来地址且带 agentId** 的事件按「无 sessionId 更新」同规则归属(仅自有会话 streaming 时放行);寻址自有会话的 agentId 事件可归属、无需门控(2026-09-11 的守卫曾把它们全丢,卡片只剩 task 自身、进度恒 0/1,2026-09-17 修复)。无 agentId 时退化为策略 2:task 自身的 call/update 按其 **toolCallId** 精确归属对应卡(`findSubAgentIndex` 匹配 `taskToolCallId`),匹配不到任何卡才开新卡;无 agentId 的扁平嵌套事件归入最新未终态卡。**不要退回旧的「区间状态机」**(任何 task 更新都塞进最新未终态卡):并行 task 时第二个 task 的 tool_call 会混进第一张卡的 entries,真正的第二张卡从未创建,其适配器事件只能兜底建出无名卡(2026-10-05 用户实测截图,已修+回归测试)。`adoptUnboundSubAgent` 同理按 **FIFO**(最早未绑定卡)收养——适配器按 agent 启动顺序推事件,并行时第一个 agentId 归属第一个 task。`parseTranscriptJsonl` 的 sidechain 归组依赖行序,并发 task 交错写入会把多张卡合并成一张(已知限制)。**守卫设计原则**:新增 session/update 丢弃规则前,必须实证 CLI 侧每个事件生产者的字段形态(bundle 可直接检索),守卫基于「可归属」而非 sessionId 一刀切——主会话路径与适配器路径是两套生产者,字段语义不同。
11. **Windows**:命令用 `process.execPath` 直接跑 `entry.js`,避开 `.cmd` shim 与 Unix shebang 的坑;`spawn` 带 `windowsHide: true`。
12. **提问卡与 Plan 审批不能被 streaming 门控**:两者在 prompt 进行中到达(status 为 `streaming`),agent 正阻塞等答案;按钮必须可用,不要复用「生成中禁用操作」的防呆逻辑。生成中禁用的下拉触发用显式 disabled 硬门控(点击穿透到 Dropdown 内部 click 代理的坑,1.0.5)。
13. **prompt 无超时**:`AcpClient.promptTimeoutMs` 默认 `0`(无限等待)——真实任务可能跑数小时,任何超时都会误杀长任务;中断完全由用户显式 Stop(`session/cancel`)驱动。`sendPrompt` 的 `initializing`/`streaming` 并发闸门必须保留(`iflow.askSelection` 与 `@iflow` participant 绕过 webview 的 busy 锁)。
14. **空设置教训(已闭合 2026-09-27,`864131e`)**:`iflow.idleTimeoutMinutes` 曾在 manifest 与两个 nls 文件声明但 `src/` 零引用,长期是空设置——现已连同 nls 描述键一并删除。教训保留:新增设置项必须同步实现,发布前用「manifest 声明 → src 引用」对账,不要对外承诺未实现的行为。
15. **`--baseContentUrl` 不可用**:0.2.0 起把 `docs/**` 排除出 VSIX(`.vscodeignore`),README 里的 `docs/images/*` 链接在 Marketplace 预览中打不开——刻意的取舍,别「好心」把 docs 加回包。
16. **blockPatch 锚定**:`baseVersion` 与接收端 `blockVersion` 不一致、或 `tailStart` 越界,都必须回退到全量重同步(webview 发 `ready`),不能硬合并。
17. **reducer 就地改 blocks**:`tailOnly` 判断依赖尾部指纹,中段变更对指纹不可见,会保守地清 flag 回退全量快照——不要为了「优化」去掉这个保守回退。另一条路径:store 用 `mutatedFrom` 报告每次 reducer 变更的最小索引,中段工具更新仍走增量。
18. **外部进程探测必须异步**:`where.exe` / `node --version` 在 Windows 上可达数秒,`execFileSync` 会冻结整个扩展宿主(其他扩展一起卡);`locateNodeExecutable` 是 async + 缓存 + 并发去重 + globalState 持久化,成功结果缓存(用 `existsSync` 复验)、失败不缓存。CLI entry 本身自 2026-10-07 起不再探测(vendor 唯一入口,同步 existsSync),此教训保留给未来任何 shelling out 的探测。
19. **`chatForward` 等待条件**:必须在 `idle || error` 时退出(prompt 失败后 status 永不回 idle),cancel 只发一次,并有 10 分钟总超时兜底——旧实现三处叠加会导致 participant 永久挂死 + interval 泄漏。
20. **连接失败要 dispose 子进程**:initialize 超时/握手失败后 CLI 进程会继续存活;`AcpClient.connect()` 内部与 `ensureClient` catch 两处都要 `dispose()`(幂等,双重调用安全)。
21. **vendor 裁剪变更必须重测**:增删 `PRUNE_DIRS` / `PRUNE_PKGS` 前先对裁剪副本跑 `npm run harness` 全流程;同理 `.vscodeignore` 的 `!vendor/iflow-cli/node_modules/**` 例外一旦丢失,打包出的扩展会因缺依赖直接起不来(本地 dev 感知不到,只有 VSIX 安装才炸)。
22. **backdrop-filter 被构建链折叠**:Vite CSS 压缩只留 webkit 前缀写法,经 esbuild 属性折叠后 Chromium 反而忽略模糊——亚克力材质必须同时保留标准与前缀写法的正确顺序,改 `webview/src/styles.css` 材质相关代码前先看 3ff19b9 / 0a26782 两个修复提交。
23. **CLI 模型双变量**:`set_model` 不改 `session/new` 上报值——CLI 内部实际发请求读 `contentGeneratorConfig.model`,而 `session/set_model` 只改这一个、**永不回写** `Config.model`/settings.json;`session/new` 的 `_meta.models.currentModelId` 却取自 `Config.model`(= CLI 启动时 settings.json 的 modelName)。后果:下拉切过模型后点「新会话」/重启 CLI 恢复会话,CLI 上报的还是启动值,直接采纳会让下拉显示 A 而实际用 B(用户实测踩坑,2026-09-17 从 CLI 0.5.19 bundle 逐行验证:`setModel(e){this.contentGeneratorConfig&&(this.contentGeneratorConfig.model=e)}`(可读化产物 iflow.readable.js L177,179),`getAvailable` 返回 `currentModelId: config.getAll().model`)。**修复规则**:面板 store 的 `currentModelId` 是权威值,`startNewSession`/`restoreSession` 的回退链必须含它,`set_model` 不校验 modelId(盲赋值),新会话前用 `validateModelForPush` 对 live 列表校验——模型已下架则回退 CLI 启动模型并警告(明确降级,绝不静默用错模型)。不要反过来信任 `session/new` 的上报值。
24. **流式渲染会 CRASH 面板**:病态 markdown 块/瞬时内容会让 React 渲染抛出,整棵组件树卸载只剩 body 渐变(1.1.1 实测,aria-live 的 useMemo 置于早返回之后导致 hooks 数量不一致也踩过)。`ErrorBoundary`(page 在 main.tsx、inline 在 MessageList)+ `resetKey` 自愈是底线;改渲染链时注意所有 hooks 必须在条件返回之前。
25. **模型下架陷阱**:CLI 上传的模型(session/set_model 盲赋值)如果已不在 live `/models` 列表里,新会话每次 prompt 都会 `model_not_found`。`validateModelForPush` 只对「能证明下架」的查询结果降级;空/失败的 `/models` 查询不构成证据,照常推送。
26. **内部 prompt 会话的工具面与用户会话同源**:enhance/AI 标题在 throwaway session 上跑,但 `session/new` 出来的会话带完整工具集、同一模型——草稿含 `@文件引用 + 祈使句`(如「@docs/xxx.md 开始实现M2」)时模型会把它当成**要执行的任务**,跑偏进 agentic 流程(read_file 大文档后卡死),直到 `INTERNAL_PROMPT_TIMEOUT_MS`(60s)天花板报 `internal prompt timeout`(2026-10-08 用户实测,取证自 `~/.iflow/acp/sessions/<id>.json` 的 chatHistory)。三层防护缺一不可:①模板显式声明「纯文本任务、禁工具」;②onSessionUpdate 拦截器见 `tool_call`/`tool_call_update` 立即 reject+cancel(`--stream` 模式 CLI 不推 pending tool_call、只推 update,两条都要盖住,bundle 实证 `getStream() ||` 短路);③内部会话强制 `setMode("default")` 防 YOLO 下静默执行写/删/shell。另注:排查内部会话行为时,复现脚本必须显式 `authenticate()` 注入面板凭据——面板配置在 SecretStorage 内存隔离,不 authenticate 吃的是 `~/.iflow/settings.json` 里终端 CLI 的本机配置,结论全错(2026-10-08 实际踩坑:曾据此误诊为网关限流)。**第二波(2026-10-09)**:三层防护后仍超时——网关 SSE 直连探针(`test/fixtures/probe-gateway-sse.mjs`,绕过 CLI)实证 tencent/hy3 对含 `@路径` 的草稿**只流 `reasoning_content` 150s+、永不 content/finish_reason**(「要不要先读文件」的无限思考循环,不是工具跑偏),CLI 的 session/prompt 永不 settle,面板只见 thought 不见正文。对照实验:裸路径(去 @)33s 收敛;**括号占位符仍循环**(关键是 `@` 标记本身);`setThink(false)` 并未真正关思考(仍 1180 字符 thought,69s 才收敛>60s 天花板,不可用作修复)。修复=发送前 `stripFileMentions` 去掉 `@` 保留路径文字(enhance 与 AI 标题两条路径都过,只碰词首含斜杠/扩展名的 @token,邮箱与 @人名不受影响)+模板声明「路径是待改写普通文字、直接给结果不要长篇分析」。另证伪一个误判:CLI 对纯文本 prompt 里的 `@path` **不会**展开成文件内容(网关 61K input 是 CLI 系统提示+工具 schema 固定开销,落盘 user part 仅 257 字符)。**第三波(2026-10-09 下午)**:stripFileMentions 已生效(已安装 VSIX 实证含修复且调用点正确)仍超时——repro 实证 tencent/hy3 经 Y-API 对**裸路径**也要思考 60-75s 才开始流正文(且正文产出后 turn 永不 settle:CLI 内部「已达到平台速率限制,Retrying with backoff」退避期间不推任何 session/update、面板计时照跑),`--plain` 纯文本对照 90s 连正文都没有——**是慢网关,不是 @ 循环复发**。修复=天花板 60s→180s + idle watchdog(内部会话 90s 无任何 update 即 `stalled` 中止,拦中途 wedged)+ **部分结果返还**(timeout/stalled 时若已累积正文直接返回——慢网关场景正文其实已完整,只是 turn-stop 没来;tool-call 中止仍丢弃)。超时/间隔值为实例字段(internalPromptTimeoutMs/internalPromptIdleMs,常量作默认)供测试注入小值;`reason` 变量在 catch 处被 TS 控制流收窄回初始字面量(TS2367),需一次显式拓宽读取。**第四波(2026-10-09 晚,根治)**:三层防护+180s+idle+salvage 全装上后用户实测仍超时——新日志证实机制在工作(15:45 `stalled`、15:48 `timeout`)但 salvage 无内容可返:stalled 会话 chatHistory 全空(90s 零输出)、timeout 会话 model turn 无 parts(180s 纯思考零正文)。决定性证据:`probe-gateway-sse.mjs` 用**同一任务/模型/网关绕过 CLI** 60.3s 完整收敛(20.9s TTFB→31.3s reasoning→52s content→stop)——网关没问题,**是 CLI 内部会话携带的 ~61K tokens 固定输入(系统提示+全部工具 schema)把思考模型推进 180s+ 思考循环**。根治=内部提示词彻底绕开 CLI:新模块 `src/acp/complete.ts` 的 `streamChatCompletion` 直连 OpenAI 兼容端点(`POST {baseUrl}/chat/completions` stream:true,原生 node:http(s) 避开 fetch 代理 patch,陷阱 #2 同源),endpoint=SecretStorage 面板凭据优先、CLI settings.json profile 回退,model=store.currentModelId 优先、profile modelName 回退;salvage 语义迁移(timeout/stalled 有正文即返,failed 丢弃)。随之删除全部 CLI 内部会话死代码:internalSessionIds/isInternalSessionId(含 permission/planExit/questions 三处守卫)、onSessionUpdate 拦截块、tool-call 守卫与 lastInternalPromptFailure。**教训**:内部纯文本改写任务从不需要 agent 会话——给 LLM 调用选通道先问「这任务需要工具面吗」,CLI 包装的固定输入开销会污染思考模型行为;直连后 enhance 从 180s 超时变 ~60s 返回。
27. **长会话内存三纪律(2026-10)**:转录全量驻留 host+webview 两份,重 payload(tool 输出 64K 字符、diff 256KB、图片 ≤8MB、SubAgent 嵌套同规格)块数无上界,长会话能把 window 进程顶到 ~1GB(DOM 挂载窗口只界渲染不界数据)。①**webview 侧裁剪**:`evictBlockPayloads`(shared/messages.ts,纯/幂等/无变化返回原引用)在 store 的 snapshot/blockPatch 合并后释放保留窗口之外旧块的重 payload 并打 `evicted`,UI 显「内容已释放」标记;**host 全量是保真承诺**(revert/openDiff/export/transcript 落盘全读 host),绝不在 host 裁;**保留窗口是双上限**(2026-10 第二波实测:长会话 249 块却 23.4MB payload、8 个 590KB tool diff,「保留 200 块」=保留 22.2MB,纯块数上限形同虚设)——块数 `EVICT_KEEP_BLOCKS`(200,须大于 MessageList 的 `MAX_WINDOW` 120)与字节预算 `EVICT_BUDGET_CHARS`(`payloadChars` 从尾部累加可释放量,4M 字符)谁先触谁算,`EVICT_MIN_KEEP`(20)保底最新轮次可读。②**WireRingBuffer 双上限**:帧数 2000 之外按 `line.length` 字符预算(默认 8M)驱逐最旧帧——单帧 raw stringify 可含全量工具输出,只封帧数不封字节;最新一帧恒保留(超预算单帧不清空 buffer)。③**Collapse 折叠体懒挂载**:`Collapse` 保持 children 常驻做动画,OutputDetails 与 SubAgent 只读转录用 `openedOnce`/`transcriptMounted` 首次打开才挂载——折叠未打开=零 DOM,改这两处别退回常驻。④**DiffView DOM 行上限**:diff 体常挂载(不是 Collapse 子体),`collapseAroundChanges` 对**整文件变更窗口**(minified 产物编辑)折不动——万行级 DOM × 挂载窗数十卡是 window 进程数百 MB 的主因;渲染只取 `INITIAL_RENDER_ROWS`(800)前缀,滚动接近底部或尾部按钮追加 +800,改 DiffView 别退回全量渲染。

28. **记忆文件路径与写入陷阱(2026-10 实证)**:CLI 的层级记忆加载器(`jva`)把全局目录硬编码为 `os.homedir()/.iflow`,**不认 IFLOW_HOME**;而 `save_memory` 的 `Nz()` 走 `Tn()`(认 IFLOW_HOME)。harness 不注入 IFLOW_HOME,所以面板统一用 `memoryHome()`(homedir)与 loader 对齐。`~/.iflow/memory.md` 当前 loader **不读取**(probe 验证),只能作为遗留文件展示,不能声称已注入;旧 fallback 读它是错的。ACP 模式下 `/memory add` 返回 `type: "tool"` 后 `R8u` 只打印 “Executing tool” 不执行,所以快捷记忆必须由扩展直接写文件。记忆在 `session/new` / `session/load` 的 `newSessionConfig` 时加载,当前 chat 的 systemInstruction 已固定;要热更新只能重启 CLI 并恢复会话。`@relative/path` 导入在记忆文件中可用(Phase 3 知识库依赖),但不要放进代码围栏。

29. **记忆写入回包串包(2026-10,Phase 2)**:`memorySaved` 是广播消息,`applyMemoryCandidates` 会为每条候选各发一次;快捷添加弹窗若只看“任意 memorySaved”就会把别的写入当成自己的成功回包并吞掉真实失败。`appendMemoryFact` 必须携带 `requestId`,`MemoryService.appendFact` 原样回传,弹窗按 id 过滤(无 id 的批量写入被忽略)。批量 apply 不要复用快捷弹窗的 ack。
30. **知识库注入不能只看 primary 记忆文件(2026-10,Phase 3)**:CLI 会加载 primary + 祖先 additional + 递归 hierarchy 的 `AGENTS.md`/`IFLOW.md`;若只在 primary 里检测/增删 `@.iflow/knowledge/index.md`,根目录已有的导入会被 UI 误报“未注入”,再点注入会让知识正文在每个记忆文件各展开一次。`knowledgeState` / `setKnowledgeInjection` / `ensureKnowledgeImport` 必须遍历 `projectMemoryFiles(root)`(所有 exists && editable 的项目记忆文件)并做重复检查;取消注入要从所有文件移除。注入目标文件还必须遵循 CLI `contextFileName`(不能硬编码 `AGENTS.md`)。
31. **多子会话打破了「单会话单进程」的假设(2026-11-09,Super Agent)**:面板原本硬假设「一个 CLI 进程 + 一个 session」——`panel.ts` 的 `client` 字段单例、`dropSessionUpdate` 把外来 sessionId 一律丢弃、`pendingApproval`/`pendingPlanExit`/`pendingQuestions` 各是**单数**槽位、`sendPrompt` 有全局 streaming 闸。Super Agent 因此**不能**把子会话塞进主 store 或主 client:子会话走**独立 CLI 进程**(各带各的 cwd 与凭据),转录不进 `blocks`(会污染主转录并破坏 blockPatch 锚),状态以 `SessionState.superSessions` 投影;子会话的**提问**落在 `SuperSessionUi.pending` 里(审批不产生待办——子会话始终免确认,宿主直接放行 `request_permission` / `plan/exit`),不走主会话那三个单数槽位。**新增子会话相关消息时先确认它不会与主会话的 pending 槽位抢位**。另一个坑:子会话的 CLI 进程必须 `allowedRoots` 只含 worktree 根(默认是主仓外的 `<repo>-super-worktrees/<id>/` 兄弟目录,见 `src/panel/worktree.ts`,仅安全检查失败才回退项目内 `.iflow/super/worktrees/`)、`--include-directories` 传空,否则 CLI 侧的 `isPathWithinWorkspace` 会放行子代理写主工作区(与宿主 `resolveAgentPath` 不同源,两边必须同时收窄)。**再一个坑(2026-11-09 第二版)**:免确认 + 自动合并拿掉了「审批即安全网」这层假设 —— 子会话能不经审批跑 shell(`run_shell_command` 类工具本来就不受 `allowedRoots` 约束),隔离只剩工作目录,所以看板与汇报必须如实标注「免确认」,不能让人误以为工具调用会被过目。自动合并**必须在串行 promise 链里执行**(排队/串行派发现在在 `src/panel/super-agent-host.ts`,git 合并本体在 `src/panel/worktree.ts` 的 `mergeBranch`、由 `src/panel/super-agent.ts` 调用):多个子会话同时完成时并发 `git merge` 会让第二次撞上第一次的中间态;并且**必须**先 `git rev-parse --verify MERGE_HEAD/REBASE_HEAD/CHERRY_PICK_HEAD` 确认不在中间态(冲突回滚可能带走用户未提交的改动),再用 `git merge-tree --write-tree` 预演冲突与「合并会改动哪些路径」——脏工作区不再一律跳过(旧规则让自动合并事实上从不触发:用户几乎总有未提交/未跟踪文件),只有「预演路径 ∩ 用户未提交的**已跟踪**改动」非空时才让路,未跟踪文件交给 git 自己的同名检查(它在动手前就拒绝、工作区不变)。无论哪条路径都绝不自作主张替用户 `commit` / `stash` / 撤销用户的改动。
32. **子会话 worktree 的 `node_modules` 不能和 `npm ci` 共存(2026-11-11 实际踩坑)**:Super Agent 子会话的 worktree 里没有依赖(worktree 默认在主仓外的 `<repo>-super-worktrees/<id>/`,见 `src/panel/worktree.ts`),常见做法是建一个指向主仓 `node_modules` 的目录联接 —— 这本身是安全的,因为 `npx vitest` / `npx tsc` / `npx vite build` 只**读** `node_modules`,不删不写。但**永远不要**在联接存在时执行 `npm install` / `npm ci`:`npm ci` 的第一步就是删除 `node_modules`,碰到 Windows 目录联接会顺着链接把**主仓那份**一起清掉(实测:一次 `npm ci` 后主仓 `node_modules` 只剩 1 个条目,本地 `npm run build` / F5 全部失效)。确需真装依赖时,先删除联接、再在 worktree 内 `npm ci`,两者绝不共存。派发子会话时任务书必须写明这条 —— 之前任务书把「建联接」写成了省事的装依赖办法,直接导致事故。

## 测试

- 框架:vitest 5,配置在 `vitest.config.ts`,`include: ["test/**/*.test.{ts,tsx}"]`,`testTimeout`/`hookTimeout` 均为 5000ms。当前 **55 个测试文件 / 898 个用例**(2026-10-21 实测;`attachments.test.ts` 的 broken-symlink 用例在非特权 Windows 上因 CreateSymbolicLink 需权限而 EPERM,属环境限制非回归)。
- `vscode` 模块通过 alias 指向 `test/vscode-stub.ts`(只提供 `l10n.t` 恒等实现)。
- 现有覆盖:`jsonrpc`(NDJSON 分帧/路由/超长帧丢弃)、`acp-client`(用 `test/mock-acp-agent.mjs` 起假 agent)、`auth`(SecretStorage 注入式假实现)、`models-query`(临时目录写假 settings.json)、`session-state`(reducer + transcript 解析 + 块 id 不变量 + SubAgent 归组 + 系统状态分类 + 压缩卡泄漏 + tool diff 合成 + 审批流 + 用量估算与 P1 token 缓存)、`store-snapshot`(节流快照 + blockPatch 锚定 + P-1 全链路保真 + toast 生命周期)、`error-boundary`(jsdom 环境,渲染抛错回退 + resetKey 自愈,`@vitest-environment jsdom`)、`internal-prompt`(mock `streamChatCompletion`:salvage/busy 门控/`stripFileMentions`/enhance 取消与会话隔离 + 回合末合并请求只发一次调用并按标题·候选·记忆三部分分发、按开启项裁剪提示词内容、超时取最宽松上限)、`memory-service`/`memory-extract`(提取门控与 2 分钟限流只在请求真正发出时消耗、loading pill 生命周期、严格 JSON 候选解析与去重)。
- 约定:测纯逻辑,不起真实 CLI、不碰真实 SecretStorage。需要文件 I/O 时用 `mkdtempSync` + `afterAll` 清理。UI 组件(如 ErrorBoundary)用 jsdom 跑。
- wire 录制回归:旧 `test/fixtures/`(harness --record 产物)已删除且 `.gitignore` 已加 `test/fixtures/*.ndjson` / `*.json`——录制输出不再入库;wire 行为验证以代码注释里的 `Wire behavior (probed, CLI 0.5.19)` 记录为准。
- **vitest 参数口径**:**全量回归用 `npx vitest run`**(保持默认的 per-file 隔离)。`--no-isolate` 会让 `vi.mock` 跨文件泄漏,产生**几十个文件的假失败**(实测 312 条 / 46 文件)——那些不是回归,是 mock 串味。`--no-file-parallelism --no-isolate --pool=forks` 这组参数**只在单文件定向跑**时用(如排查某个文件的挂起),别拿它跑全量。
- **已知技术债(2026-11-23 盘点,本次未修)**:①`tsconfig.test.json` 有既有报错(`.tsx` 的 JSX flag / dom lib / node16 扩展名),该 tsconfig **未被任何 workflow 引用**,不在 CI 闸门内——修它属于独立任务,别混进发版;②测试会把 worktree 夹具写进**真实的 `~/.iflow/super/worktrees/`**(生成 `pkg-*` 目录,已累积 94 个,体积可忽略但无界增长),属测试卫生问题,未修;③**完全信任档**的 shell git 操作(push / rebase / 切分支 / 删分支 / stash)尚未放行,`git add -A` 的 tool 档拒绝**保持不变**(那是数据保护护栏,与工具白名单是两件事,别顺手一起放开);④CLI 侧 `saveSettings` 仍是非原子的整文件 `writeFileSync`——**上游源头未根治**,宿主这侧只是不再把它放大成「永久丢键」。

## 联调与验证

```bash
npm run harness                                  # initialize → newSession → prompt,权限全拒(安全)
npm run harness -- --record                      # 额外录制 wire 日志(现被 gitignore,不入库)
npm run harness -- --probe                       # 探 set_mode / set_model / set_think 行为(不发 prompt,不耗 token)
npm run harness -- --prompt "..."                # 自定义 prompt 文本
IFLOW_CLI_ENTRY=/path/to/entry.js npm run harness  # 覆盖入口(vendor 裁剪验收用;默认已是 vendor/iflow-cli)
```

`harness.mjs` 从 `dist/src/acp/*.js` 导入(即需要先 `npm run build`),因此它同时是「构建产物可用性」的冒烟测试;对裁剪后的 `vendor/iflow-cli` 跑它也是 vendor 变更的验收手段(见陷阱 #21)。

## 发布流程

- **`CHANGELOG.md` 是版本唯一来源但「双处同步」**:release 流程从顶部 `## [x.y.z] - date` 标题读版本号与摘要,写入 `package.json`(`scripts/read-changelog.mjs`)。新增版本时**同时更新 CHANGELOG 与 `package.json.version` 到同一版本号**再提交——「不要手动改 package.json」的本意是别在未同步 CHANGELOG 的情况下单独改,否则 CI 会把版本覆写回 CHANGELOG 里的旧号,商店与仓库版本永远对不上(2026-09-13 实际踩坑:为覆盖商店缓存手动 bump 到 1.0.3 但 CHANGELOG 仍在 1.0.2、package.json 停留在 1.0.1)。发布前自检:`grep '"version"' package.json` 与 `head -6 CHANGELOG.md` 必须一致。
- `ci.yml` 与 `release.yml` **都只在 `release` 分支触发**(push + PR / 手动 dispatch)——master 不再跑 CI。
- `ci.yml`:三平台矩阵(ubuntu/windows/macos)跑 typecheck → test → build。
- `release.yml`:npm ci → typecheck → test → 读 CHANGELOG → 写 version 进 package.json → `npm run package`(含 `vendor:cli`,从 npm 拉定制 CLI 裁剪进包)→ **用原生 `gh` CLI** 打 tag `v*`、建 GitHub release 并附 `.vsix`。
- **release 卡 Draft 陷阱(已用 gh CLI 根治)**:`softprops/action-gh-release` v3 有 `draft:false` 被忽略的 bug(除非同时 `prerelease:true`,见 softprops/action-gh-release#379),且并发重跑会把已发布 release 重置回 Draft。release.yml 现改为原生 `gh release` 三态:已存在 draft → `upload --clobber` + `edit --draft=false`;已发布 → 仅 refresh asset(绝不 re-edit);不存在 → `gh release create`(默认发布态)。`--confirm` 标志已移除(gh CLI 2.x 删了它)。改动打包/发布逻辑时保持这三态幂等,别退回 action-gh-release。
- 打包命令是 `vsce package --no-dependencies`,**不带** `--baseContentUrl` / `--baseImagesUrl`——`docs/**` 已被 `.vscodeignore` 排除(见陷阱 #15)。
- 发布前若改过本机 `~/.iflow/` 默认规则,先 `npm run defaults:sync` 同步到 `scripts/iflow-defaults/` 再提交。
- 新增用户可见设置项时记得同步 `package.nls.json` + `package.nls.zh-cn.json`(1.1.0 加了 `iflow.auroraIntensity`)。

## 给后续 Agent 的建议

- 改 `panel.ts` 前先读它顶部的常量区与类字段注释,审批/提问/Plan 退出/会话持久化/恢复/重试/用量估算几条链路都靠私有状态字段串起来;该文件已 ~3250 行,新增职责优先考虑下沉到 `src/acp/` 或 `shared/`。
- 任何「CLI 行为」的假设都应在代码注释里标注验证来源(版本 + 实测方式),本仓库大量注释都是这种 `Wire behavior (probed, CLI 0.5.19)` 风格——沿用这个习惯;vendor 裁剪清单同理(`vendor-cli.mjs` 顶部注释记录了逐项验证依据)。
- bundle 实证优先查 iflow-fork 的 `reverse/iflow.readable.js`(esbuild 可读化产物,~23 万行,可检索;原始 bundle 是 2MB 单行没法看):功能区行号地图在 `reverse/ANALYSIS.md`,关键词指纹可用 `reverse/map.mjs` 重扫;换 CLI 版本后行号漂移,按 ANALYSIS.md 的复现命令重跑可读化,定位靠字符串常量不靠混淆标识符。
- 纯 reducer 全在 `shared/session-state.ts`(~1540 行),改动前先确认对应函数与测试;新增 reducer 记得返回变更索引供 store 的 `mutatedFrom` 增量路径使用,并同步 `noteMutationIndex` 接线。
- 新增 UI 组件放到 `webview/src/components/`,样式用 Tailwind 4 + oklch 设计 token(见 `webview/src/styles.css`),深/浅色主题由 Host 推送 `theme` 消息驱动,默认跟随编辑器主题;图标统一用 `lucide-react`(不要 emoji/字符);动亚克力材质前先看陷阱 #22。
- 想脱离 VSCode 迭代 UI:`webview/src/store.ts` 的 `createMockHost()` 提供 demo 快照(含审批/提问/Plan 卡与用量说明),可用静态服务器直接跑 webview。
- 新增设置项要确认它真的实现了——`iflow.idleTimeoutMinutes` 就是声明了但没实现的先例(已删除,见陷阱 #14)。
- 碰 vendor 链路(vendor:cli / defaults:sync / .vscodeignore 例外)时,先读「内置 CLI(vendor,唯一执行体)」一节与 `scripts/vendor-cli.mjs` 顶部注释,改动后必须 `npm run harness` 验收并打一个 VSIX 装到干净环境冒烟。
- webview 侧类型检查:`cd webview && npx tsc --noEmit`(webview 有独立 tsconfig,不参与主 typecheck)。

<!-- iflow-harness:knowledge:start -->
## 项目知识库
@.iflow/knowledge/index.md
<!-- iflow-harness:knowledge:end -->
