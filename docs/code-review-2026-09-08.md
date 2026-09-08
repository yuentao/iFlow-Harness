# iflow-harness 全面代码审查报告

> 审查日期：2026-09-08 ｜ 审查基线：工作区 HEAD `b67a6cd`（v0.1.0）
> 审查方式：逐文件精读全部源码（`src/acp/*`、`src/panel/*`、`src/extension.ts`、`shared/*`、`webview/src/**`），所有发现均引用实际代码行（行号已对照源文件逐条核实），非静态扫描臆测。
> 严重级别：**[CRITICAL]** 安全漏洞/数据丢失/崩溃 → 必须修；**[MAJOR]** 功能性 bug/显著性能退化 → 应尽快修；**[MINOR]** 降低维护成本的改进；**[NIT]** 风格建议。

## 目录

- [总览](#总览)
- [P0 安全](#p0-安全)
- [P1 性能](#p1-性能)
- [P2 边界与正确性](#p2-边界与正确性)
- [P3 鲁棒性](#p3-鲁棒性)
- [P4 可维护性与可访问性](#p4-可维护性与可访问性)
- [做对的地方](#做对的地方)
- [修复优先级建议](#修复优先级建议)

---

## 总览

架构分层纪律执行得很好：状态只在 Extension Host，webview 是投影；`shared/` reducer 纯净可测；`jsonrpc.ts` 零 VSCode 依赖。安全基本面（SecretStorage 存 key、nonce CSP、审批默认拒绝、DOMPurify 清洗 markdown）在同类扩展里属于严谨的。本次审查发现 **3 个 [CRITICAL]、8 个 [MAJOR]**，集中在三个区域：① ACP 客户端 `fs/*` 方法对 agent 传来的路径无约束（路径穿越）；② 长会话下的三个 O(n²)/全量拷贝热点（分帧缓冲、structuredClone 快照、transcript 持久化）；③ 若干竞态与回调泄漏（`chatForward` 轮询、pending 状态、流式期间的状态切换）。

---

## P0 安全

### [CRITICAL] S1 — `fs/read_text_file` / `fs/write_text_file` 无路径约束，agent 可任意读写文件系统

`src/acp/client.ts:184-197`

```ts
peer.onRequest(AcpMethods.readTextFile, async (params) => {
  const request = params as ReadTextFileRequest;
  const content = await readFile(this.resolveAgentPath(request.path), "utf8");
  return { content } satisfies ReadTextFileResponse;
});

peer.onRequest(AcpMethods.writeTextFile, async (params) => {
  const request = params as WriteTextFileRequest;
  const filePath = this.resolveAgentPath(request.path);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, request.content, "utf8");
  return {};
});
```

`resolveAgentPath`（`client.ts:166-168`）只做相对 → 绝对拼接，对 `..`、盘符、UNC 路径完全无约束。而这是 **agent 侧主动发起** 的请求：一个被提示注入（prompt injection）感染的 agent 可以通过 `fs/write_text_file` 写 `~/.bashrc`、`C:\Users\...\AppData\Roaming\npm\...`，或读出 `.env`/SSH 私钥再通过正文 exfiltrate。`writeTextFile` 还会 `mkdir -p` 父目录，等于可以在任意位置创建文件树。这是本仓库最大的攻击面。

修复建议（最小侵入）：

```ts
private resolveAgentPath(rawPath: string): string {
  const abs = path.isAbsolute(rawPath) ? rawPath : path.join(this.options.cwd, rawPath);
  const normalized = path.normalize(abs);
  // session cwd 之外一律拒绝（normalize 后做前缀比较，天然拦截 .. 穿越）
  const root = path.normalize(this.options.cwd);
  if (!normalized.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
    throw new Error(`path escapes session cwd: ${rawPath}`);
  }
  return normalized;
}
```

同时：`writeTextFile` 单文件加大小上限（如 10MB）；`~`、`/etc`、`AppData` 等敏感前缀直接拒绝；`readTextFile` 尊重协议里的 `line`/`limit` 参数（当前被忽略，见 C-附注）。

### [CRITICAL] S2 — `NdjsonParser` 无缓冲上限：失控输出可直接 OOM 扩展宿主 ✅ 已修复（2026-09-08）

`src/acp/jsonrpc.ts:81-92`（`feed` 方法）

```ts
feed(chunk: string): void {
  this.buffer += chunk;
  while ((newlineIdx = this.buffer.indexOf("\n")) >= 0) { ... }
}
```

如果 CLI 在 stdout 打印一行超长内容（模型失控输出、崩溃 dump、无换行 banner），`buffer` 无限增长且无任何上限；且每来一个 chunk 都对整个 buffer 做 `indexOf` + `slice` 拷贝，单帧超长时退化为 O(n²) 字符串拷贝。`handleData` 由 `client.ts:94` 的 `stdout.on("data")` 直接驱动，无背压。这是同时属于安全（DoS）与性能的复合问题，故列 CRITICAL。

修复建议：

```ts
private static readonly MAX_BUFFER = 8 * 1024 * 1024; // 8MB
feed(chunk: string): void {
  this.buffer += chunk;
  if (this.buffer.length > NdjsonParser.MAX_BUFFER && this.buffer.indexOf("\n") < 0) {
    this.onError?.(new Error(`ndjson frame exceeds ${NdjsonParser.MAX_BUFFER} bytes`), this.buffer.slice(0, 200));
    this.buffer = "";
    return;
  }
  ...
}
```

> **修复记录（2026-09-08）**：已在 `src/acp/jsonrpc.ts` 落地。实现与建议略有差异：`feed()` 先基于扫描起点线性切分出全部完整行（每个完整行只复制一次，消除旧实现每消费一行就把剩余缓冲整体 slice 复制的 O(n²) 行为），随后检查残余缓冲——无换行的 partial 帧超过 `MAX_BUFFER_BYTES`（8MB）时经 `onError` 报告并丢弃，保留前 200 字节样本供诊断。带换行的合法大帧仍正常解析。测试覆盖三组场景：超长帧丢弃、丢弃后恢复解析、带换行的大行不受影响（`test/jsonrpc.test.ts`，全量 75/75 通过）。

### [CRITICAL] P-1 — 每次快照 `structuredClone` 整个会话状态，流式期间 12.5 次/秒全量深拷贝

`src/panel/store.ts:163`、`src/panel/panel.ts:366`

流式输出时每 80ms 克隆一次完整 transcript（`blocks` 数组含所有历史文本、工具输出、diff 全文）。万级消息、若干大 diff 的会话里，单次克隆数 MB → 80ms 一次 ≈ 持续几十 MB/s 的克隆 + `postMessage` 结构化克隆序列化 + webview 侧解析。这是长会话卡顿的第一嫌疑。列 CRITICAL 是因为它随会话长度**线性恶化**且叠加 P-2 的全列表重渲染，会同时拖慢宿主与渲染进程。

修复建议（渐进式）：
1. 增量快照：流式期间只发「追加/修改的尾部块」，webview 自己合并（`appendTextToLast` 只改最后一块，天然适合增量）。
2. 短期低成本方案：clone 时对 `blocks` 做 COW——只有文本实际变化的块才深拷贝，其余引用共享。
3. 输出类字段（`ToolBlock.output` > 64KB）截断，点击时按 `toolCallId` 拉取。

---

## P0 安全（续）

### [MAJOR] S3 — `openImageAttachment` 从 data URL 写临时文件无大小上限

`src/panel/panel.ts:451-471`。webview 发来的 `openImage` data URL 经正则校验后直接 `writeFileSync` 到 `%TEMP%`。正则没限长度：一个被注入的巨大 data URL 会同步写盘（阻塞扩展宿主）+ 打开预览。建议 `match[2].length` 超 ~8MB base64 直接拒绝，并把 `writeFileSync` 换成 `fs/promises`。

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 落地。`openImageAttachment` 正则校验后新增 `MAX_IMAGE_ATTACHMENT_BYTES`（8MB base64 ≈ 6MB 原始图）上限，超限警告拒绝，任何磁盘 I/O 之前即拦截；`writeFileSync` 改为 `fs/promises` 的 `writeFile`（异步，不阻塞扩展宿主事件循环），调用点相应改为 `void` fire-and-forget；新增告警文案的 l10n 英文条目（`l10n/bundle.l10n.en.json`）。验证：typecheck 通过，全量测试 91/91 通过。

### [MAJOR] S4 — CSP 允许 `'unsafe-inline'` style-src

`src/panel/panel.ts:222`。Tailwind 产物 + React inline style 目前确实需要它，风险可控，但记录在案：style 注入面完全依赖 DOMPurify 默认属性表兜底。可在 DOMPurify 配置里显式 `FORBID_ATTR: ["style"]` 收紧（Markdown 渲染不需要 style 属性）。

### 安全基本面核查结论

- SecretStorage / `maskKey` / key 不进日志：核实无泄漏路径 ✅（错误消息只含 host 与验证错误文本，不含 key）
- spawn 参数全部走数组形式（`buildAcpCommand`），无 shell 注入 ✅
- `openExternal` 有 `^https?://` 白名单 ✅（`panel.ts:313-315`）
- markdown 经 DOMPurify 清洗 ✅（收紧建议见 W1）

---

## P1 性能

### [MAJOR] P2 — transcript 持久化：每条 prompt 两次全量读写 workspaceState

`src/panel/panel.ts:1415-1444`（`sendPrompt` 前后各调一次 `persistActiveTranscript`）→ `writeTranscript`（`panel.ts:1451`）读出**全部历史会话**的 transcript、`structuredClone` 当前 blocks、写回整个 map。20 个会话 × 每个几 MB 时，每条消息触发两次「读全量 + 深拷贝 + 写全量」。同时审批结论、回退等 UI 事件也各自触发全量写。

修复建议：transcript 移出 `workspaceState`，改为每会话一个 jsonl 文件放 `context.storageUri`（append-only 写当前会话）；或至少 debounce 写入（500ms 合并）+ 只写当前会话分片。另外 `TRANSCRIPTS_KEY` 的 map 只增不减（`MAX_RECENT_SESSIONS` 只限列表，不清理孤儿 transcript），workspaceState 会无界膨胀——建议 `pruneUnrestorableSessions` 时同步清理无主 transcript。

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 按首选建议落地。transcript 移出 `workspaceState`，改为 `context.storageUri/transcripts/` 下**每会话一个 JSON 文件**（sessionId 经 `[A-Za-z0-9_-]` sanitize 作文件名，防路径穿越）。`persistActiveTranscript` 在调用时刻同步 `JSON.stringify` 单会话快照（reducer 就地改 blocks，序列化必须发生在调用栈内——同时取代了每次 persist 的 `structuredClone`），经 promise 串行链排队写入（`mkdir` + temp 写 + `rename` 原子替换，防崩溃截断半截文件）；每条 prompt 的成本从「读全量 + 深拷贝 + 写全量」降为一次单会话文件写。`pruneUnrestorableSessions` 新增孤儿文件清理（按 sanitize 文件名与保留列表比对，防止含非法字符的 sessionId 误删活会话文件）并**前置一次性迁移**（`migrateLegacyTranscripts`：旧 map 逐会话迁文件后删除 `TRANSCRIPTS_KEY`，无旧数据时零成本跳过；必须在过滤前执行，否则未迁移数据会被误判为不可恢复）。CLI jsonl 定位函数改名 `cliTranscriptFilePath` 以区分。`loadPersistedTranscript` 源 1 改为单文件读（新 parse 对象独立，无需 clone）。验证：typecheck + 全量测试 91/91 + build 通过。

### [MAJOR] P3 — `chatForward` 200ms 轮询，失败路径下 interval 永不清除

`src/panel/panel.ts:239-249`

```ts
await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    if (token.isCancellationRequested) this.client?.cancel(...);
    if (token.isCancellationRequested || this.store.getState().status === "idle") { clearInterval(timer); resolve(); }
  }, 200);
});
```

问题：① `status` 卡在 `connecting`/`error`（prompt 失败后 `markError`，不会再变 `idle`）时 promise 永不 resolve → **interval 永久泄漏 + participant 挂死**；② 取消时每 200ms 重复发 `cancel` 给 CLI；③ 无总超时兜底。建议：加总超时（如 10 分钟）、`error` 也退出、cancel 用 flag 只发一次。长期改为订阅 `store.onStateChange` 而非轮询。

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 落地。① 等待退出条件扩为 `idle || error`——prompt 失败 `markError` 后 `status` 永不回 `idle`，旧实现 promise 永不 resolve、interval 永久泄漏、participant 挂死；失败时 participant 现在返回已生成的部分文本，R2 的挂死面随之闭合（`sendPrompt` 内部已 catch 并 `markError`，从不 reject，错误以 `status=error` 的形式终结等待）。② 取消时 `cancel` 经 `cancelSent` flag 只发一次（旧代码每 200ms tick 重复发），且 `sessionId` 判空后才发（旧代码 `sessionId ?? ""` 空串照发）。③ 新增 `CHAT_FORWARD_TIMEOUT_MS`（10 分钟）总超时兜底，`finish()` 用 done flag 幂等防双 resolve。保留轮询、未改 `onStateChange` 订阅（报告标注为长期项；200ms 一次小对象读取成本可忽略）。超时/取消只结束 participant 等待，不影响面板中 prompt 的生成（仅用户主动取消会向 CLI 发 cancel）。验证：typecheck + 全量测试 91/91 通过。

### [MAJOR] P4 — `MessageList` 无 memo + index key + 无虚拟化

`webview/src/components/MessageList.tsx:405-406`（`key={i}`）、`MessageList.tsx:296-334`（组件无 memo）。

每次快照（流式期间 80ms 一次）整棵列表重建 vdom：数百 block 的会话中，React 每帧 diff 全部块的树。更隐蔽的是 index key 的错位问题——`upsertToolBlock` 会就地更新中间块、`adoptUnboundSubAgent` 会改已有块的 `agentId`，此时 index key 会让 React 复用错误位置的组件实例，内部 `useState(open)` 的折叠状态会错位到别的卡上（用户展开的 SubAgent 卡可能突然收起）。配套 P-1 的 COW 修复后，给 `BlockView` 包 `React.memo`（按块内容比较）即可大幅缓解；万级 block 再上 `content-visibility: auto` 或虚拟化。

> **修复记录（2026-09-08）**：已落地。① **稳定 key**：`Block` 联合类型引入 `BlockBase`（`id?: string`，optional 兼容旧持久化数据），`shared/session-state.ts` 所有块创建点经模块级单调计数器 `nextBlockId()` 赋 id；`upsertToolBlock` 替换路径创建 patch 时不携带 id 键，spread 自然保留原 id（测试锁定该不变量）。② **回填**：导出 `backfillBlockIds`（递归 SubAgent entries），`loadPersistedTranscript` 源 1（P4 之前落盘的 JSON）恢复时回填，`parseTranscriptJsonl` 返回前统一回填——webview 拿到的块几乎全带 id，无 id 仅在 mock/异常路径回退 `idx-${i}`。③ **MessageList**：key 改为 `block.id ?? \`idx-${i}\``，修复实例复用错位；`BlockView` 包 `React.memo`——默认浅比较以块引用为锚，与 P-1 `blockPatch`「prefix 引用保留」语义天然吻合（比报告设想的按内容比较更便宜），流式期间仅补丁重发的尾部块重渲染，full snapshot（中段变更时）与旧实现持平。④ 虚拟化/`content-visibility` 未上（报告标注为万级 block 再上）。验证：typecheck + 全量测试 95/95（新增 4 个 P4 行为用例：id 唯一性、upsert/revert 保持 id、backfill 递归补齐、jsonl 恢复带 id）+ build 通过；frontend-tester 浏览器实测 mock host 全交互无回归、无 React 警告，并以 DOM 节点标记法实证主题切换强制全列表重渲染时节点复用（key 稳定 + memo 生效）。

### [MINOR] P5 — `SubAgentCard.log` 每渲染重建大字符串

`MessageList.tsx:205-219`：`block.entries.map(...).join("\n")` 无 `useMemo`，SubAgent 卡流式期间高频重渲染时线性重建。包 `useMemo([block.entries])`。

> **修复记录（2026-09-08）**：已在 `webview/src/components/MessageList.tsx` 落地。`log` 构建包 `useMemo`（依赖 `[block.entries]`）——流式期间嵌套 entries 每次变更产生新引用时才重建；引用不变的重渲染跳过 O(entries) 的字符串拼接。与 P4 的 `React.memo(BlockView)` 互补：memo 挡住无关块的重渲染，useMemo 挡住 SubAgent 卡自身重渲染时的重复计算。验证：typecheck + 全量测试 98/98 + build 通过。

### [MINOR] P6 — `searchWorkspaceFiles` 每次 @ 输入全量 `findFiles`

`src/panel/panel.ts:473-509`。`findFiles("**/*", exclude, 500)` 每次按键（120ms debounce 后）都全仓扫描，大仓库单次数秒且结果顺序不稳定。建议缓存首次结果（workspace 文件变更事件失效）。当前 500 cap + debounce 已控制伤害，故 MINOR。

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 落地。新增 `loadWorkspaceFileRels`：首次 @ 输入支付一次 `findFiles` 扫描（排除目录与 500 cap 不变），结果转为相对路径数组缓存（`fileSearchCache`），后续按键纯内存评分；并发按键共享同一 in-flight promise（`fileSearchInFlight`）不重复扫描。失效由 constructor 注册的 `FileSystemWatcher`（`**/*`，`onDidCreate`/`onDidDelete`）驱动——注：`vscode.workspace` 并无 `onDidChangeWorkspaceFiles`，文件变更事件在 `FileSystemWatcher` 上（实施时修正过一处 API 误用）。评分逻辑未动。验证：typecheck + 全量测试 98/98 通过。

### [NIT] P7 — `authMaskCache` 只在 connect/save 时刷新

`panel.ts:737`。多处写入点存在短暂不一致窗口（`deleteProfile` 后 `saved` 残留旧值）。低影响，统一改为每次现算 `loadCredentials + maskOf` 即可。

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 落地。`authMaskCache` 字段连同 4 处赋值（`saveAuthAndReconnect`/`activateProfile`/`deleteProfile`/`ensureClient` 连接成功）全部删除，`buildAuthState` 每次调用现算 `loadCredentials + maskOf`（其本身即 async，SecretStorage 读取可接受）——`saved` 不再有残留旧值的不一致窗口。验证：typecheck + 全量测试 98/98 通过。

---

## P2 边界与正确性

### [MAJOR] C1 — `openLocation` 未解析相对路径、行号未 clamp

`src/panel/panel.ts:307-312`

```ts
case "openLocation": {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.path));
  const line = Math.max(0, (msg.line ?? 1) - 1);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
```

① `msg.path` 来自 webview 的 `FileRef`（locations 里的 wire 路径，可能是会话相对路径，见 AGENTS.md 陷阱 #8），直接 `Uri.file("src/app.ts")` 会解析到盘根而打不开——需要与 `locateDiffFile` 相同的 sessionCwd 拼接逻辑。② `msg.line` 超过文件行数时 selection 行为异常，建议 `Math.min(line, doc.lineCount - 1)`。

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 落地。① 新增共享工具 `resolveAgentPathToAbsolute`（`sessionCwd` → workspace 根 → `extensionUri` 兜底，绝对路径原样返回），`openLocation` 改用它解析 `msg.path`——不再落到盘根；`locateDiffFile` 的专用多候选定位（diff.path + locations + basename 搜索 + QuickPick）未动。② 行号 `clamp` 到 `[0, doc.lineCount - 1]`。验证：typecheck + 全量测试 98/98 通过。

### [MAJOR] C2 — `setMode`/`setModel` 用 `sessionId ?? ""` 空串调用

`src/panel/panel.ts:1239, 1260`：会话未就绪时带着 `sessionId: ""` 发给 CLI，CLI 可能返回 success（乱绑定）或报错，响应里的 `currentModeId` 还会被乐观写回 store。入口判空：

```ts
if (!sessionId) { vscode.window.showWarningMessage(vscode.l10n.t("会话未就绪")); return; }
```

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 落地。`setMode`/`setModel` 入口均判空 `sessionId`，未就绪时警告（「会话未就绪」文案与 `sendPrompt` 同款，l10n 条目已存在）直接返回——空串不再发出，CLI 乱绑定→响应值被乐观写回 store 的路径闭合。验证：typecheck + 全量测试 98/98 通过。

### [MAJOR] C3 — 流式期间 `newSession` 的竞态窗口

`startNewSession`（`panel.ts:1364-1414`）在 `setInitializing(true)` 后 `await ensureClient()`，但**没有阻止 inflight 的 prompt**：webview 侧已禁用发送，但 `iflow.askSelection` 命令、`@iflow` participant（`chatForward`）绕过 webview 直接 `sendPrompt`，拿到的是 `replaceState` 之前的旧 sessionId，prompt 会打到已被放弃的旧会话。建议 `sendPrompt` 入口检查 `state.initializing` 直接拒绝。

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 落地。`sendPrompt` 入口加状态闸门：`state.initializing || state.status === "streaming"` 直接拒绝并 `log.info` 记录拒绝原因——webview 的 busy 锁管不住的命令通道（`iflow.askSelection`、`@iflow` participant）侧门闭合，C9 与此为同一道闸门。webview 正常路径不受影响（composer 在这两个状态下已禁用）。验证：typecheck + 全量测试 98/98 通过。

### [MAJOR] C4 — `markToolReverted` 把 status 强改为 "failed" 语义污染

`shared/session-state.ts:621-631`：回退成功后把工具块 status 置为 `failed`，UI 显示「失败」——但工具实际执行成功了，只是被回退。副产物：`refreshSubAgentStatus`（`session-state.ts:101-108`）会把嵌套该工具的 SubAgent 卡也聚合成 `failed`，即使 SubAgent 整体成功。建议加独立字段 `reverted?: boolean`，UI 据此显示「已回退」chip。

> **修复记录（2026-09-08）**：已按建议落地。① `ToolBlock` 新增 `reverted?: boolean`（与 `status` 正交，optional 兼容旧 transcript）；② `markToolReverted` 置 `reverted=true`，`status` 保持原值——`refreshSubAgentStatus` 的 failed 聚合不再被回退操作污染，`output` 的「[已回退]」后缀保留（旧 transcript 恢复仍可辨识）；③ `upsertToolBlock` 替换路径在 patch 带新 diff 时清 `reverted`（CLI 对同一文件再次编辑 = 新变更，旧回退标记失效）；④ webview `ToolCard` 状态区显示「已回退」muted chip（Undo2 图标，i18n 双语条目），mock host 的 revert 行为同步。测试更新锁定新语义并新增「新 diff 清标记」用例。验证：typecheck + 全量测试 99/99 + build 通过。

### [MAJOR] C5 — 连接失败路径不 dispose，泄漏 CLI 子进程

`ensureClient` 的 catch（`panel.ts:1135` 附近）只做 `this.client = null` 后 throw；`AcpClient.connect()`（`client.ts:61-110`）在 initialize 超时/失败时也不 kill 已 spawn 的 child。两者叠加：initialize 超时（120s）或握手失败后，CLI 进程**继续存活**（stdout 监听仍挂着，只是没有宿主引用），每次重试泄漏一个 node 进程。修复：`connect()` 内 try/catch，失败时 kill child 再 rethrow；或 `ensureClient` catch 里 `void client.dispose()`。

> **修复记录（2026-09-08）**：已落地双保险（两个建议都做了）。① `AcpClient.connect()` 内部 try/catch：initialize 请求失败（超时/握手错误）时置 `stopped = true` 并 fire-and-forget `dispose()`（kill 子进程）再 rethrow 原始错误；② `ensureClient` 的 catch 追加 `void client.dispose()`——覆盖 connect 成功但后握手步骤（authenticate 异常传播、restore/prune/newSession 抛错）失败的路径，此时子进程健康但无主。`dispose()` 幂等（`child.exitCode` 非空直接返回），双重调用安全。此前两条泄漏路径（initialize 120s 超时后子进程存活、握手成功后步骤失败子进程无主）均已闭合。验证：typecheck + 全量测试 99/99 + build 通过。

### [MINOR] C6 — `parseTranscriptJsonl` 的 sidechain 归组依赖行序

`shared/session-state.ts:454+`：连续 `isSidechain` 行归一个 SubAgent。若 CLI 并发跑多个 task 导致 sidechain 行交错，会被错误合并成一张卡。0.5.19 观测为顺序写入，暂无实害；记录为已知限制。

> **修复记录（2026-09-08）**：按报告建议记录为已知限制——`parseTranscriptJsonl` 的 sidechain 分支补注释（交错写入会把并发 SubAgent 合并成一张卡；重访条件：CLI 未来交错写入时引入真正的 per-agent 分组键）。行为不变。验证：typecheck + 全量测试 99/99 通过。

### [MINOR] C7 — `readActiveSelection` 相对路径剥离用字符串 replace

`src/extension.ts:61`：`abs.replace(workspaceRoot + "\\", "")` 大小写敏感，且 VSCode 在 Windows 上常返回小写盘符而 `workspaceFolders` 是用户输入大小写——两者不一致时剥离失败，fallback 为绝对路径（仅影响提示词美观）。用 `path.relative(workspaceRoot, abs)` 顺带修复。

> **修复记录（2026-09-08）**：已在 `src/extension.ts` 落地。剥离改为 `path.relative(workspaceRoot, abs).replace(/\\/g, "/")`——Windows 盘符大小写漂移不再导致剥离失败，反斜杠顺带归一为正斜杠保持 wire 展示风格。验证：typecheck + 全量测试 99/99 通过。

### [MINOR] C8 — `findFileByBasename` 的 visited 计数按 entry 而非按目录

`panel.ts:707-719`：`visited++` 在每个 entry 上自增，20000 上限在大目录会提前耗尽（结果已 capped 10，实害有限）。按目录计数或直接删掉 `depth > maxDepth` 之外的一层防御更清晰。

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 落地。预算改为按「已访问目录」计数（2000 上限）——readdir 成本的主导项是目录数而非 entry 数，宽目录下旧按 entry 计数的 20k 预算会提前耗尽；结果 cap 10 与 `maxDepth` 上限不变。验证：typecheck + 全量测试 99/99 通过。

### [MINOR] C9 — prompt 与会话切换的并发防护缺失

`sendPrompt`（`panel.ts:1415`）无 status 检查：`askSelection`/participant 路径可在 streaming 中再发一个 prompt，两个 inflight prompt 交错污染 transcript。webview 的 busy 锁管不住命令通道。入口加 `if (state.status === "streaming") return` 即可。

> **修复记录（2026-09-08）**：已随 C3 闭合——`sendPrompt` 入口的 `initializing`/`streaming` 闸门同时覆盖本条。详见 C3 修复记录。

### [MINOR] C10 — `handleWebviewMessage` 无未知类型兜底

`panel.ts:286-355`：消息按 switch 分发，无 default。类型由 TS 编译期保证，但 webview 与 host 版本错位（扩展更新后 webview 缓存旧 bundle）时会静默丢消息。加 default 分支 log 一条即可定位这类问题。

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 落地。switch 加 default 分支 `log.warn` 未知消息 type——与 webview 侧 `store.ts` 已有的 unknown-message warn 呼应，host→webview 与 webview→host 两个方向都有版本错位 tripwire。验证：typecheck + 全量测试 99/99 通过。

### 附注（正确性核实为无问题的点）

- JSON-RPC `id: 0`：`handleMessage` 用 `!== undefined && !== null` 判断，id 0 正确路由 ✅（`jsonrpc.ts:107`）
- 帧边界：CRLF、残尾、空行处理正确 ✅
- `ensureClient` 失败后 `connecting` promise reject 传播原始错误，二次调用拿到同一 reject ✅（已核实无 null 逃逸）
- `beginUserPrompt` 先于 `client.prompt()` 同步落 store，user echo 判重逻辑（`state.blocks.length === 0`）无竞态 ✅

---

## P3 鲁棒性

### [MAJOR] R1 — prompt 超时后状态不一致

`sendPrompt`（`panel.ts:1415-1444`）：prompt 30 分钟超时后 `markError`，但 CLI 可能仍在执行。此后用户再发 prompt 会与上一个 inflight prompt 并发打到同一 session，CLI 侧行为未定义。建议超时后自动发 `session/cancel` + 锁发送直到新会话。

> **修复记录（2026-09-08）**：已按建议落地。`sendPrompt` catch 的超时分支：置 `promptLocked = true`、对当前 `sessionId` 发 `session/cancel`（收割 CLI 侧僵尸 turn）、`markError`；入口 C3/C9 闸门扩为 `promptLocked || initializing || streaming`，locked 时警告「上一次请求超时，请新建会话后继续」（l10n 英文条目已补）；`startNewSession` 在 `sessionStarted` 后清 `promptLocked`——新会话干净，锁解除。验证：typecheck + 全量测试 99/99 + build 通过。
>
> **修正（2026-09-08，真机反馈）**：「锁到新会话」过于保守——30 分钟超时后用户被永久锁死在当前对话外（CLI 收到 cancel 后会话通常仍可用）。`promptLocked` 改为 cancel 后 **5 秒宽限自动解锁**（`PROMPT_LOCK_GRACE_MS`）：足够 CLI 处理取消，不再死锁；错误横幅改为「请求超时（{0}），已发送取消请求——稍后可重试，若持续无响应请新建会话」，宽限期内拒绝并提示「取消正在生效，请稍候重试」；CLI 进程退出时同步清锁（新 spawn 干净），`startNewSession` 的立即解锁保留。若 CLI 真已无响应，下一次 prompt 会在新 turn 快速失败而非挂 30 分钟。验证：typecheck + 全量测试 99/99 + build 通过。

### [MAJOR] R2 — `chatForward` 与 C5/P3 叠加的挂死面

`panel.ts:239-249`（同 P3）：除了泄漏，`chatForward` 里 `void this.sendPrompt(prompt)` 的错误被完全吞掉——prompt 抛错（如认证失败）时 participant 永远等不到 `idle`。与 P3 合并修复。

> **修复记录（2026-09-08）**：已随 P3 闭合——`chatForward` 的等待循环现在在 `status === "error"` 时退出，而 `sendPrompt` 从不 reject（内部 catch 后 `markError`），prompt 抛错时 participant 返回已生成的部分文本而非挂死。详见 P3 修复记录。

### [MINOR] R3 — stderr 洪泛无背压

`src/acp/client.ts:79-84`：`on("data")` 里对每 chunk 做 `split(/\r?\n/)`，而宿主侧 `onStderr: () => {}`（`panel.ts:1128`）为空实现——CLI verbose 崩溃时全部分割开销白付。建议 ring buffer 存最近 200 行供诊断，或 `onStderr` 为 null 时短路。

> **修复记录（2026-09-08）**：已落地两端。① `client.ts`：stderr 处理在 `onStderr` 回调未设置时直接 return，跳过每 chunk 的 `split`（主诉的「空实现白付分割」）；② `panel.ts`：宿主侧 `onStderr` 从空实现改为 200 行 ring buffer（`stderrTail`，`STDERR_TAIL_LINES` 常量），CLI 非预期退出（`onExit` 且该 client 未被替换）时把尾巴 dump 到 `log.warn`，崩溃/卡死有诊断线索。验证：typecheck + 全量测试 99/99 通过。

### [MINOR] R4 — `restoreSession` 的 probe session 无注释交代

`panel.ts:990-991`：为拿 meta 先 `newSession` 再 `loadSession`，probe 出来的会话被丢弃（CLI 侧生命周期自管，重启即清）。代码注释解释了「为什么先 new」，但没说 probe 会话的去向，补一句可避免后续维护者误以为是泄漏。

> **修复记录（2026-09-08）**：已在 `src/panel/panel.ts` 落地。probe `newSession` 的注释补一句去向说明——probe 会话被有意丢弃（只用其 meta/modes），CLI 侧生命周期自管（ACP 会话不落盘、随 CLI 进程消亡），非泄漏。验证：typecheck + 全量测试 99/99 通过。

### [MINOR] R5 — `onUnparseableLine` 静默丢弃 stdout 噪声

`src/acp/jsonrpc.ts`（`onUnparseableLine`）：设计合理（banner 不该回 parse error），但 wireTap 收不到这些行——`--record` 的 harness 日志会缺失 CLI stdout 噪声的踪迹，排查「CLI 卡住」时少一半信息。建议 debug 构建下把原始行也 log 一份。

> **修复记录（2026-09-08）**：已在 `src/acp/jsonrpc.ts` + `src/acp/client.ts` 落地。`JsonRpcPeer` 构造函数新增第三可选参数 `onUnparseableLineOverride`（宿主可观察未解析行，默认行为不变），`client.ts` 把声明已久但从未接线的 `callbacks.onUnparseableStdout` 传入；`panel.ts` 侧将未解析 stdout 行（banner/噪声）接到 `log.debug`——VSCode LogOutputChannel 默认 Info 级不显示，调到 Debug 即可看，「CLI 卡住」排查时原始行不再缺失。验证：typecheck + 全量测试 99/99 通过。

### [MINOR] R6 — `dispose` 不等 client 完全退出

`panel.ts:147-154`：`void this.client?.dispose()` 未 await，`deactivate` 可能在 kill/SIGKILL 完成前结束。VSCode 会在宿主退出时收割子进程，实害低；若要严格，dispose 改 async 并在 deactivate 中 await。

> **修复记录（2026-09-08）**：已按建议落地。`ChatPanel.dispose` 改 async（`await client.dispose()`，kill + SIGKILL 兜底至多 3s，try/catch best-effort）；panel 提升为模块级引用，`deactivate` 改 `async function` 并显式 `await panel?.dispose()`——VSCode 会等 deactivate 返回的 Promise，宿主退出前子进程真正收割。subscriptions 的自动 dispose 与显式 dispose 的 double-call 由 `disposed` flag 幂等吸收。验证：typecheck + 全量测试 99/99 + build 通过。

### [NIT] R7 — `errorMessage()` 丢弃 `data` 字段

`src/acp/jsonrpc.ts`（`errorMessage`）：JSON-RPC error 的 `data`（CLI 常放详细堆栈）被丢，错误横幅信息量打折。可拼接 `data` 字符串（限长 500）。

> **修复记录（2026-09-08）**：已在 `src/acp/jsonrpc.ts` 落地。`errorMessage` 对带 `data` 的 plain-object rejection（JSON-RPC error 形态）拼接 `" · " + data`（String 或 JSON.stringify，截断至 500 字符）；`data` 与 `message` 内容相同、序列化为空或循环结构时跳过。Error 实例与字符串路径不变。验证：typecheck + 全量测试 99/99 通过。

---

## P4 可维护性与可访问性

### [MINOR] W1 — DOMPurify 的 `ADD_ATTR: ["target"]` 无必要

`webview/src/components/Markdown.tsx:13-18`：链接点击被 onClick 拦截走 `openExternal`，`target` 属性从未生效，白增攻击面；顺带显式 `FORBID_TAGS: ["iframe", "form"]`（DOMPurify 默认已禁，显式化防上游默认变更）。

> **修复记录（2026-09-08）**：已在 `webview/src/components/Markdown.tsx` 落地。`ADD_ATTR: ["target"]` 移除，改为模块级常量 `SANITIZE_CONFIG`：`FORBID_TAGS: ["iframe", "form"]` + `FORBID_ATTR: ["style", "target"]`——`target` 从未生效（点击被拦截走 openExternal），`style` 属性对 markdown 渲染非必需，style 注入面不再完全依赖 DOMPurify 默认属性表，且显式禁用可抵御上游默认变更。验证：typecheck + 全量测试 99/99 + build 通过。

### [MINOR] W2 — `t()` 每次调用 `replaceAll`

`webview/src/i18n.ts:96-101`：每个 chip 每次渲染都做字符串替换。量小（NIT 级），在 Chip/StatusChip 层包 `useMemo` 即可，仅记录。

> **修复记录（2026-09-08）**：已落地两处 memo（较建议更进一步）。`StatusChip` 包 `useMemo([status])`——本地化 chip 文本仅 status 变化时重建；`SubAgentCard` 的 `done` 计数包 `useMemo([block.entries])`——`progress` 与 statusChip 的 `t()` 随 entries 变更才重算。其余 chip 处于 P4 `React.memo(BlockView)` 的保护下（引用不变即不渲染），无需逐个包。验证：typecheck + 全量测试 99/99 + build 通过。

### [MINOR] W3 — AuthCard 的 inline ref 每次渲染触发 focus

`webview/src/components/AuthCard.tsx:71-72`：`tabIndex={-1}` + `ref={(el) => el?.focus()}`，inline ref callback 每次渲染先 null 后 el 调用，`focus()` 反复触发。改 `useRef` + `useEffect` 一次性聚焦到第一个 input（当前聚焦 backdrop，Tab 序从文档头开始，键盘体验差）。

### [MINOR] W4 — `ApprovalCard` 无焦点管理

`ApprovalCard.tsx`：`role="alertdialog"` 已设 ✅，但出现时焦点仍在 Composer，键盘用户需大量 Tab 才到审批按钮。建议出现时把焦点移到第一个 allow 按钮，Escape 绑定「取消」。

### [NIT] W5 — Composer 的 eslint-disable

`Composer.tsx:65`：`send` 来自 zustand selector 引用稳定，disable 是对的——改用 `useChat.getState().send` 可消除抑制并自证稳定性。

### [NIT] W6 — `modeDisplay` 与 i18n 字典双处维护

`Composer.tsx:25-40` 加新 mode id 需改两处。可移到 `i18n.ts` 旁集中。

### [NIT] W7 — l10n 双轨

`src/` 用 `vscode.l10n.t`（bundle.l10n.en.json），`webview/` 自带字典（`i18n.ts`），双语维护成本 ×2。长期可共享 json。架构债务，非本次必改。

### 可访问性快查

- 主要交互按钮 `aria-label`/`title` 已覆盖 ✅（App.tsx 新会话/主题/配置）
- `Dropdown`：Escape 关闭 ✅，但无 `role="menu"`/`aria-expanded`（MINOR）
- 图片附件 `alt` 已提供 ✅；`prefers-reduced-motion` 已处理 ✅（styles.css 尾部 `animation: none !important`）
- 拖拽上传无键盘替代路径（桌面场景可接受）

---

## 做对的地方

1. **分帧器设计与测试**：`NdjsonParser` 接受任意 chunk 边界、`\r\n` 兼容、空行跳过、banner 静默——配合 `test/jsonrpc.test.ts`，是同类实现的标准做法（超长帧上限除外，见 S2）。
2. **审批安全默认**：默认拒绝、5 分钟超时自动拒绝、dispose/profile 切换时 `cancelAllApprovals`——多条路径闭合。
3. **`errorMessage()` 的细节**：处理了 JSON-RPC 拒绝是 plain object 不是 Error 的真实陷阱，注释写明了观察来源。
4. **Windows 陷阱规避**：`process.execPath` 直跑 entry.js、`windowsHide: true`、cli-locator 的 NUL 字节/256KB 上限防二进制扫描卡死。
5. **wire 行为注释纪律**：「验证来源 + 版本 + 实测方式」的注释习惯执行得很一致，直接降低后续维护者误判率。
6. **DiffView 的工程取舍**：LCS 带 4M 格护栏（`lcsRows` 的 `n*m > 4_000_000` 短路）、git 式 ±3 行折叠——比引 diff 库省 bundle，护栏兜住病态输入。

---

## 修复优先级建议

**立即修（安全护栏，均为小改动）**

1. S1：`resolveAgentPath` 加 session cwd 前缀校验（`client.ts:166`）
2. S2：`NdjsonParser` 加 8MB 缓冲上限（`jsonrpc.ts:81`）
3. C2：`setMode`/`setModel` 判空 sessionId（`panel.ts:1239/1260`）
4. C1：`openLocation` 相对路径拼 sessionCwd + 行号 clamp（`panel.ts:307`）
5. C5：连接失败路径 dispose 子进程（`client.ts` connect / `panel.ts:1135`）

**下个迭代（性能 + 竞态，涉及协议联动需一起设计）**

6. P-1：快照增量下发（先做 blocks COW，再演进为尾部增量）
7. P2：transcript 移出 workspaceState + 孤儿清理
8. P3：`chatForward` 加超时/error 退出、cancel 单次化
9. C3/C9：`sendPrompt` 拒绝 initializing/streaming 期间的调用
10. R1：prompt 超时后自动 cancel + 锁发送
11. P4：Block 稳定 key（加 id 字段，为虚拟化铺路）

**择机（质量债）**

12. C4：`reverted` 独立字段替代 status="failed"
13. P5/P6：SubAgentCard memo、findFiles 缓存
14. W1/W3/W4：DOMPurify 收紧、AuthCard 焦点、审批卡焦点管理
15. R3：stderr ring buffer

---

*审查范围说明：`test/`、`scripts/harness.mjs` 只做架构层面浏览未逐行审查；`dist/`、`webview/dist` 为构建产物未审。行号基于 2026-09-08 工作区状态，后续提交可能使行号漂移，定位时以符号名为准。*