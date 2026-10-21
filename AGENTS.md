# AGENTS.md

## 项目概览

**iflow-harness**(产品名「心流·驭光」)是一个 VSCode 扩展,把 iFlow CLI 的 Agent 能力图形化地接入编辑器。它通过 **ACP(Agent Client Protocol)** 驱动 CLI:spawn 一个 `--experimental-acp --stream` 子进程,用 **NDJSON 分帧的 JSON-RPC 2.0** 双向通信,提供流式对话、工具审批、Diff 回退、会话持久化、API Profile 管理、@文件补全、附件与选区上下文、ask_user_question 提问卡、Plan 模式审批、速率限制与上下文溢出的自动恢复。**执行体固定为扩展内置的裁剪版定制 fork(`vendor/iflow-cli`,源 `@yuentao/iflow-cli`)**——loader 补丁只存在于这个 bundle 里,扩展不探测、不使用本机安装的 CLI,也没有任何 env/设置覆盖(2026-10-07 移除探测回退链)。

- 技术栈:TypeScript 7(strict)+ React 19 + Tailwind CSS 4 + zustand 5 + Vite 8 + vitest 5
- 目标环境:VSCode `^1.90.0`,Node 22(CI)/ node20(esbuild target)
- 仓库:`package.json` 声明 GitHub(`https://github.com/yuentao/iFlow-Harness.git`),但实际 `git remote` 仍指向内部 GitLab(`https://git.pandorastudio.cn/product/iFlow-harness.git`)——两处不一致,改发布配置时注意别踩空
- 当前版本:见 `CHANGELOG.md` 顶部(现为 `1.1.2` / 2026-09-19)。**版本对齐硬性要求**:`package.json` 的 version 必须与 CHANGELOG 顶部 `## [x.y.z]` 保持一致再提交——release workflow 从 CHANGELOG 读版本并覆写 package.json,若两者漂移(如为覆盖商店缓存手动 bump 版本却不改 CHANGELOG),CI 会把版本覆写回旧号,商店与仓库永远对不上(2026-09-13 实际踩坑:商店已 1.0.3,仓库 CHANGELOG 还停留在 1.0.2、package.json 停留在 1.0.1)。发布前自检:`grep '"version"' package.json` 与 `head -6 CHANGELOG.md` 必须一致。
- 版本历史:0.1.0(2026-08-30 首版)→ 0.2.0(2026-09-07 全新 UI)→ 1.0.0(2026-09-11 提问卡/附件/内置 CLI 等)→ 1.0.1(2026-09-12 模型下拉修复)→ 1.0.3/1.0.4(2026-09-13 商店上架/倒计时与视觉升级)→ 1.0.5(2026-09-13 下拉硬门控/滚动锚定修复)→ 1.1.0(2026-09-15 token 用量/toast 浮层/Plan 确认卡/消息编辑回归)→ 1.1.1(2026-09-15 白屏崩溃/输入框拖拽/vendor bin 修复)→ 1.1.2(2026-09-19 Plan 计划编辑/历史下拉/set_model 对齐)

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
| `shared/messages.ts` | Host ↔ WebView 消息协议 + `Block` / `SessionState` 类型(两侧共用)+ `applyBlockPatch`(含 `toast`/`dismissToast`、`regenerate`、`openDiff` 消息) |
| `shared/session-state.ts` | 纯会话状态 reducer(`applySessionUpdate`、SubAgent 归组、`parseTranscriptJsonl`、块 id 分配/回填、`toAgentPromptText`、BPE token 估算、MCP 编辑 diff 合成) |
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

- **来源是定制 fork**:npm 源为 `@yuentao/iflow-cli@0.5.19-custom.3`(tag `custom`),带本地注入的 `*.loader.cjs` 定制 bundle——官方 `@iflow-ai` 包不含。loader 源码来自 [iFlow-Mods](https://github.com/yuentao/iFlow-Mods) Mod 仓库:patch 型 Mod(thinking-mode / multimodal-image / output-token-limit / kimi-request-override / context-window refactor)在 CLI 源码同一插入点以 1 行 require 注入 loader,monkey-patch 模型规则并外置到 `~/.iflow/*.json`;Mod 可用 [iFlow-Mod-Builder](https://github.com/yuentao/iFlow-Mod-Builder)(Tauri+Vue3 GUI)打包成 `.iflow-mod` 安装。`--from <tgz>` / `--from-dir <dir>` 可完全绕开 npm 源(离线/本地定制场景——`--from-dir` 正是装载带新 loader 的本地定制 CLI 的路径,`--from-dir` 自带 node_modules 会跳过安装;脚本会剔除源目录的 `.git` 防进 VSIX)。custom.3 新增 `mcp-background-loader.cjs`(方法体委托型,不经过 L950):CLI 0.5.19 在 `--experimental-acp` 下 `isNonInteractive` 为 true,`discoverAllTools` 走**同步** `await discoverAllMcpTools()` 分支且 MCP `connect()` 无超时——npx 型服务器在 npm registry 不可达时无限挂起、ACP initialize 握手永久卡死(交互 TUI 反而走后台分支不受影响);loader 让 ACP 场景改走 CLI 自带的 `startMcpDiscoveryInBackground()`(MCP 工具连接完成后陆续注册),`-p` 一次性模式保持同步,`IFLOW_MCP_BACKGROUND=0` 退回原行为。
- **mcp-session-share Mod(ACP 进程内 MCP 连接池)**:CLI 0.5.19 的每个 ACP 会话(session/new 与 session/load 都算)各自 `newSessionConfig()` 新建 Config,`discoverAllMcpTools()` 为每个配置的 MCP server spawn 一整条 stdio 进程链(cmd→npx-cli→server→watchdog,Windows 上每 server 约 3 个 node);harness 恢复会话的 probe newSession+loadSession 让舰队翻倍,而 ACP 方法表没有 session/close,被丢弃 probe 会话的舰队常驻整个 CLI 生命周期(2026-10-05 实测:单窗口 4 个 npx server 遗留 58 个 node.exe)。Mod 把 `discoverAllMcpTools()` 包上进程级池(`globalThis.__iflowMcpShare`,key=server 名+配置指纹):首会话认领 spawn 权(claim)并登记;后续会话收养健康池内 client(重指向新会话的 toolRegistry/promptRegistry/workspaceContext/config 后仅 `discover()` 重放,零 spawn);指纹变化/client 状态非 connected/discover 抛错 → 驱逐走原 spawn 路径。claim 机制专为 background-loader 后台化后的并发交叠设计(probe 与 load 的 discovery 同时进行,无 claim 则都查空池都 spawn)。仅 `--experimental-acp` 生效,TUI 与 `-p` 一次性不受影响,`IFLOW_MCP_SESSION_SHARE=0|false` 关闭,loader 缺失回退原行为。**与其他 Mod 同标准交付**:源在 iFlowMods 仓库 `mcp-session-share-refactor/`(mod.json type=patch + code.js 单点替换 + `mcp-session-share-loader.cjs` → core + README),方法体委托型不经过 L950 插入点,`.iflow-mod` 安装包放 dist/(gitignored);注入体随定制 fork `@yuentao/iflow-cli` 的 bundle 发布,vendor-cli 直接拉取即带上,**harness 不再自造注入脚本**。验证(2026-10-05):同一 CLI 进程连开 2 会话,session1 舰队 9 进程、session2 增量 0、dispose 后清零。**改 CLI bundle 版本后必须在 iFlowMods 重新生成 code.js——锚点漂移会让构建脚本硬失败**。
- **acp-compress-persist Mod(slash /compress 压缩结果落盘,2026-10-08)**:CLI 的 `AcpSession.prompt()` 对 slash 命令在 `handleAcpSlashCommand` 返回后**早返回**(`shouldEndTurn`),绕过轮末 `finally { saveSessionState() }`——slash `/compress` 只改内存 chat,`~/.iflow/acp/sessions/<id>.json` 仍是压缩前全量历史;下一次 `session/load`(面板切 Profile keepSession / 重启恢复)`setHistory` 全量灌回,模型上下文静默回涨(实测:同会话两次压缩 originalTokenCount 均为 114057,第一次被中间切换静默还原;面板 UI 因 transcript 折叠估算仍显示"已压缩")。Mod 在早返回前对压缩命令(compress/summarize/compact)`await this.saveSessionState()`(CLI 自带落盘路径,幂等);loader `shouldPersist(cmdText)` 按命令名判定,`IFLOW_SLASH_PERSIST=0|false` 退回,loader 缺失/抛错静默回退。锚点是 slash 处理块整段 minified 字符串(original/fork/vendor 三处逐字节一致、各唯一 1 处),`apply-patch.mjs` 锚点不唯一即硬失败。源在 iFlowMods `acp-compress-persist-refactor/`,随定制 fork `@yuentao/iflow-cli@0.5.19-custom.6` bundle 发布。验证(2026-10-08):newSession → 一轮 prompt → `/compress` 后会话文件 mtime 更新且 chatHistory 首条为压缩 summary turn;标准 harness 全流程通过。**改 CLI bundle 版本后必须在 iFlowMods 重新生成 code.js——锚点漂移会让构建脚本硬失败**。
- **agent-cancel-refactor Mod(按 agentId 单独停止子代理,2026-10-11)**:CLI 每个 SubAgent 本有独立 AbortController(`createAndExecuteAgent` 的 `h=new sut(...)`),但父信号只单向传播、ACP 方法表无按代理取消、执行循环 `executeAgentWithSession` 只吃父信号——外部无法触达且 abort 打不断在途请求。Mod 五处小注入(均不经 L950,`apply-patch.mjs` 锚点各唯一 1 处 + round-trip 校验):①`register(d,p.id,h)` 进程级注册表(wire agentId + instanceId 双键,唯一 require 点)②循环体首 `o=__iflowAgentCancel?.mergedSignal?.(e.agentId,o)||o`(AbortSignal.any([父,子]),Node<20.3 手动合成回退)③方法表 `case"_iflow/agent/cancel"`(lazy require loader;答案 `{stopped,reason?}`,未知 agentId 返回 not_found 不抛协议错)④`executeWithRetry` catch 对 `isAborted(e)` 短路(否则 abort 会被当瞬态失败重试 3 轮)⑤finally `unregister`。被停代理走 CLI 自带优雅分支(catch 判 `h.getSignal().aborted` 返回 `wasInterrupted:true`),**父代理继续跑**;适配器仍对 abort 推 AGENT_FAILED(在 abort 判定前无条件发出),扩展侧以 `SubAgentBlock.stopped` 乐观标记驱动「已停止」显示(`markSubAgentStopped`,host 收到 stopped:true 后调用)。仅 `--experimental-acp` 生效,`IFLOW_AGENT_CANCEL=0|false` 退回,loader 缺失静默回退。源在 iFlowMods `agent-cancel-refactor/`,注入已应用到本地定制 fork bundle(`@yuentao/iflow-cli@0.5.19-custom.8`,**尚未发布 npm**——发布后 `npm run vendor:cli` 才能默认拉到,当前 vendor 经 `--from-dir` 装载本地产物)。验证(2026-10-12,`test/fixtures/probe-agent-cancel.mjs`):未知 agentId→not_found;真实 task 子代理→`{stopped:true}`、整轮 `end_turn` 正常 settle、task 卡无 failed 更新;扩展面板按钮端到端点击尚未实测。**改 CLI bundle 版本后必须在 iFlowMods 重新生成锚点——漂移会让 apply-patch 硬失败**。
- **acp-usage-report Mod(权威上下文占用上报,2026-10-12)**:CLI 生成器层其实已捕获每次请求的 `usageMetadata`(OpenAI 兼容路径把 SSE 的 `usage` 转成 `usageMetadata`、Gemini 原生直接带),但 ACP `AcpSession.prompt()` 的工具循环只遍历块取 `candidates`/`functionCalls`、末尾 `return{stopReason:...}` 把它丢弃。bundle 实证(动态 DBG):块级 `v.usageMetadata` 只挂在**末块**(15 块中仅第 15 块带),且 ACP 会话拿不到 generator 的 `lastUsageMetadata`(`getContentGenerator().lastUsageMetadata` 实测 undefined)——**块级捕获是唯一可行路径**,不是读 generator 字段。Mod 三处纯内联 mini-inject(逻辑是单赋值,无 loader 文件;`apply-patch.mjs` 锚点各唯一 1 处 + round-trip 校验):①循环初始化 `d=0,f=0,p=3,h` 后声明 `__iflowU`(env 门控,null=禁用/0=启用未捕获/>0=末次输入)②`for await(let v of E)` 体内 `if(__iflowU!==null&&v.usageMetadata&&...promptTokenCount)__iflowU=...`(非零覆盖,末块胜出)③return 附 `...(__iflowU?{usage:{lastRequestInputTokens:__iflowU}}:{})`。语义:`lastRequestInputTokens`=末次请求输入=轮末模型实际携带上下文(系统提示+工具 schema+历史+本轮工具 I/O),正是占用条 `contextUsed` 口径;input/output 拆分与跨轮累计属第二档(wire 不带,需逐请求数组)。扩展侧:`PromptResponse.usage`(protocol.ts `TurnUsageReport`)→ `store.promptCompleted(stopReason,usage)` → `completePrompt` 写 `state.usageReport`(锚 `atBlockCount`)→ `refreshSessionUsage` 覆盖层在 `atBlockCount===blocks.length` 时盖 `contextUsed` 并置 `usageAuthoritative`;块数一变(下一轮流式/压缩卡出现)自动过期退回估算(压缩后 fold 的 floor 是 CLI 自带 newTokenCount,仍权威),`deleteUserMessageById` 显式清(chatHistory 同步截断,块数巧合相等时锚点看不见)。仅 `--experimental-acp` 生效,`IFLOW_USAGE_REPORT=0|false` 退回上游(运行时 PromptResponse 与上游逐字节一致)。源在 iFlowMods `acp-usage-report-refactor/`,注入已应用到 vendor bundle 与本地定制 fork bundle(`@yuentao/iflow-cli@0.5.19-custom.8`,iflow-fork 提交 `98bf359`;**尚未发布 npm**——发布后 `npm run vendor:cli` 才能默认拉到,当前经 `--from-dir` 装载)。验证(2026-10-12,`test/fixtures/probe-usage-report.mjs`):默认 env 上报 37404 tokens、`IFLOW_USAGE_REPORT=0` 返回 `{stopReason}` only。**改 CLI bundle 版本后必须在 iFlowMods 重新生成锚点——漂移会让 apply-patch 硬失败**。
- **web-search-refactor Mod(web_search backend replacement,2026-10-15)**:内置 web_search 的 platform endpoint `platform.iflow.cn/api/search/webSearch` only accepts iFlow platform keys (bundle evidence: `getSearchApiKey(){return this.searchApiKey??contentGeneratorConfig?.apiKey}` falls back to the profile apiKey; direct POST probe returns `{"success":false,"code":"90402"}`) — third-party OpenAI-compatible profiles always error ("no longer usable"). Mod single-point anchor is the MAIN-SESSION core-tool registration in `createToolRegistry()`:`bB()==="aone"?r(j0e,this):r(u3,this)`(unique 1 处)——factory `r(cls,...)` re-instantiates via `new n(...o)`,so instance-level wrapping at the OTHER site(SubAgentManager `new u3(this.config)`,also unique)does NOT cover the executed instance;loader `patchClass(u3)` replaces the CLASS PROTOTYPE `executeInternal`(WeakSet idempotent,function expression binds this,`orig.call(self,...)` keeps upstream path).Engine chain default `iflow→bing→ddg`:iflow first keeps official endpoint for iFlow keys(accepted only on non-empty `sources`),else Bing HTML scrape of www/cn.bing.com `b_algo` blocks(both verified reachable from CN dev box,10+ results;title/date/link/snippet extracted)→ ddg(html.duckduckgo.com,best-effort,unreachable CN,for VPN/abroad).Return contract field-for-field same upstream `{llmContent,returnDisplay,sources:[{web:{uri,title}}]}` with `[N] title/date/link/snippet` blocks.Config `~/.iflow/web-search.json`(第 5 default rule json,seeding chain `ensureIflowDefaultConfigs` is generic `*.json` so no host code change;template in `scripts/iflow-defaults/`);env overrides `IFLOW_WS_ENGINES="bing,ddg"` + `IFLOW_WEB_SEARCH=0|false` reverts.Source in iFlowMods `web-search-refactor/`(apply-patch.mjs anchor-hard-fail + round-trip),injected into vendor bundle local artifact;full ACP verification(2026-10-15,`test/fixtures/probe-web-search.mjs`):`IFLOW_WS_ENGINES=bing` tool returns "Searched web: ... (5 results)" + no 90402/Search-capability text,`IFLOW_WEB_SEARCH=0` reverts.**改 CLI bundle 版本后必须在 iFlowMods 重新生成锚点——漂移会让 apply-patch 硬失败**。
- **mcp-status-refactor Mod(MCP 连接状态上报,2026-10-15)**:CLI 侧 bundle 实证:`session/new` 的 `_meta.availableMcpServers` 无状态字段、ACP 方法表无查询通道——`/mcp list` 渲染器(`RKi`)读状态从 `Djt` Map(写 `vk(name,status)`、读 `Ese(name)` 默认 DISCONNECTED)且连接失败原因在 `k2n` catch 只做 `console.error` 后**丢弃**,错误文本只能在 catch 点 capture。Mod 四处注入(`apply-patch.mjs` 锚点各唯一 1 处 + round-trip 校验):①init 点 `Djt=new Map,Tjt=bE.NOT_STARTED,...` require loader + `globalThis.__iflowMcpStatus.attach(Ese,Rjt)` ②`vk` 体内前置 `record?.(t,e)` ③catch 追加 `recordError(t,u)`(loader `classifyError` 判 spawn_failed/timeout/protocol/network/unknown)④方法表 `case"_iflow/mcp/status"` 回 `{available, discoveryState(Rjt→bE 三态), servers:{name:{status,toolCount,promptCount,tools[{name,description?,schema|schemaOmitted}],prompts,disabled?,blocked?,error?,errorKind?}}}`,per-server tools JSON 预算 4MB 超限即 `schemaOmitted`(NDJSON 8MB 帧护栏),loader 缺失静回 `{available:false,reason:"no_loader"}`,stdout 永不 console(NDJSON wire)。仅 `--experimental-acp` 生效,`IFLOW_MCP_STATUS=0|false` 退回。扩展侧:`AcpClient.mcpStatus(sessionId)` → panel `sendMcpStatus` → `McpStatusUi`(每 server 补 `contextTokens` = `estimateMcpContextTokens` host 把工具声明 JSON 过真实 BPE(o200k_base),与占用条同口径;CLI 无 MCP token 估算本体)→ webview McpCard 行首状态圆点(connected 绿/connecting 蓝/disconnected 红,无通道空心灯,未回包无灯)+ `≈N tokens` 上下文 chip + 详情子页(状态 chip、error 框、transport、tools 带 `<pre>` schema、prompts、返回)+ RefreshCw 手动重发;状态通道独立 of 配置通道(`mcpStatus` 消息不碰 `mcpServers` 编辑/保存守卫)。源在 iFlowMods `mcp-status-refactor/`(loader + apply-patch + mod.json + README 标准交付),注入已应用到本地定制 fork 与 vendor bundle(`@yuentao/iflow-cli@0.5.19-custom.10`,**尚未发布 npm**——发布后 `npm run vendor:cli` 才能默认拉到,当前 vendor 经 `--from-dir` 装载本地产物,同版本≠同内容幂点注意)。验证(2026-10-15,`test/fixtures/probe-mcp-status.mjs`):7 servers 实列表(apipost-mcp connected 8 tools 带完整 schema、firecrawl connected、exa disconnected、其余 connecting)、`IFLOW_MCP_STATUS=0` → `{available:false,reason:"disabled"}`。**改 CLI bundle 版本后必须在 iFlowMods 重新生成锚点——漂移会让 apply-patch 硬失败**。
- **multimodal-image Feature 4(image_read live 视觉模型,2026-10-16)**:harness(ACP) 模式 agent 自行调用 `image_read` 时视觉模型不用面板当前模型、而是读磁盘 `~/.iflow/settings.json` 的终端 CLI profile 模型 → 503 `model_not_found`(用户截图)。bundle 实证(0.5.19-custom.10):`Config.getMultimodalHelper()` 与 ContentGenerator ctor 两处 `new _4(...)` 构造点 pass `getMultimodalModelName()`(OpenAI-compatible 模式 undefined)进 helper 作 **value snapshot**,helper 按 Config 缓存,loader fallback 链末端落到磁盘模型——面板模型活在内存(api-config-isolation 不落盘),`set_model` 热切换后快照必 stale;`getModel(){return this.contentGeneratorConfig?.model||this.model}` 与 `setModel` 相邻(陷阱 #23 同源属性锚点)。修复:两处构造点改 pass live getter——`new _4(this.apiKey,this.baseUrl,o,r,n)`→`...o||(()=>this.config?.getModel()||""),r,n`、`new _4(e,r,n,o,s)`→`...n||(()=>this.getModel()||""),o,s`(iFlowMods `multimodal-image-refactor/apply-patch.mjs` 标准交付,锚点各唯一 1 处 + round-trip);loader 支持 function-valued `modelName`:每次 description 调用 **re-read** 并过 `isMultimodalModel` gating,string 值维持 legacy;解析序 descriptionModel > Aone built-in > iFlow built-in > **live getter(会话当前模型)** > legacy string > disk fallback,mod.json 1.0.2。源在 iFlowMods `multimodal-image-refactor/`,注入已应用到本地定制 fork 与 vendor bundle(`@yuentao/iflow-cli@0.5.19-custom.11`,**尚未发布 npm**——发布后 `npm run vendor:cli` 才能默认拉到,当前 vendor 经 `--from-dir` 装载本地产物)。验证(2026-10-16):loader 单元探针(fetch stub 捕获 `body.model`,隔离 HOME)live getter 逐次跟随模型切换 + `descriptionModel` 优先级不变;`npm run harness` 全流程 PASS。**改 CLI bundle 版本后必须在 iFlowMods 重新生成锚点——漂移会让 apply-patch 硬失败**。
- **system-prompt-refactor Mod(IFLOW_SYSTEM_MD 覆写正文，把内置模板里的 dynamic 段落按需 re-embed,2026-10-17)**:CLI 原生 `IFLOW_SYSTEM_MD` 把**整 body** 当磁盘文件(readable L162713 `n?y=N0e.readFileSync(o,"utf8")`),静吞内置模板(`Oui`/`Nui`)的 live 段落——`# Environment Information`(cwd / git remote URL / HEAD SHA / platform / OS version / today's date / **当前模型名** + knowledge cutoff)、条件 `# Git Repository`、条件 sandbox 三态(`# Sandbox`|`# macOS Seatbelt`|`# Outside of Sandbox`)、`gitStatus:` 快照 paragraph。Mod 单点 patch P0e 把 `n?y=readFileSync:d?...:y=b&&A?Nui:Oui` 改「内置模板**先恒 render** 进 y,仅 n 时 `require("./system-prompt-loader.cjs").render(fileText,y)` splice」——loader `{{iflow:Name}}` token 把 builtIn 里按 `^# ` heading slice 段落取(`##` 子头不截、`gitStatus:` 单独 paragraph rule、`Sandbox` 三态 alias、unknown token 照 verbatim 自诊断、CRLF→LF 归列);no token 即逐字节同上游,`IFLOW_SYSTEM_MD_TEMPLATE=0|false` 退回 native 覆写,loader 缺失/抛错 → raw file 回 upstream(`try/catch` 同纪律)。harness 侧:`prompts/system-prompt.md`(随 VSIX,用户不可见)把四段改 token、panel spawnEnv 注入 `IFLOW_SYSTEM_MD`(existsSync 保护,CLI 对缺失文件即抛 `missing system prompt file`)。P0e 每 `startChat` 重读 → `session/load` 恢复会话也覆写(wire `settings.system_prompt` 只在 `session/new`,CLI `loadSession` 不调 `setSystemPrompt`);Windows 兼容警告 + userMemory 照 P0e `h`/`v` suffix 后 append,不受替换。源在 iFlowMods `system-prompt-refactor/`(loader + apply-patch + mod.json + README 标准交付),注入已应用到本地定制 fork 与 vendor bundle(`@yuentao/iflow-cli@0.5.19-custom.12`,**尚未发布 npm**——发布后 `npm run vendor:cli` 才能默认拉到,当前 vendor 经 `--from-dir` 装载本地产物)。验证(2026-10-17,`npm run harness -- --probe` + `IFLOW_WRITE_SYSTEM_MD` dump):dump 里 `Working directory: J:\git\iflow-harness`/`Git remote URL`/`Git HEAD SHA`/`powered by the model named`/`gitStatus: ... Current branch:` 现且无 `{{iflow:` 残留;`IFLOW_SYSTEM_MD_TEMPLATE=0` 对照 dump 里照 token literal(上游语义不变)。**改 CLI bundle 版本后必须在 iFlowMods 重新生成锚点——漂移会让 apply-patch 硬失败**。
- **裁剪有实测背书,不是猜的**:每个被裁项(node-pty 62.6MB、devtools、jimp 图像链等,共 182.7MB → 39.3MB)都于 2026-09-11 用 `npm run harness` 对裁剪副本跑完整 ACP 流程验证过——被裁的只服务交互 TUI,ACP headless 路径不碰。**增删 PRUNE 清单前必须重跑 harness 验证**。
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

### 安全与凭据
- API key **只存 VSCode SecretStorage**,不落盘、不进普通 settings、不打日志。UI 展示用 `maskKey()`(仅末 4 位)。
- 审批默认拒绝(`outcome: "cancelled"`);审批卡/提问卡 5 分钟超时自动拒绝,避免 agent 永久阻塞。
- Webview HTML 注入 nonce CSP(`script-src 'nonce-...'`),资源引用重写为 `webview.asWebviewUri`;DOMPurify 显式 `FORBID_TAGS: ["iframe","form"]` + `FORBID_ATTR: ["style","target"]`。
- 工具 diff 回退前对「编辑器有未保存修改」「内容与 diff 不一致」两种情况弹 modal 二次确认。
- webview 提供的 data URL 附件有 8MB 上限(`MAX_IMAGE_ATTACHMENT_BYTES`),超限在落盘前拒绝;>5MB 图片(`ATTACHMENT_IMAGE_MAX_BYTES`)降级为文件附件。
- `openExternal` 仅放行 `^https?://`。
- vendor 默认规则链路**永不触碰凭据文件**(settings.json / iflow_accounts.json),见上节。
- **API 配置隔离(2026-10-07,CLI 侧 Mod 方案)**:面板的 API 配置(baseUrl/apiKey/modelName/selectedAuthType/currentApiProfile)不得泄漏进共享 `~/.iflow/settings.json` 影响终端 CLI 等其他进程。动因:CLI 的 `authenticate` 经 `settings.setValue("User",...)` 把内存 settings 整份序列化回写(settings 模块的用户文件路径 `join(homedir(),".iflow","settings.json")` **硬编码 homedir,不认 IFLOW_HOME**;`saveSettings`/混淆名 `BMi` 是唯一咽喉点,probed CLI 0.5.19)。**首版私有 IFLOW_HOME 方案已废弃**:bundle 实证上述路径硬编码后,私有 home 挡不住写回泄漏,反而把认 IFLOW_HOME 的用户级资产(commands/agents/skills/memory.md/config,全经 `Tn()` 解析)误隔离——slash 命令读不到即此症状。现行方案:iFlowMods 的 **api-config-isolation-refactor** Mod(patch 型,方法体接管 saveSettings 开头,不经 L950),仅当 `IFLOW_HARNESS` 为真且写入目标恰为用户级 settings.json 时,把面板持有字段替换为磁盘已有值原样保留(终端凭据不被抹除、面板凭据永不落盘),其余字段(apiProfiles/语言/审批模式/MCP/tokensLimit)照常持久化;`IFLOW_API_ISOLATION=0` 退回,TUI/-p 不受影响。Mod 随定制 fork `@yuentao/iflow-cli` bundle 发布(锚点字符串 `Error saving user settings file`,换版本须重新生成 code.js),vendor-cli 拉取即带;**官方原版 CLI 无 Mod,隔离失效(已知取舍)**。扩展侧配套:spawn env 保留 `IFLOW_HARNESS=1`(Mod 开关+清理脚本标记),不再注入 IFLOW_HOME、无播种/迁移;不写共享 `currentApiProfile`(active 权威 SecretStorage,`resolveActiveProfileName`/`queryLiveModels` extension-first);原 settings.json watcher 同步链路已删(API 配置权威改 SecretStorage 后语义失效)。
- **S1 已闭合(2026-09-19)**:`client.ts` 的 `resolveAgentPath` 现在做目录边界校验——允许根是 **session cwd + `options.allowedRoots`(panel 传全部 workspace 根)的并集**:相对路径按 cwd 解析、`..` 上逃到所有允许根之外、以及指向所有允许根之外的绝对路径,一律抛 `PathBoundaryError`(导出在 `src/acp/client.ts`),由 `JsonRpcPeer` 转成 JSON-RPC 错误回给 agent,不落盘。多根工作区 / 兄弟目录等合法目录外编辑仍放行(CLI 会把读写委托给 host 的 fs 回调,bundle 实证 `capabilities.readTextFile ? client.readTextFile : fallback`)。**边界必须与 CLI 的工作区上下文同源**(2026-09-19 补修):CLI 侧是 `new WorkspaceContext(targetDir, includeDirectories ?? [])`,且 `read_file`/`write_file`/`replace`/`ls`/`grep`/`glob`/`image_read` 全部先过 `isPathWithinWorkspace()` 才委托给我们的回调——所以 panel 把同一组根经 `buildAcpCommand(entry, allowedRoots)` 以 `--include-directories` 传给 CLI,否则多根工作区会出现「CLI 放行、我们拒绝」。同时 `resolveAgentPath` 对**已存在路径做 realpath 归一**(`realpathOrLexical`,对齐 CLI 的 `fullyResolvedPath`;macOS 的 `/tmp`→`/private/tmp` 这类系统软链两边必须一致),不存在的路径(新建文件)退回词法形式。**注意这只是协议层通道的护栏**:执行类工具(`run_shell_command` 等)仍能经审批后在本机真实 shell 里读写任意路径(信任模型与沙箱建议见 README「安全与信任边界」);校验与后续 I/O 非原子(TOCTOU),且 CLI 运行时的 `/directory add` 无法镜像——完整隔离只能靠操作系统级容器。

## 关键能力(1.x 迭代,细节在 CHANGELOG 只有一句话,技术要点在此)

- **Plan 模式审批卡(`_iflow/plan/exit`)**:复用审批卡形态,`{approved, reason}` 回传。1.1.2 起卡片内计划可**编辑并重新规划**(`replan`):编辑文本作为 revised plan 随 `respondPlanExit` 回传,`reason` 即修订计划;解析备注里以「重新规划:截断摘要」留痕。重新规划时**保持 Plan 模式**(agent 据此修订),批准/拒绝后 host 显式切回原模式(wire 验证:CLI 不会自行离开 plan 模式)。
- **ask_user_question 提问卡**:`_iflow/user/questions` → `QuestionCard.tsx`,单选/多选/自由文本(选项自带 description),答案按 question `header` 建 map 回传;超时按「未回答」自动继续。
- **toast 浮层替代转录系统通知**:host 通知从 transcript 块迁至 toast(`hostNotice` → `toast` 消息),支持重试倒计时(`countdownDeadline` 锚定 host 绝对截止时间消除计时漂移)、`displayOnly`(host 主导的等待渲染为不可点击 pill)、`persistent` + `dismissToast`(host 显式管理生命周期,用于自动压缩提示)。倒计时 toast 由 webview 自动关闭,persistent 只由 host 关闭。
- **会话累计 token 用量估算**:CLI 生成器层其实已捕获 usage(bundle 实证 CLI 0.5.19 custom.7:OpenAI 兼容生成器 `stream_options.include_usage` → `saveUsageMetadata` → `lastUsageMetadata`,交互模式 budget 检查已在用),但上游 ACP 层不冒泡——`PromptResponse` 只有 `stopReason`。acp-usage-report Mod(见「内置 CLI」节)已把**末次请求输入**作为 `usage.lastRequestInputTokens` 补进 PromptResponse:占用条 `contextUsed` 在有上报时为权威值(`usageAuthoritative` 标志,块数一变即过期退回估算);input/output 拆分与跨轮累计仍是 host 估算(wire 不带拆分)。估算本体:host 用 `gpt-tokenizer` 真实 BPE(o200k_base)+ CJK 启发式回退从 transcript 估算(第二档方案见 docs/feature-roadmap-2026-10.md P2-7)。P1 增量设计:每块 `tokens` 缓存 + 流式追加增量累加 + `upsertToolBlock` 仅内容变化才重算,`refreshSessionUsage` 引用稳定(数值不变不换对象);streaming 期间 `pushSnapshot` 按 500ms 节流刷新;SubAgent 卡实时加总子条目缓存。输入/输出分列,会话开始即零值显示(`↑0 ↓0`)。
- **消息编辑/重新生成/复制**:消息行内动作条,`regenerate` 由 host 重跑最近 user prompt(不新增 user 块,走 `promptWithRetry`;会话切换后丢弃结果)。1.1.2 移除编辑重发入口(遗留 editDraft),保留重新生成。
- **会话搜索与删除**:历史下拉带模糊搜索(列表 flex 列布局,仅列表滚动,搜索框与标题固定);删除需两步确认。
- **项目知识库(F3 Phase 3,2026-10-18)**:设置页「记忆」可生成 `.iflow/knowledge/index.md` + `manifest.json`(工作区扫描排除 `node_modules/.git/.iflow/.next/.venv/target` 等,上限 2000 文件;内部 prompt 生成固定章节 Markdown)。生成后写入项目记忆的托管块 `<!-- iflow-harness:knowledge:start --> … @相对路径 … <!-- end -->`,CLI 通过记忆加载器的 `@import` 展开。注入目标遵循 `contextFileName`(不硬编码 `AGENTS.md`);注入判定/取消注入会扫描**所有**项目记忆文件(primary/additional/hierarchy),避免多级记忆重复展开同一知识正文。`knowledgeJob` 上报 scanning/summarizing/writing/done/error,`KnowledgeStateUi.generating` 让关闭再打开设置仍显示生成中;索引默认注入,其他文档可逐个开关,token 成本并按注入总量提示。生成失败会刷新 memoryState,可能留下“索引存在但未注入”的可恢复半成品。**增量刷新(manifest v2)**:`manifest.json` 存 `sources:[{rel,size,mtimeMs}]` 全量扫描快照;默认「增量刷新」用 `diffKnowledgeSources` 找出 added/modified/deleted,无变化直接 done+toast 不调用模型,有变化则把旧索引+变化摘要+仅变化关键文件摘录交给模型只更新索引(不重扫全量关键文件),输出无效时回退全量。**基线安全**:v1 manifest 且 index hash 匹配才升级全量;索引存在但 manifest 缺失/v2 但 index hash 不匹配(用户手改)时增量请求直接报错,要求显式「全量重建」,绝不静默覆盖。扫描以 2001 条探测上限,`truncated` 写入 manifest/KnowledgeState,增量遇截断强制全量;`scanKnowledgeWorkspace` 以 32 并发批量 `workspace.fs.stat` 填 size/mtime 并按 rel 排序。生成/注入写入项目记忆后调用 `syncManifestSources` 更新该文件的 source 指纹,避免自身写入触发下一次增量;无变化刷新也会补回被手工删除的托管导入。增量 prompt 预算:旧索引 ≤12K 字符、关键变化摘录 ≤8K、变化列表每类 ≤60 条。
- **记忆管理(F3 Phase 1,2026-10-18)**:设置页新增「记忆」tab,读取/编辑 CLI 实际加载的全局与项目 `AGENTS.md` / `IFLOW.md`;支持内联编辑、按 `## iFlow Added Memories
` 追加/删除事实、新建项目记忆、token 成本展示与冲突检测。CLI 侧实证(`test/fixtures/probe-memory.mjs`):全局记忆目录硬编码为 `os.homedir()/.iflow`(**不认 IFLOW_HOME**),`memory.md` 当前 loader 不读取(仅作遗留文件展示、不注入),`@relative/path` 导入可用(为 Phase 3 `.iflow/knowledge` 铺路),ACP 下 `/memory add` 只返回 tool action 不执行(面板必须直接写文件)。记忆在 `session/new` / `session/load` 时加载;当前会话需重启 CLI(恢复当前会话)才生效。
- **记忆自动沉淀与快捷记忆(F3 Phase 2,2026-10-18)**:助手消息行内「记住这条」→ `MemoryQuickAdd` 弹窗(全局/项目作用域,`requestId` 匹配自己的 `memorySaved` 回包);编辑器右键「记住选中内容」(`iflow.rememberSelection`)走原生 QuickPick + InputBox。`iflow.autoMemoryCapture`(默认开启)在回合结束后用当前模型提取长期记忆候选:独立 `memoryPromptBusy` lane(不阻塞 enhance/AI 标题)、2 分钟限流、严格 JSON 解析 + 归一化去重 + 置信度 ≥0.6 + 最多 5 条 + 无项目时 project 降级 global;候选只进 `MemoryReviewDialog` 审阅,确认后才写盘。toast 的 `memory-review` action 打开审阅;`applyMemoryCandidates` 逐条写盘后刷新状态。`MemoryReviewDialog` 使用 `dismissible={false}` + 显式「全部忽略」,避免误点蒙层丢弃候选。
- **ErrorBoundary 自愈**:流式渲染期间 markdown 解析病态块导致的 React 整树卸载白屏,`ErrorBoundary`(page=main.tsx 顶层 / inline=MessageList 外层)+ `resetKey`(下一个 snapshot/blockPatch 自动重试)兜底;`aria-live` 播报与 `/` 聚焦快捷键。1.1.1 修过 liveMessage `useMemo` 位于早返回之后导致的 hooks 数量不一致。
- **MCP 编辑工具 diff 合成**:对未自带结构化 diff 的编辑类工具(`edit_block` / `fast_edit_block` / `{path, oldText, newText}` 等),双策略合成 diff——先「工具执行前磁盘快照 vs 完成后内容」(`snapshotEditDiff`,工具无关),再「参数逆推」(`synthesizeEditDiff`:按反向序替换回放,碎片缺失/次数不符即放弃)。被 64KB 输出截断与 256KB diff 上限保护;**绝不放过伪造 diff 到回退路径**(陷阱 #6 纪律)。
- **系统状态文本分类**:`isSystemStatusText`(正在压缩/压缩聊天历史失败等前缀)把压缩闲聊标成 `system` 弱化展示,不强排。
- **极光背景**:`iflow.auroraIntensity`(0-100,默认 35)调节背景光斑不透明度,随 `theme` 消息推送,监听配置变更实时生效。
- **模型权威值对齐(1.1.2)**:面板 `currentModelId` 是权威值,`startNewSession`/`restoreSession` 用 `validateModelForPush` 对 live `/models` 校验——模型已下架则回退 CLI 启动模型并警告,绝不静默用错模型;`refreshLiveModels` 失败保留下拉现有列表。
- **速率限制自动重试**:`RATE_LIMIT_RETRY_DELAYS_MS = [5s, 15s, 30s]` 递增退避(单次 5s 重试不够,平台限流窗口常超过 5s);`isRateLimitError` 匹配 429 / "rate limit" / 中文「速率限制」措辞。重试时发 toast 带倒计时。
- **上下文溢出自动压缩**:`isContextOverflowError` → 自动发 `/compress`(桥接 CLI 强制全量压缩,绕过比例门控)→ 重发原 prompt;压缩期间 persistent toast 由 host 显式 dismiss;压缩结果以 `CompressionBlock` 折叠卡呈现,不泄漏原始 JSON。
- **提示音**:Web Audio 合成(无资源文件),`playSound` 消息驱动;Host 仅按 `iflow.soundFeedback` 门控——提示音是**通用**的完成/失败信号(任何面板/焦点状态都响;曾加「观看闸门 + 与 toast 互斥」,结果观看态与离开态都听不到铃,2026-10-13 用户实测后恢复通用);OS toast 是附加的离开态提醒,可与铃同时出现;AudioContext 必须在用户手势中创建/恢复(否则 autoplay 策略下永久 suspended,提示音静默)。
- **代码上下文卡**:右键「加入 iFlow 上下文」→ `CodeContextUi` 卡片(可移除、最多一张),发送时由 Host 拼成 fenced block 前置到 prompt。
- **附件**:`pickAttachments`(OS 选择器,图片走 base64、其他文件走真实路径)+ `stageFiles`(拖拽/粘贴的非图片文件由 Host 写入会话临时目录);图片缩略图回显并可预览。
- **CLI 启动优化**:`locateNodeExecutable` 优先用 PATH 上的独立 Node(≥20)而非 Electron 的 `Code.exe`(实测 initialize 13s → 6s,并针对「GUI 启动继承陈旧 PATH」补了绝对路径 node 候选);入口与 node 并行探测;`iflow.nodePath` 可强制指定;`killTree` 清理进程树;`retireStaleOAuthCreds` 把过期 OAuth 缓存改名归档(否则 CLI 每次 authenticate 卡 ~60s 做无用的 Google 刷新);探测结果经 `LocatorPersistence` 持久化到 globalState,跨窗口免重复探测(成功结果缓存、失败永不缓存)。
- **`iflow.warmStart`**(默认开):窗口打开后台预热 CLI 进程,首次打开面板无需等待(每窗口约 100MB 内存代价)。
- **热重认证**:切换 API Profile 免重启 CLI(`_iflow` 会话替换 + 并行探测防护);CLI authenticate 会回写共享 settings.json,但 API 配置隔离(见「安全与凭据」,CLI 侧 Mod)已把面板持有字段拦在写回之外,re-stamp `currentApiProfile` 的补丁已删,active 权威是 SecretStorage 记录。
- **增量快照(P-1)**:`blockPatch` 消息只重发 transcript 尾部 + 全部非 blocks 元数据,`blockVersion` 锚定;锚不匹配 → webview 发 `ready` 全量重同步;`mutatedFrom` 记录每次 reducer 变更的最早索引,中段工具更新也走增量。
- **transcript 持久化(P2)**:`context.storageUri/transcripts/<sanitized-sessionId>.json` 每会话一文件,promise 串行链 + temp 写 + rename 原子替换;`migrateLegacyTranscripts` 一次性迁移旧数据(必须在会话过滤前执行,否则未迁移数据会被误判为不可恢复)。
- **块稳定 id(P4)**:`BlockBase.id` + `nextBlockId()` 单调计数器 + `backfillBlockIds` 回填旧数据;MessageList 用 `block.id` 作 key + `React.memo(BlockView)`,修掉 index key 导致的折叠状态错位;`reassignBlockIds` 处理恢复会话后的 id 唯一性。
- **`--stream` 参数**:`buildAcpCommand` 必须带,否则 CLI 的 ACP prompt 处理器等整轮 SSE 结束才一次性 dump,面板显示为分段而非流式。
- **状态栏**:agent 状态(连接中/就绪/生成中/等待审批/出错,含当前模型与模式),点击打开面板。
- **下拉实时刷新 + 模糊搜索**:`refreshAuth`(profile 列表,SecretStorage + CLI settings.json)与 `refreshModels`(`GET {baseUrl}/models`)在对应下拉打开时重算——外部工具会偷偷改写 settings.json;模型下拉支持模糊搜索(按 name 与 id)。
- **长会话渲染**:超长转录离屏渲染 + 后缀挂载窗口;滚动跟随用 ResizeObserver 覆盖全部内容增长路径。
- **Win12 亚克力材质**:webview 视觉系统(见陷阱 #22 的 backdrop-filter 压缩陷阱)。用户气泡/品牌头像/工具图标渐变砖块等视觉体系 1.0.4 起持续迭代。
- Windows 上 `test/attachments.test.ts` 的 broken-symlink 用例会因创建符号链接需要权限而 EPERM，属 AGENTS.md 记录的环境限制，不是回归；`npm test` 出现该失败可忽略。
- 验证流程：`npx vitest run <测试文件>` 跑定向单测，`npm run typecheck` 分别检查 host 与 webview，`npm test` 跑全量；提交前按此顺序验证并在汇报中列出结果。
- 陷阱:切换 provider 预设时,若新预设没有推荐模型,不能继承上一个网关的模型名,否则出现「新端点 + 旧模型」错配。
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

## 测试

- 框架:vitest 5,配置在 `vitest.config.ts`,`include: ["test/**/*.test.{ts,tsx}"]`,`testTimeout`/`hookTimeout` 均为 5000ms。当前 **37 个测试文件 / 676 个用例**(2026-10-18 实测;`attachments.test.ts` 的 broken-symlink 用例在非特权 Windows 上因 CreateSymbolicLink 需权限而 EPERM,属环境限制非回归)。
- `vscode` 模块通过 alias 指向 `test/vscode-stub.ts`(只提供 `l10n.t` 恒等实现)。
- 现有覆盖:`jsonrpc`(NDJSON 分帧/路由/超长帧丢弃)、`acp-client`(用 `test/mock-acp-agent.mjs` 起假 agent)、`auth`(SecretStorage 注入式假实现)、`models-query`(临时目录写假 settings.json)、`session-state`(reducer + transcript 解析 + 块 id 不变量 + SubAgent 归组 + 系统状态分类 + 压缩卡泄漏 + tool diff 合成 + 审批流 + 用量估算与 P1 token 缓存)、`store-snapshot`(节流快照 + blockPatch 锚定 + P-1 全链路保真 + toast 生命周期)、`error-boundary`(jsdom 环境,渲染抛错回退 + resetKey 自愈,`@vitest-environment jsdom`)。
- 约定:测纯逻辑,不起真实 CLI、不碰真实 SecretStorage。需要文件 I/O 时用 `mkdtempSync` + `afterAll` 清理。UI 组件(如 ErrorBoundary)用 jsdom 跑。
- wire 录制回归:旧 `test/fixtures/`(harness --record 产物)已删除且 `.gitignore` 已加 `test/fixtures/*.ndjson` / `*.json`——录制输出不再入库;wire 行为验证以代码注释里的 `Wire behavior (probed, CLI 0.5.19)` 记录为准。

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
