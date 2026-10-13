# iFlow Harness 功能差距分析与实施方案（2026-10）

> 基于 1.2.9 现状与 2026-10 竞品调研（Cline、Roo Code、GitHub Copilot Chat/Agent、Claude Code 官方扩展、Cursor/Devin Desktop、Continue，及 vscode-acp / Exo 等直接同类 ACP 客户端）。
> 本文档只含设计与实施方案，不含具体代码。工作量标记为相对规模（S / M / L），不做时间估算。

## 0. 总体判断

面板层（审批卡 / 提问卡 / Plan 卡 / toast / 增量快照 / 子代理卡）已是第一梯队水准，差异化在定制 loader 的模型兼容增强。差距集中在三类：

1. **工作区级回退**（竞品标配，我们只有单文件 Revert）
2. **并行与排队**（生成中不能输入、不能多任务）
3. **上下文输入广度**（@mention 只有文件；无诊断/终端/git/URL 源）

架构约束：执行体固定为 vendored CLI（定制 fork），凡依赖 CLI 侧能力的功能（P2 多数项）都要走 iFlowMods 机制或 CLI 立项，不是纯面板工作量。本文档对每项标注依赖类型：**纯面板**（host/webview 可独立完成）/ **协议扩展**（需新增 host↔webview 消息，不动 CLI）/ **CLI 依赖**（需 Mod 或 CLI 改造，实施前必须先实证）。
## 1. P0 详细方案

### P0-1 轮级 Checkpoint 与工作区回退（L，纯面板）

**目标**：每轮用户 prompt 前自动快照工作区，任意历史轮次可一键回滚「文件 / 对话 / 两者」。对标 Cline 影子 Git、Copilot 每轮 checkpoint。

**选型**：影子 Git 仓库为主，文件快照为降级路径。

- 影子 Git：在扩展 `storageUri/checkpoints/<sessionId>/git` 初始化独立 GIT_DIR，`core.worktree` 指向 session cwd，通过 `GIT_DIR` / `-C` 环境变量操作，绝不触碰用户自己的 `.git`（非 git 工作区同样可用）。决定因素：`run_shell_command` 改动的文件只有全仓快照能覆盖，per-file 快照覆盖不了这个核心场景。
- 降级路径：影子 Git 初始化/提交失败（超时、权限、跨盘软链）时，该轮标记 `partial`，仅对带 diff 的 ToolBlock 记录 before 文本（现有 revertTool 数据已具备），UI 明确标注「本轮快照不完整」。

**锚点与数据结构**：checkpoint 以「轮」为单位，锚定该轮 user block 的稳定 id（复用 `BlockBase.id`，P4 机制）。每会话一个索引文件（与 transcripts 同目录、同原子写纪律：temp 写 + rename），字段：轮序号、userBlockId、影子 commit sha、时间、partial 标志、label（首条消息前 30 字）。

**协议改动**（`shared/messages.ts`）：
- `SessionState` 新增 `checkpoints: CheckpointUi[]`——非 blocks 元数据，天然走现有 blockPatch 的 tail 通道，不动锚定逻辑。
- `WebviewToHost` 新增 `restoreCheckpoint`（checkpoint 锚点 + 恢复模式三选一）。

**恢复语义三档**（对标 Cline）：
1. 仅恢复文件：影子 `git checkout` 该 sha 的文件树；恢复前对「编辑器未保存修改」「磁盘与快照不一致」二次确认（完全复用现有 revert 的 modal 纪律）。
2. 仅截断对话：复用 `deleteUserMessage` 截断链（含 CLI chatHistory 截断与 1.2.7 的 findCliHistoryCut 序数对齐算法），不碰文件。
3. 文件+对话：先恢复文件再截断。

**UI**：MessageList 每个 user 气泡动作条加「回滚到此轮」→ InlineConfirm 两步确认（1.2.7 组件）→ 弹三档选择；会话下拉底部可加「本轮变更」入口展示该轮影子 diff 摘要。

**性能与边界**：提交带超时（10s），超限降级 partial；`git add -A` 前探测文件数，超阈值（默认 5 万）关闭并提示设置项；影子仓库默认 `add -A` 包含未跟踪文件、尊重 `.gitignore`，两者交互要在验收用例里固定行为；Windows 全程异步 execFile 直跑 git（陷阱 #18）+ `windowsHide`；会话删除时同步清理影子仓库目录。**已实现大文件过滤**：`iflow.checkpointMaxFileMB` 默认 300，捕获前逐文件测量并通过 Git exclude pathspec 排除超限文件；0 表示关闭限制，被跳过文件不参与文件回滚。

**设置项**：`iflow.checkpoints`（默认开）、`iflow.checkpointMaxFiles`、`iflow.checkpointMaxFileMB`。

**测试**：临时目录起影子仓库（commit→改文件→checkout 回滚）单测，不起 CLI；三档恢复的 reducer 截断路径复用 deleteUserMessage 测试基座；partial 降级路径。

### P0-2 逐块（per-hunk）保留 / 回退（M，协议扩展）

**目标**：带 diff 的工具卡上逐 hunk 决定保留或回退，替代整文件 Revert 的误伤。对标 Claude Code per-change accept/reject（同为编辑后语义）。

**核心正确性设计**：我们持有 `ToolDiffUi` 的完整 `oldText` / `newText`，hunk 化与重放是 100% 确定性的——在 shared 层新增纯函数：由 oldText/newText 计算 unified hunks（每 hunk 带 old/new 行区间与内容），「应用选择」= 从 oldText 出发仅重放保留的 hunk 得到目标文本。不做任何「按磁盘当前内容打补丁」的模糊匹配，规避 MCP diff 合成纪律（绝不放过伪造 diff 到回退路径）。

**交互流程**：DiffView 每个 hunk 头部出现「保留 / 回退」开关，默认全保留，回退 hunk 以删除线弱化；底部提交条「应用（保留 N · 回退 M）」→ 发 `applyHunkSelection`（toolCallId + 保留 hunk 索引位图）；Host 重放得到目标文本 → 与磁盘现值比对（磁盘已被后续改动则拒绝并提示走 checkpoint）→ 经 `vscode.workspace.fs` 写回（陷阱 #9）→ ToolBlock 标记 `partiallyReverted` 并记录保留比例。

**协议与状态**：`ToolBlock` 新增可选 `hunkDecisions`（提交后的决策快照，供重渲染还原 UI）；新消息 `applyHunkSelection`。Block 联合扩展后确认 `backfillBlockIds` 递归路径与 `upsertToolBlock`「内容变化才重算 token」判断不受影响（陷阱 #17）。

**边界**：newText 为 null（删除类）、oldText 为 null（新建文件）退化为整文件操作；hunk 数超上限（200）只给整体操作；MCP 合成 diff（snapshotEditDiff / synthesizeEditDiff 产物）同样可 hunk 化，但合成来源需带「合成」徽标，提交时二次确认更严格。

**测试**：hunk 化 / 重放纯函数属性测试——任意 oldText/newText/保留集合，重放结果与「直接取 newText 中被保留段」一致；含中文、CRLF、无尾换行用例。

### P0-3 消息排队与打断发送（Steer）（M，协议扩展）

**目标**：生成中可继续输入；消息进入 host 队列，当前轮结束后自动依序发送；支持「打断并发送」。对标 Roo 消息队列、Copilot 排队 + Steer。

**队列归属**：队列真值在 host（状态只存在于 Extension Host 的架构纪律），`SessionState` 新增 `queue: QueuedPromptUi[]`（id、文本摘要、附件名列表、入队时间），走 tail 元数据通道。

**交互**：Composer 在 streaming 时不再禁用发送——Enter = 入队；输入框上方渲染队列条（每条支持编辑、删除、上移/下移、「立即发送」）。「立即发送」= 发 `session/cancel` → 等当前轮落到 idle/cancelled → 立刻发该条（ACP 单会话 prompt 串行，不做并发 prompt）。队列上限 10 条，超限 toast。

**Host 接线关键点**：
- 消费点在现有 prompt promise resolve 之后（`sendPrompt`，src/panel/panel.ts:3572 链路尾部），复用 `promptWithRetry` 整条重试链（速率限制退避、溢出压缩对队列消息同样生效）。
- 陷阱 #13 的并发闸门保持：`initializing` / `streaming` 闸门语义不变，队列只是把「拒绝发送」变成「延迟发送」。
- 会话生命周期清空点清单：newSession、loadSession、restartCli、profile 切换、面板 dispose——集中一个 `clearQueue()` 调用点，避免 1.2.3 修过的「手工枚举漂移」同类问题。
- 当前轮以 error 结束时**暂停**队列并 warning toast（防止每条队列消息都撞同一个错误），提供「继续 / 清空」。
- 队列消息与 deleteUserMessage 截断的交互：首版简化为截断即清空队列。

**测试**：store 层队列 reducer（入队/重排/删除/消费）纯函数测试；「error 暂停、idle 消费、切会话清空」状态机测试（复用 store-snapshot 基座）。

### P0-4 @mention 扩展（folder / problems / git / url / terminal）（M，协议扩展）

**目标**：在 @文件之外补上下文源，数据源全部在 Extension Host，零 CLI 依赖。

**统一语法**：Composer 弹层二级选择——`@` 默认文件；`@/` 文件夹；`@problems`、`@git`、`@url:` 前缀触发。选中后不内联展开（textarea 渲染不了），生成**上下文卡**。

**注入形态泛化**：现有 `CodeContextUi` 单卡机制泛化为 `contexts: ContextRefUi[]`（kind、label、content、可移除），`sendPrompt` 消息里 `codeContext` 字段替换为 `contexts` 数组；Host 发送时按现有纪律拼成带标题的 fenced 段落前置到 prompt（`toAgentPromptText` 扩展）。输入框上方多卡横排，类型图标区分（lucide-react）。

**各源实现与限制**：
- `@folder`：复用 searchFiles 通道，query 带尾斜杠语义，结果聚合为该文件夹直接子项清单（路径列表，不读内容），上限 200 项。
- `@problems`：`vscode.languages.getDiagnostics` 全工作区聚合，按文件分组、severity 排序、总字符上限截断；无诊断时弹层显示「当前无诊断」。
- `@git`：异步 execFile 跑 `git status --porcelain` + `git diff`（cwd = session cwd，超时 5s，输出上限 32KB，非 git 目录时禁用该项）——遵守陷阱 #18，绝不同步执行。
- `@url:`：host 抓取转文本，必须用 `node:http(s)` 直连绕开被 VSCode patch 的全局 fetch（陷阱 #2），HTML 粗提取（去 script/style），上限 64KB，仅放行 http/https（对齐 openExternal 白名单纪律）。
- `@terminal`：**诚实标注为受限项**——VSCode 扩展宿主无法读取集成终端 scrollback。首版方案：终端选区右键「加入 iFlow 上下文」（读 `terminal.selection`，无公开 API 时降级为命令面板让用户先复制）。

**测试**：contexts 拼装纯函数（拼接顺序、上限截断、附件注释行与 normalizeUserPromptText 兼容——新拼法不能破坏 1.2.7 删除匹配的序数对齐）；git/url 源用本地 fixture（临时 git 仓库、本地 http server）。

### P0-5 OS 级通知（S，纯面板）

**触发点**（均要求面板不可见，host 侧以 webview panel 的 `visible` 状态判定，不用 document.hidden）：
1. 审批卡 / 提问卡 / Plan 审批到达（文案含剩余秒数，与卡内倒计时同源）。
2. 执行类工具运行超过 30s 后到达终态。
3. 整轮完成且窗口失焦。

**实现**：`vscode.window.showInformationMessage` + 「打开面板」按钮；同类事件 5s 去重节流；已接入审批/提问/Plan、长工具完成和整轮完成触发点。与现有 `playSound` 门控逻辑合并到同一个「用户是否在看着」判定函数：仅当 panel visible 且窗口 focused 时视为正在观看，避免用户切走窗口后声音和 OS 通知同时被错误吞掉。

**设置项**：`iflow.osNotifications`（枚举：`off` / `approvals`（默认）/ `all`）。

**测试**：门控纯函数（可见性 × 设置 × 节流窗口）单测即可，通知 API 本身不测。

### P0-6 上下文占用可视化与压缩预警（M，协议扩展）

**目标**：输入框旁常驻「占用条」：当前上下文 token / 模型窗口上限，hover 展开分类 breakdown；临近上限预警并可一键压缩。

**窗口上限来源**（CLI 冻结不报）：host 内置常见模型 contextWindow 映射表（随扩展发版维护，放 shared 层便于单测）；`iflow.contextWindowOverrides` 设置项支持 `模型名=数值` 覆写；未知模型回退保守默认值并在 UI 标注「估算」。

**占用计算**：完全复用现有压缩感知估算器——最后一个已完成 CompressionBlock 的 `newTokenCount` 折叠其前所有块 + 其后块逐块累加（`tokens` 缓存，P1 机制），零新增估算逻辑。breakdown 按块 kind 分类求和（user / assistant / tool / thought），引用稳定纪律对齐 `refreshSessionUsage`（数值不变不换对象，避免流式期间无谓重渲染）。

**协议**：`SessionUsageUi` 扩展 `contextWindow`、`contextUsed`、`estimated` 三字段。

**预警**：占用 ≥90% 时发 persistent toast（host 管生命周期，复用 dismissToast 机制）「上下文接近上限，建议压缩」带「立即压缩」动作（走现有 /compress 桥接链）；≥100% 由现有溢出自动压缩兜底不变。

**测试**：占用计算纯函数（含多轮压缩折叠、pending 压缩卡不折叠、override 命中）；阈值状态机（进入/退出预警区只发一次 toast）。

### P0-7 会话导出与 AI 标题（M，纯面板）

**导出**：
- 入口：会话下拉条目菜单 + 命令面板。格式两种——Markdown（host 生成：会话元信息、逐块序列化——user/assistant 原文、thought 折叠引用、工具块标题+状态+输出摘要、diff 折叠为 fenced diff 块、压缩卡为分隔线注释）与 JSON（transcript 文件原样副本）。
- 落盘：`showSaveDialog` + `workspace.fs` 写；图片附件导出到同名 assets 子目录并相对引用。导出内容需过防御性脱敏过滤（transcript 本就不含凭据，但导出器仍加一道 apiKey 正则过滤）。

**AI 标题**：
- 触发：会话首次轮完成且 label 仍是首条消息截断形态时，队列空闲窗口内发一次内部轻量 prompt（固定模板，要求 6–10 字概括当前语言）。
- 关键约束：内部 prompt 不进转录、不进队列、不参与 regenerate；结果写回 `SessionSummaryUi.label` 并持久化；每会话仅一次；失败静默保留原 label。
- 设置项：`iflow.autoTitle`（默认开）。

**测试**：Markdown 导出器纯函数（全块类型覆盖、截断、空会话）；标题状态机（只触发一次、失败不重试风暴）。

## 2. P1 详细方案

### P1-1 审批策略细化：host 预审规则表（L，纯面板）

**目标**：不动 CLI 四档模式（default/smart/yolo/plan）的前提下，host 侧对 `session/request_permission` 做规则预审，实现 Cline 式细粒度自动审批（9 项独立开关的等价能力）。

**规则模型**（存 globalState，项目级 `.iflow/approval.json` 可覆写）：
- 匹配维度：toolKind（read/edit/execute/fetch/其他）× 路径 glob（相对 session cwd，语义对齐 S1 的允许根）× 命令首词（safe/ask/deny 三列表，execute 类专用）× MCP server 名与工具名。
- 动作：自动允许 / 自动拒绝 / 弹卡（默认）。

**决策顺序**：deny 命中 → 直接 reject（不弹卡，转录留 system 痕迹）→ allow 命中 → 自动放行 → 未命中 → 现有审批卡（默认拒绝纪律不变，超时逻辑不变）。

**「始终允许」语义升级**：点击后弹规则命名微交互（预填本次推导出的规则），写入规则表；下次同类请求静默放行且转录标注「按策略自动允许」。

**UI**：设置页新增「审批策略」管理卡（规则列表 CRUD + 启用开关 + 命中统计），复用 McpCard 卡片形态与 InlineConfirm 删除确认。

**边界与安全纪律**：首版自动允许规则**不得覆盖删除类与 rm / git push 类命令**（内置硬 deny 前缀表，不可被规则表解除）；PowerShell / `&&` 链式命令按分段取首词逐一判定，任一段 deny 即 deny；规则匹配纯函数放 shared 层。

**测试**：规则匹配纯函数全覆盖（维度组合、glob、链式命令、硬 deny 不可越）；预审接线用现有 acp-client 测试基座（mock agent 发 permission 请求）。
### P1-2 子代理卡增强：树状图 / 逐卡用量 / 单独停止（M，协议扩展 + CLI 依赖）

**目标**：对标 Claude Code Agent Map（子 agent 树 + 状态/耗时/token + 可点开只读转录 + 可停单个）。当前 SubAgentBlock 已有归组与步骤折叠，缺三项。

- **逐卡用量与耗时**：SubAgent entries 已含工具块，host 侧按卡聚合 `tokens` 缓存求和（复用 P1 token 机制），耗时取首 entry 到终态的时间戳差。纯 host 计算，无协议依赖。
- **树状图**：webview 渲染层，把 SubAgentBlock.entries 里嵌套的 subagent 块递归缩进渲染（ACP 的 task 可嵌套 task），加竖向连接线。纯 webview。
- **单独停止某个子代理**：**受 CLI 约束**——ACP 只有会话级 `session/cancel`，没有 per-tool 取消。方案：面板发 Stop 时降级为「整轮 cancel + toast 说明」，并在按钮 tooltip 诚实标注；真正的 per-agent 取消需 CLI 侧提供 `_iflow/agent/cancel` 扩展点（列入 P2 CLI 待办）。实施前先在 bundle 实证 CLI 是否有隐藏的 agent 取消通道。

**测试**：用量聚合纯函数（嵌套卡不重复计入父卡）；树渲染用 mock 快照。

### P1-3 Focus view（S，纯面板）

MessageList 顶层开关（快捷键 `Ctrl+Alt+F` 或工具栏图标），开启后折叠全部 tool / thought / system 块，只渲染 user 与 assistant text。纯 zustand 局部渲染过滤，零协议改动、零 host 改动。注意与「回到最新」滚动跟随、离屏渲染窗口的交互（过滤后块数变化要重算挂载窗口）。

### P1-4 面板内 wire 日志导出（S，纯面板）

JsonRpcPeer 加环形缓冲（最近 2000 帧 NDJSON，`src/acp/jsonrpc.ts` 已有分帧点，加一个可选 sink）。命令面板「导出 ACP 日志」→ `showSaveDialog` 写文件；**落盘前正则脱敏** Authorization / apiKey / bearer 值（对齐凭据纪律）。复用 harness `--record` 的 NDJSON 格式，便于离线分析。对标 Zed `dev: open acp logs`、JetBrains Get ACP Logs。

### P1-5 Enhance Prompt（提示词增强，S，纯面板）

对标 Roo 魔杖按钮。Composer 加「增强」按钮 → host 用当前模型发一次内部 prompt（固定 ENHANCE 模板，可带最近 N 条对话作上下文）→ 结果回填输入框（可撤销）。约束：内部 prompt 不进转录/队列（同 P0-7 标题的隔离纪律）；增强模板可配置；失败保留原文。

### P1-6 成本估算展示（S，协议扩展）

当前只有 token 数。新增可配置单价表（`iflow.costTable`，`模型名=输入价,输出价` 每百万 token，随扩展发版维护常见模型默认值），host 在 `SessionUsageUi` 增 `estimatedCost`（复用 P1 缓存 token 求和 × 单价）。UI 在用量 chip 追加金额，未知模型标注「无单价」。BYOK 用户强需求。

### P1-7 Mermaid 渲染（S，纯面板）

Markdown 组件对 ` ```mermaid ` 代码块懒加载渲染（webview 新增 mermaid 依赖，动态 import 不增大首屏）。**CSP 陷阱**：mermaid 注入的 SVG 含内联 style，需在现有 nonce CSP + DOMPurify（当前 `FORBID_ATTR: ["style"]`）下验证——大概率要为 mermaid 输出开一条受限白名单，或改用 mermaid 的 `securityLevel: 'strict'` 渲染后单独净化。失败回退现有 highlight 纯文本。

### P1-8 会话管理增强：归档 / 分组 / 置顶 / Fork（M，纯面板）

- **归档 / 置顶**：`SessionSummaryUi` 加 `pinned` / `archived` 标志，持久化到会话索引；历史下拉分「活跃 / 已归档」两段，归档不进搜索默认结果。
- **Fork（从检查点分叉）**：依赖 P0-1 checkpoint——在某轮分叉 = 新建会话 + 截断到该轮 + 影子仓库 checkout 该 sha 到独立 worktree。与 checkpoint 同批交付。
- Fork 的会话隔离：新 sessionId、独立 transcripts 文件、独立 checkpoint 目录。

### P1-9 编辑旧消息重发（回归，M，依赖 P0-1）

1.1.2 移除了编辑重发入口。回归时与 checkpoint 联动做成 Cline 语义：编辑历史 user 消息 → 「回滚该轮及其后所有文件变更并重发」（复用 P0-1 恢复 + deleteUserMessage 截断 + 重新 sendPrompt）。无 checkpoint 时降级为纯截断重发并提示。放 P1 尾位，等 P0-1 稳定。
## 3. P2 详细方案（多数依赖 CLI / 架构，立项前先实证）

> P2 项在动工前都必须先在定制 fork bundle（iFlow-Mods repo）里实证 CLI 侧能力边界，并把结论按仓库惯例写进代码注释（`Wire behavior (probed, CLI 0.5.19)` 风格）。

### P2-1 并行多会话 / 多任务看板（L，架构级）

**竞品基准**：Cursor Agents Window、Claude Code 子 agent 树 + 后台 shell、Roo worktrees、Cline Kanban。

**现状约束**：每窗口单 CLI 子进程、单 active session；`ensureClient` 是窗口级单例。

**可行路径（渐进）**：
1. **多窗口并行**（最廉价）：现在每窗口已有独立 CLI 进程，缺的是任务视角聚合。补一个「会话总览」quick pick / webview 首页，列出各窗口活跃会话状态（经 extension 间 `Command` 广播或 globalState 心跳）。
2. **单 CLI 多 session**：CLI 的 ACP 方法表支持多 session（session/new 可多次），但 panel 的 store 是单会话假设。改造 = SessionState 按 sessionId 分片 + 面板 tab 化。这是架构级重构（store/panel/快照协议全部要带 sessionId），单独立项。
3. **worktree 隔离**：每任务 `git worktree add` 独立目录 + 独立 session cwd，配合 P0-1 checkpoint。与路径边界（S1 允许根）、`--include-directories` 传递联动。

**依赖**：无 CLI 改动，纯扩展架构；但成本最高，建议等 P0/P1 交付后评估。

### P2-2 浏览器自动化（L，CLI 依赖）

**竞品基准**：Cline browser 工具、Cursor Browser + Design Mode、Devin 内嵌浏览器共享上下文。

**现实**：browser 是 **agent 工具**，不是面板 UI 能补的能力。CLI 侧要么内置 browser 工具，要么经 MCP（Playwright MCP / Chrome DevTools MCP）接入——后者其实今天就能用（McpCard 配 stdio server），缺的是：
- 面板侧的「浏览器上下文卡」：VSCode 内置 Simple Browser webview + 选区元素/截图注入 prompt（对标 Copilot 集成浏览器）。这部分是纯面板，可先于 CLI 做。
- browser 工具的审批分级（独立 auto-approve 开关）→ 依赖 P1-1 规则表的 toolKind 维度。

**建议拆分**：先做面板 Simple Browser 上下文注入（S），agent 侧走 Playwright MCP（配置文档），真正的内置 browser 工具列 CLI 待办。

### P2-3 Codebase 语义索引（L，CLI 依赖 + 重资产）

**竞品基准**：Roo（Tree-sitter + embedding + Qdrant）、Copilot **#codebase**、Cursor 本地向量索引。注意趋势：Continue 已把 @Codebase 语义索引**弃用**，转向「agent 内置搜索工具 + rules + MCP」；CLI 本身已有 grep/glob/read 的 agentic search。

**判断**：语义索引是重资产（embedding provider、向量库、增量索引、分支感知），且行业正在退潮。**不建议自建**。低成本替代组合：
1. `@repository map`（对标 Continue）：host 侧用 tree-sitter 或简单正则生成仓库符号地图（文件→导出符号摘要），作为上下文卡注入。S 规模，覆盖大部分「让模型认识仓库结构」的需求。
2. 推荐用户接 code-index / grep MCP 服务器（文档 + McpCard 手工配置，预设模板随 P2-4 一并移除）。

### P2-4 MCP 目录 / Registry（M，纯面板）

**竞品基准**：Cline MCP Marketplace、Roo Marketplace、Zed ACP Registry。

**方案**：McpCard 增加「浏览目录」标签页——内置一份策展 JSON 目录（随扩展发版，含 name/描述/安装模板 stdio 或 npx/所需 env 参数向导），一键填入现有编辑表单（仍走 saveMcpServers 原子写 + 热重启提示）。**不做**自动 clone/build（Cline 的 GitHub repo 自动接线有供应链安全风险，与仓库安全纪律冲突）。目录来源建议先人工维护 20 个常用 server。

**状态（2026-10-12）**：已按本方案实现（webview 侧「浏览目录」标签页 + 参数向导 + 策展目录），评估后判定价值不足——用户本就能直接编辑 JSON 配 MCP server，策展目录维护成本高、条目易过时，收益不抵成本，**已移除**。McpCard 保留纯 JSON 编辑管理（1.2.5 形态）。

### P2-5 Rules / 项目指令文件（M，CLI 依赖）

**竞品基准**：`.cursor/rules`、`.clinerules/`、AGENTS.md 全家桶。

**现实**：CLI 0.5.19 已有 `~/.iflow/` 规则与 memory.md 机制（AGENTS.md 记忆条目提到 commands/agents/skills/memory.md/config 经 `Tn()` 解析）。缺口是**项目级**：`.iflow/rules/*.md`、AGENTS.md 自动加载。两种做法：
1. CLI Mod（api-config-isolation 同机制）注入项目规则加载点——需 iFlowMods 立项。
2. **面板代打**（无 CLI 改动）：host 启动会话时读取工作区 AGENTS.md / `.iflow/rules/`，拼进首条 prompt 的系统前缀。缺点：每轮都占 token、非真系统消息。作为过渡可接受，标注为权宜。

### P2-6 语音输入 / TTS（S，纯面板）

输入框麦克风按钮走 VSCode 宿主侧无原生 API——webview 内用 `navigator.mediaDevices.getUserMedia` + 外部 STT（复用用户配置的 OpenAI 兼容端点 `/audio/transcriptions`，若不支持则隐藏入口）。TTS 同理 `/audio/speech`，回复朗读按钮触发。全部 gated 在设置项后，端点不支持即 UI 隐藏。

### P2-7 CLI 侧待办清单（移交 iFlow-Mods / fork 维护者）

汇总以上需要 CLI 能力的项，供 Mod 立项排期：
1. `_iflow/agent/cancel` per-agent 取消（P1-2）。
2. usage 上报（P0-6 占用 / P1-6 成本升级为权威值）。**前提更正（bundle 实证，CLI 0.5.19 custom.7）**："CLI 冻结不报 token"不准确——OpenAI 兼容生成器层已捕获真实 usage：请求带 `stream_options:{include_usage:!0}`，SSE 帧经 `saveUsageMetadata` 写入 `lastUsageMetadata`（prompt/completion/total_tokens），交互模式的 budget 检查与 `recordAssistantResponse` 已在消费；缺的只是 ACP 会话层 `prompt()` 遍历响应时不读它、返回 `{stopReason}` 把它丢弃（dispatcher 只对**入参** zod parse、返回值透传，无需动 schema——动态实证）。分两档交付：
   - **占用权威化（✅ 已实施 2026-10-12，acp-usage-report Mod）**：`PromptResponse.usage.lastRequestInputTokens` = 末次请求 `promptTokenCount`（= 轮末模型实际携带上下文，与 P0-6 `contextUsed` 口径吻合）。动态实证两个关键事实：`usageMetadata` 只挂在流的**末块**上（中间块没有），且 ACP 会话读不到 generator 的 `lastUsageMetadata`——块级捕获是唯一可行路径。扩展侧覆盖层带 `usageAuthoritative` 标志与 `atBlockCount` 过期锚（新块/压缩卡/删除消息即退回估算）。验证：`test/fixtures/probe-usage-report.mjs`（默认上报 37404 tokens；`IFLOW_USAGE_REPORT=0` 退回上游逐字节一致）。
   - **累计/成本权威化（未实施）**：一次 turn 工具循环多次请求、每次 `promptTokenCount` 都含完整历史，末帧单值覆盖不了 Σ 口径——需 CLI 带 turn 内累计或逐请求 usage 数组；且 `saveUsageMetadata` 目前把 `cache_read/cache_creation` 合并进 prompt_tokens 后丢弃细分，cache 读单价远低于未缓存，权威值直乘会高估成本，需保留 cached 细分。
   - **降级纪律**：`include_usage` 的 usage 回传依赖网关末帧输出（BYOK 第三方代理常吞），权威值非恒可得——面板估算器不可删，无权威值时回退估算并以 `estimated` 标志区分。
3. 项目级 rules / AGENTS.md 加载中枢（P2-5）。
4. 内置 browser 工具或官方 Playwright MCP 预设（P2-2）。
5. `session/list` / `session/close` 方法（当前恢复靠读 `~/.iflow/acp/sessions/`，probe 会话无法关闭导致 MCP 舰队泄漏——mcp-session-share Mod 已缓解，根治需协议支持）。
## 4. 实施顺序与依赖

| 批次 | 内容 | 理由 |
| --- | --- | --- |
| M1 | P0-5 通知、P0-6 占用条、P1-3 Focus、P1-4 wire 日志、P1-5 Enhance、P1-6 成本、P0-7 导出 | 零/低协议风险，纯增量，先交付可感知价值 |
| M2 | P0-3 排队、P0-4 mention 扩展、P1-7 Mermaid | 都动 Composer / sendPrompt 链路，互相有交互（队列消息带 contexts），一起做 |
| M3 | P0-1 checkpoint | 独立子系统中最大件，恢复链路依赖 deleteUserMessage 现状先稳定 |
| M4 | P0-2 hunk、P1-1 审批策略、P1-8 归档/分组/Fork、P1-9 编辑重发 | hunk 依赖 diff 数据已稳；Fork/编辑重发依赖 checkpoint；审批策略需规则表新组件 |
| M5 | P1-2 子代理增强、~~P2-4 MCP 目录~~（已实现后判定鸡肋，移除） | 中等价值，等前面链路稳定 |
| M6 | P2 其余项 | 每项先出 CLI bundle 实证结论再立项；建议顺序 P2-1(2) > P2-5(2) > P2-2(面板部分) > P2-3(repository map) |

明确不做 / 挂起：自建向量索引（行业退潮，Continue 已弃用）、MCP 自动 clone/build（供应链风险）、并发 prompt（ACP 单会话串行假设）。

## 5. 全局清单

**新增设置项**（同步 `package.nls.json` + `package.nls.zh-cn.json`，遵守陷阱 #14「声明必须实现」对账纪律）：
`iflow.checkpoints`、`iflow.checkpointMaxFiles`、`iflow.osNotifications`、`iflow.contextWindowOverrides`、`iflow.autoTitle`、`iflow.costTable`

**消息协议改动集中点**（`shared/messages.ts`）：
- `SessionState` 尾部新增：`checkpoints`、`queue`、`SessionUsageUi` 扩展（contextWindow / contextUsed / estimated / estimatedCost）、`SessionSummaryUi` 扩展（pinned / archived）——全部走既有 blockPatch tail 通道，不动 P-1 增量快照锚定。
- 新 `WebviewToHost` 消息：`restoreCheckpoint`、`applyHunkSelection`、`enqueuePrompt` / `queueAction`、`contexts` 泛化（替换 codeContext）、`exportSession`、`enhancePrompt`。

**每功能验收基线**：`npm run typecheck`（host + webview 双侧）+ vitest 新增用例 + `npm run harness` 冒烟（碰 sendPrompt / loadSession 链路的批次必跑）；P0-1 / P0-2 额外手工验收清单：编辑器未保存修改、磁盘外部改动、并发工具写同一文件、非 git 工作区。

**l10n**：所有新文案中文源 + `l10n/bundle.l10n.en.json` + `webview/src/i18n.ts` 三处同步。

**版本**：按批次合入时 CHANGELOG 与 package.json 版本号同步 bump（发布自检纪律见 AGENTS.md）。

## 6. 竞品功能对照速查（2026-10）

| 维度 | iflow-harness 1.2.9 | 竞品标杆 | 本方案覆盖 |
| --- | --- | --- | --- |
| 回退 | 单文件 Revert | Cline 影子 Git 三档恢复 / Copilot 每轮 checkpoint | P0-1、P0-2 |
| 生成中输入 | 硬禁用 | Roo 队列 / Copilot Steer | P0-3 |
| @上下文 | @文件 + 选区卡 | @folder/@problems/@terminal/@git/@URL | P0-4 |
| 审批粒度 | CLI 4 档 | Cline 9 开关 + 模型命令分级 | P1-1 |
| 上下文可视化 | token 估算 | Copilot 占用条 + breakdown | P0-6、P1-6 |
| 会话管理 | 搜索/删除 | Claude Code 归档/AI 标题/Fork | P0-7、P1-8 |
| 子代理 | 归组卡+折叠 | Claude Code Agent Map | P1-2 |
| 通知 | 提示音 | OS 通知（待审批/长命令） | P0-5 |
| 浏览器 | 无 | Cline/Cursor 内置 | P2-2 |
| 并行任务 | 单会话 | Cursor Agents Window | P2-1 |
| 语义索引 | 无（agentic search） | Roo/Copilot | P2-3（建议 repository map 替代） |
| MCP 生态 | JSON 手工编辑 | Marketplace/Registry | ~~P2-4~~（实现后移除，维持手工编辑） |
