# MCP 服务器连接状态查看功能 — 实施方案

> 规划日期:2026-09-19 · 状态:待实施 · 不含具体代码

## 一、背景与目标

用户希望在面板中查看 MCP 服务器的连接状态。经全面调研后,本方案交付范围定为
**「MCP 配置健康视图」**:展示已配置的 MCP 服务器列表(名称 / 类型 / 命令或 URL /
配置时间),并明确标注「仅配置视图,连接状态以 CLI 为准」。

真实连接探活不纳入本期范围(理由见「可行性分析」)。

## 二、可行性分析

### 2.1 现状盘点(三层架构)

**协议层(`src/acp/protocol.ts`)**
- `McpServer` / `McpServerStdio` / `McpServerEnvVar`(`L102-115`):仅用于
  **client → agent** 方向,即 `session/new` 的**请求参数**(`NewSessionRequest.mcpServers`,
  `L119`)。
- 唯一返回方向的字段:`NewSessionMeta.availableMcpServers?: unknown[]`(`L182`)。
  **全仓库无任何代码消费它,形态从未验证。**
- `AcpMethods`(`L11-29`)无 `mcp/list` / `list_tools` 之类查询方法。
- `SessionUpdate` 联合(`L249-262`)八种事件中**没有 MCP 连接/断开事件**。
- 已知 iFlow 专有扩展点(`_iflow/user/questions`、`_iflow/plan/exit`、
  `session/set_think`)**均与 MCP 状态无关**。

**宿主层(`src/panel/panel.ts`)**
- 三处调用全部硬编码 `mcpServers: []`(`L2017` / `L2019` / `L2819`)。
  扩展从不配置 MCP,CLI 自己从 `~/.iflow/settings.json` 读取。
- 已有一条 MCP 相关能力链路:工具 diff 合成(MCP 工具结果被拍平为纯文本,
  已实测验证,见 `shared/session-state.ts:621-625`)。

**Webview 层**
- **零 MCP 展示**。`ToolCard`(`webview/src/components/MessageList.tsx:154-213`)
  只渲染 `title || toolName || toolKind`,无服务器名;SubAgent 卡片无 server 标识。
- 仅 3 处与 MCP 相关的 i18n 文案(splash 提到 MCP server)。

**本机实证(2026-09-19)**
- `~/.iflow/settings.json` 存在 `mcpServers` 键,**含 6+ 个真实配置**
  (chrome-devtools-offical、Framelink-MCP-for-Figma、brightdata-mcp、
  apipost-mcp(sse)、firecrawl 等),含 npx 拉取型与网络型。
- CLI 控制台日志(`~/.iflow/log/*.log`)**不记录 MCP 连接事件**。

### 2.2 数据源矩阵(决策依据)

| # | 数据源 | 含连接状态? | 可靠性 | 落地成本 | 结论 |
|---|---|---|---|---|---|
| A | `_meta.availableMcpServers`(`session/new` 响应) | 未知 | **未验证** | 低(若有效) | 待验证,不作依赖 |
| B | `~/.iflow/settings.json` 的 `mcpServers` | 仅配置存在性 | **高(已实测)** | 低 | ★ **采用(保底)** |
| C | ACP 事件流 / 查询方法 | 无 | — | — | ✗ 不可用 |
| D | CLI stderr / 进程存活扫描 | 启发式(存活≠连接成功) | 中低 | 中 | ✗ 不做 |
| E | vendor loader patch 上报真实状态 | 是 | 高 | 高 | ✗ 本期不做 |

### 2.3 关键约束

1. **CLI 是 MCP 的 client 端**,连接状态属 CLI 内部状态,ACP 未暴露协议面 ——
   这是核心瓶颈,也是本期不承诺「连接探活」的根本原因。
2. **loader monkey-patch 只存在于定制 fork**(`vendor/` 内置 + `--from-dir` 装载);
   用户本机官方 `@iflow-ai` CLI 无 loader,方案 E 只覆盖 vendor 场景。
3. **CLI 启动时同步阻塞连接每个 MCP 服务器**(实测:6+ 个配置时 ACP 握手卡住
   80s+ 无响应)。任何「启动时探活」都会加剧面板卡顿,且与正在使用的 CLI
   存在竞态 —— 本期所有方案均不 spawn / 不轮询 / 不触碰进程。
4. **`newSession` 代传 `mcpServers` 的合并语义未验证**,动它可能破坏用户现有
   MCP 连接(同陷阱 #5 教训)。

### 2.4 架构可行性:高

- `SessionState` 加**顶层字段**,自动搭 `blockPatch.tail` 增量快车
  (`SessionSnapshotTail = Omit<SessionState, "blocks">`,`shared/messages.ts:345`),
  **无需改消息协议**;若挂在 blocks 里则要处理锚定 / backfill / React key 全链路。
- UI 有现成模板:`AuthCard.tsx:148-196` 的「状态点 + 名称 + 徽章」列表条目。
- 配置变更监听可复用现有 settings.json watcher(热重认证链路已监听外部改写)。
- 测试模式成熟:`models-query.test.ts`(临时目录假 settings.json)、
  `session-state.test.ts`(reducer)、`store-snapshot.test.ts`(增量快照保真)。

## 三、实施方案

### 3.1 架构落点

1. **数据读取** — `src/acp/models-query.ts` 新增 `readMcpServersConfiguration()`:
   复用 `settingsFilePath()` + `readCliSettings()` 同款模式,读 `mcpServers` 键,
   返回 `{ name, type, command | url, env?, _lastModified? }[]`。
   **零 VSCode 依赖,可单测。**

2. **状态挂载** — `shared/messages.ts` 的 `SessionState` 加顶层字段
   `mcpServers: McpServerUiState[]`(默认空数组,`initialSessionState()` 零值化);
   `shared/session-state.ts` 新增 `setMcpServers` 纯 reducer(mirror `setMeta` 模式),
   返回变更索引供 store 的 `mutatedFrom` 增量路径使用,并同步 `noteMutationIndex` 接线。

3. **刷新时机** — 复用现有 settings.json watcher,在面板打开与 `refreshAuth`
   触发时**顺带**刷新 MCP 配置(同 `refreshModels` 下拉打开时刷新模式)。
   **不做轮询**,避免与 CLI 竞态。

4. **UI** — 新增 `webview/src/components/McpServerCard.tsx`,条目形态完全复刻
   `AuthCard.tsx:148-196`:圆点状态(OK = 配置有效 / 警告 = 缺失字段)+ 名称 +
   类型徽章(stdio / http / sse)+ 命令或 URL + `_lastModified`。
   **明确标注「仅配置视图,连接状态以 CLI 为准」**。
   i18n 在 `webview/src/i18n.ts` 的 `en` 字典加 3-4 键(中文为源语言)。

5. **测试** — `test/models-query.test.ts` 加 `readMcpServersConfiguration` 用例;
   `test/session-state.test.ts` 加 `setMcpServers` reducer 用例;
   `test/store-snapshot.test.ts` 断言 MCP 字段随 `blockPatch.tail` 传播;
   `test/mock-acp-agent.mjs` 可在 `session/new` 响应加假 `_meta.availableMcpServers`
   供 client 透传测试。

### 3.2 明确不做(避免误导)

- ❌ **连接探活 / 状态轮询** — 无协议面,且 CLI 同步阻塞连接会加剧面板卡顿。
- ❌ **`newSession` 代传 `mcpServers`** — 合并语义未验证,可能破坏现有连接。
- ❌ **vendor loader patch 上报真实状态** — 依赖定制 CLI 装载路径,只覆盖 vendor 场景。
- ❌ **后台进程扫描** — 违背「不碰进程」原则,且存活 ≠ 连接成功。

### 3.3 实施顺序

1. `models-query.ts` 加 `readMcpServersConfiguration`(纯函数 + 单测)。
2. `shared/messages.ts` + `shared/session-state.ts` 加字段与 reducer(顶层字段,不动 blocks)。
3. `panel.ts` 接 settings watcher 刷新 + 消息路由。
4. webview `McpServerCard` + i18n + `createMockHost` demo 数据。
5. `store-snapshot.test.ts` + `session-state.test.ts` 补测试。
6. `npm run typecheck && npm test`;UI 变更后用 frontend-tester 验证。

### 3.4 规模评估

数据读取 ~40 行、reducer + 状态 ~30 行、UI ~120 行、测试 ~80 行。
典型小功能:不涉及进程操作、不改协议、不动 vendor。

## 四、后续可选增强(待 wire 验证后立项)

- **Phase 2 — 真实连接状态**:若实测证实 `_meta.availableMcpServers` 有效,
  扩展在 `newSession` 带上 settings.json 的 `mcpServers`(替换硬编码 `[]`),
  消费响应 / 事件,展示「连接中 / 已连接 / 失败 / 未知」+ 工具数。
  前置验证:合并语义(合并 vs 覆盖)、是否阻塞、stderr 是否有 MCP 连接日志。
- **Phase 3 — loader patch 上报**:在 vendor 定制 CLI 的 loader 里拦截 CLI 内部
  MCP 连接事件,写本地状态文件或经 `_iflow/*` 扩展事件上报。
  代价:依赖定制 CLI 装载路径;vendor 裁剪清单变更必须重跑 harness(陷阱 #21)。

### Wire 实测清单(Phase 2 前置)

1. `npm run harness -- --probe` 确认基线 ACP 流程正常(不耗 token)。
2. 临时简化 `~/.iflow/settings.json` 的 `mcpServers`(只留 1 个)对比启动耗时,
   定位握手卡住根因。
3. `npm run harness -- --record` + 手动检查 `session/new` 响应完整 `_meta`,
   确认 `availableMcpServers` 是否存在及结构;抓 stderr 看 MCP 连接日志。
4. 结论以 `Wire behavior (probed, CLI x.y.z)` 注释落回 `protocol.ts`(仓库约定)。

> **注意**:wire 实测须在与正在使用的 CLI 无竞态的环境下进行(独立目录 / 独立
> IFLOW_HOME),且脚本必须 `dispose()` 清理子进程,watchdog 退出前先 dispose。