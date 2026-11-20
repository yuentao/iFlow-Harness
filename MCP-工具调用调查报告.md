# Super Agent 子会话 MCP 工具调用调查报告

## 1. 问题现象

Super Agent 子会话中配置了两个用于网页搜索的 MCP 服务器，但模型未调用 MCP 工具，改用 `curl` 进行搜索。

## 2. 逐项验证结果

### 重点 1：子会话创建时是否传递了 MCP 服务器配置？`buildAcpCommand` 是否为子会话传入 `--allowed-mcp-server-names`？

**结论：是，代码层面已传递，但 panel.ts 有一处过时注释。**

- `src/panel/panel.ts:8562` (`createSuperClient`)：调用 `buildAcpCommand(entry, includeDirectories, { mcpServerNames: broker?.names() ?? [] })`。当 broker 有服务器时，每个服务器名会以 `--allowed-mcp-server-names <name>` 形式传给子会话 CLI 进程。
- `src/acp/cli-locator.ts` (`buildAcpCommand`)：`mcpServerNames` 非空时，为每个名推入 `--allowed-mcp-server-names`；为空时推入哨兵 `__iflow_harness_no_mcp__`（断根）。
- `src/panel/super-agent.ts` `prepareInner`（约 L2470）：`const childMcpServers = this.deps.childMcpServers?.() ?? [];`，取自 `this.mcpBroker?.sessionServers() ?? []`，作为 `mcpServers: childMcpServers` 传给 `client.newSession()`。

**注意**：`src/panel/panel.ts:559-563` 的注释称「only the main session's spawn gets `--allowed-mcp-server-names`, child spawns do not」，这与实际代码（L8562）不符，属于**过时文档**。

### 重点 2：子会话的 `allowedRoots` 和 `--include-directories` 是否只包含 worktree 根？

**结论：是的，但这影响的是文件工具访问边界，与 MCP 工具无关，不是根因。**

- `src/panel/super-agent.ts` `prepareInner`：`allowedRoots = [isolation.path]`，再加附件目录。`includeDirectories` 对 worktree 子会话为 `[]`（仅附件目录），对 repo 档（合并子会话）为 `[...allowedRoots]`。
- `allowedRoots` / `--include-directories` 只约束 CLI 的 `isPathWithinWorkspace` 与宿主 `resolveAgentPath`（文件读写工具），MCP 服务器通过 HTTP 连接 broker 的 loopback 端点，不受此限制。
- 因此此项**不是** MCP 工具不可见的原因。

### 重点 3：MCP 工具在子会话 CLI 进程中是否被正确注册？`discoverAllTools()` 是否能发现配置的 MCP 服务器？

**结论：不确定——取决于 vendored CLI 内部实现，本 worktree 中 `vendor/iflow-cli` 为空（gitignored），无法直接核验。**

现有证据：

- `src/acp/mcp-broker.ts:1191` (`sessionServers()`)：返回 `type: "http"`，URL 指向 `http://127.0.0.1:PORT/mcp/<name>`，携带 token header。即子会话的 `session/new` 请求会携带 broker 的 HTTP MCP 服务器配置。
- `src/acp/protocol.ts:128-136`：`McpServerRemote` 类型支持 `type: "http" | "sse" | "streamable-http"`，CLI 的 ACP zod schema 确实接受 HTTP 远程 MCP 服务器。
- `src/acp/mcp-broker.ts` (`handleHttp` / `handleMessage`)：broker 的 HTTP 端点正确实现了 MCP-over-HTTP 网关（`initialize` 返回缓存的 initResult、`tools/list`/`tools/call` 转发上游、`ping` 本地响应、GET 返回 405 供 streamable-HTTP 探测）。
- `src/acp/client.ts:209` (`newSession`)：仅把 `NewSessionRequest`（含 `mcpServers`）透传给 CLI，不做额外处理。

**关键不确定性**：AGENTS.md「mcp-session-share Mod」章节记录：「CLI 0.5.19 的每个 ACP 会话(session/new 与 session/load 都算)各自 `newSessionConfig()` 新建 Config,`discoverAllMcpTools()` 为每个配置的 MCP server spawn 一整条 stdio 进程链」。这表明 CLI 的 MCP 发现以 stdio 进程启动为主。**未明确 CLI 是否把 `session/new` 请求里的 `mcpServers` 并入该会话的 MCP 服务器表，还是只读 `settings.json`（`~/.iflow/settings.json` 的 `mcpServers`）**。如果 CLI 只读配置文件而忽略请求字段，则：
  1. `--allowed-mcp-server-names` 过滤到 broker 服务器名（如 `bing-search`、`ddg-search`）；
  2. 这些名不存在于 `settings.json` 的 `mcpServers` 中；
  3. 解析后的 `mcpServers` 映射为空；
  4. `discoverAllMcpTools()` 无可发现服务器；
  5. 子会话工具列表中**没有任何 MCP 工具**。

此项是**最可能的根因**，但需 CLI bundle 实证确认。

### 重点 4：`mcp-session-share` Mod（进程级 MCP 连接池）在子会话场景下是否正常工作？claim 机制是否导致子会话无法复用 MCP 客户端？

**结论：大概率不是根因，但存在不确定性。**

- `mcp-session-share` Mod 的池 (`globalThis.__iflowMcpShare`) 是**每 CLI 进程一份**。每个子会话是独立 CLI 进程，各自持有独立池，不会跨进程争抢。
- 该 Mod 核心是 stdio 进程池（「spawn 一整条 stdio 进程链」）。子会话通过 HTTP 连接 broker，不存在 stdio 子进程可池化，claim 机制大概率不适用（或直接走原发现路径）。
- 唯一风险：若 Mod 的 `discoverAllMcpTools()` 包装层对 HTTP 服务器处理不当（例如期望 stdio spawn 却对 HTTP 静默失败），MCP 工具可能不注册。此点同样需 CLI bundle 实证。

### 重点 5：模型改用 `curl` 而非 MCP 工具，是模型自身偏好，还是 MCP 工具在工具列表中不可见/不可调用？

**结论：最可能是 MCP 工具未注册/不可见（技术问题），模型偏好为次要因素。**

- 若 MCP 工具已注册并对模型可见，模型理论上可选择调用。模型一律回退到 `curl`，强烈暗示工具列表中**没有 MCP 搜索工具**。
- 次要因素：`prompts/super-agent-task.md` 的子会话任务提示词**未提及 MCP 工具或网页搜索**，即使 MCP 工具已注册，模型也未必知道应优先使用它们而非 `curl`。

### 重点 6：子会话是否继承了主会话的「进程级 MCP 作用域隔离」（哨兵断根）？

**结论：否。子会话不继承主会话的哨兵断根，而是获得 broker 服务器名。**

- 主会话：`buildAcpCommand(..., { disableMcpServers: true })` → 推入哨兵 `__iflow_harness_no_mcp__` → 丢弃全部 MCP 服务器（`src/acp/cli-locator.ts`）。
- 子会话：`buildAcpCommand(..., { mcpServerNames: broker?.names() ?? [] })` → 推入 broker 服务器名 → 仅允许 broker 服务器（`src/panel/panel.ts:8562`）。
- 因此子会话**没有**继承主会话的断根；它被显式授权访问 broker 的 MCP 服务器。

## 3. 根因定位

**最可能的根因（代码层面）：**

CLI 侧对子会话 `session/new` 请求中 `mcpServers` 字段的处理不明确。若 CLI 的 MCP 服务器表仅来源于 `settings.json`（用户配置的 stdio 服务器），而忽略 `session/new` 请求透传的 broker HTTP 服务器，则：

1. `--allowed-mcp-server-names` 将 `mcpServers` 映射过滤到 broker 服务器名；
2. 这些名在 `settings.json` 的 `mcpServers` 中不存在；
3. 过滤后映射为空；
4. `discoverAllMcpTools()` 无服务器可发现；
5. 子会话工具列表中无 MCP 工具；
6. 模型只能使用 `curl`。

**辅助因素：**

- `mcp-session-share` Mod 为 stdio 进程池设计，对 HTTP broker 连接的适配未知；
- `prompts/super-agent-task.md` 未在子会话提示词中说明可用的 MCP 搜索工具，弱化了模型调用 MCP 的意愿。

## 4. 修复建议（代码层面）

1. **核实 CLI 对 `session/new` `mcpServers` 的处理**（最高优先级）：检查 vendored CLI bundle 中 `session/new` 处理器是否把请求的 `mcpServers` 并入该会话的 MCP 服务器表。若仅读 `settings.json`，需在 CLI 侧或宿主侧修复，使 broker 的 HTTP 服务器能进入子会话的 MCP 发现表。

2. **验证 `--allowed-mcp-server-names` 与请求服务器的交互**：若 CLI 会把请求 `mcpServers` 与配置服务器合并，确认过滤器能正确放行 broker 服务器名；若不能，需调整过滤逻辑，使请求透传的服务器不被配置文件的映射限制。

3. **在子会话任务提示词中明确 MCP 工具**：更新 `prompts/super-agent-task.md`，在 `isolation` / `submission` 段落之外增补一段，说明子会话可用的 MCP 搜索工具及其名称，鼓励模型优先调用 MCP 而非 `curl`。

4. **考虑让子会话直接使用 stdio MCP 服务器（绕过 broker）**：若 CLI 的 HTTP MCP 传输不可靠，可将子会话的 MCP 配置改为直接启动 stdio 服务器（传入实际的 `command`/`args`，而非仅服务器名），由每个子会话独立 spawn。这需要放宽子会话的 MCP 作用域限制。

5. **加强子会话 MCP 发现诊断**：在 `waitForChildMcpReady` 或 `prepareInner` 中增加日志，记录 `mcpStatus` 返回的 `discoveryState` 及每个服务器的连接状态，便于后续问题排查。

## 5. 可复现步骤

1. 在 `~/.iflow/settings.json` 中配置两个网页搜索 MCP 服务器（例如 Bing、DuckDuckGo）。
2. 打开 iFlow Harness 面板，确保 MCP 代理（`McpBroker`）启动成功（查看面板日志 `MCP broker listening on ...`）。
3. 发起一条需要网页搜索的任务，通过 Super Agent 派发子会话。
4. 观察模型行为：是否调用了 MCP 搜索工具，还是改用 `curl`。
5. 检查面板日志中子会话的 MCP 发现状态（`mcpStatus` / `discoveryState`）及 broker 服务器连接状态。

## 6. 引用的文件与行号

| 文件 | 行号 | 说明 |
| --- | --- | --- |
| `src/panel/panel.ts` | 8562 | `createSuperClient` 向 `buildAcpCommand` 传 `mcpServerNames` |
| `src/panel/panel.ts` | 8371 | `childMcpServers: () => this.mcpBroker?.sessionServers() ?? []` |
| `src/panel/panel.ts` | 559-563 | 过时注释：声称子会话不传 `--allowed-mcp-server-names` |
| `src/acp/cli-locator.ts` | — | `buildAcpCommand`、`MCP_SERVER_ALLOWLIST_FLAG`、`MCP_SERVER_ALLOWLIST_SENTINEL` |
| `src/panel/super-agent.ts` | `prepareInner` (约 L2470) | `mcpServers: childMcpServers` 传给 `session/new`；`waitForChildMcpReady` |
| `src/acp/mcp-broker.ts` | 1191 | `sessionServers()` 返回 `type: "http"` 的 broker 端点配置 |
| `src/acp/mcp-broker.ts` | `handleHttp` / `handleMessage` | broker HTTP 端点的 MCP-over-HTTP 网关实现 |
| `src/acp/protocol.ts` | 128-136 | `McpServerRemote` 类型支持 `type: "http"` |
| `src/acp/client.ts` | 209 | `newSession` 仅透传 `NewSessionRequest`（含 `mcpServers`） |
| `prompts/super-agent-task.md` | — | 子会话任务提示词模板（未提及 MCP 工具） |
