/**
 * Webview i18n: Chinese is the source language; an English dictionary is
 * provided for en locales. `t()` falls back to the key itself for any other
 * locale, so nothing breaks when a new language hasn't been translated yet.
 * The locale arrives with every host snapshot (`vscode.env.language`); the
 * mock host fixes it to zh-cn.
 */

export type Locale = string | undefined;

let current: Locale = undefined;

export function setLocale(locale: Locale): void {
  current = locale;
}

function isEnglish(): boolean {
  return (current ?? "zh-cn").toLowerCase().startsWith("en");
}

const en: Record<string, string> = {
  // Super Agent (child sessions of the main session)
  "委派指令": "Delegation directive",
  "子会话": "Child sessions",
  "准备中": "Preparing",
  "等待你处理": "Needs you",
  "已中断": "Interrupted",
  "子会话始终免确认：包括 shell 在内的工具调用都直接执行，不会弹审批":
    "Child sessions always run without confirmation — tool calls, shell included, execute directly and are never prompted for approval",
  // 看板头帮助按钮（HelpTip）里的统一说明：免确认 / 合并规则 / 清理规则。
  "看板说明": "Board help",
  "子会话还在运行时不能合并，结束后才能合并；已合并的子会话、或没有可合并分支的子会话，同样不能合并":
    "A running child session cannot be merged; merge it after it finishes. A child session whose changes are already merged, or that has no branch to merge, cannot be merged either",
  "子会话还在运行时不能清理，需要先中断它":
    "A running child session cannot be cleaned up; interrupt it first",
  "子会话在等你的回答；不回答会在倒计时结束后按「未回答」继续。":
    "The child session is waiting for your answer; if you do not answer, it continues with “no answer” when the countdown ends.",
  "按未回答继续": "it continues with “no answer”",
  "子会话 {0}：{1}": "Child session {0}: {1}",
  "让智能体合并分支": "Let the agent merge the branch",
  "已自动合并": "Auto-merged",
  "合并冲突": "Merge conflict",
  "PR 已创建": "PR opened",
  "集成失败": "Integration failed",
  "未自动合并": "Not auto-merged",
  "无需合并": "No merge needed",
  "该子会话的改动已经合并": "This child's changes are already merged",
  "{0} 个进行中": "{0} running",
  "{0} 个待处理": "{0} need you",
  "{0} 个已完成": "{0} done",
  "{0} 个未成功": "{0} unfinished",
  "{0} 个已中断": "{0} stopped",
  "全部中断": "Interrupt all",
  "子会话看板": "Child-session board",
  "展开子会话看板": "Expand the child-session board",
  "收起子会话看板": "Collapse the child-session board",
  "子会话待答问题": "Child session waiting for your answer",
  "展开已完成的子会话": "Expand the finished child sessions",
  "收起已完成的子会话": "Collapse the finished child sessions",
  "已完成的 {0} 个子会话": "Finished child sessions ({0})",
  "派发": "Dispatch",
  "启动": "Started",
  "等待应答": "Waiting for you",
  "第 {0} 次": "Attempt {0}",
  "阶段轨：{0}": "Timeline: {0}",
  // 子会话 todolist 时间轴：状态 / 优先级是静态词（todo 原文是动态文本，不进字典）
  "待办": "To do",
  "进行中": "In progress",
  "高优先级": "High priority",
  "中优先级": "Medium priority",
  "低优先级": "Low priority",
  "合并子会话分支": "Merge the child session's branch",
  "让智能体把分支 {0} 合并到当前分支？它会自己执行合并并解决冲突，这会改动你当前的工作分支。":
    "Let the agent merge branch {0} into the current branch? It performs the merge itself and resolves conflicts; this changes your working branch.",
  "让智能体合并": "Let the agent merge",
  "子会话还没结束，完成后再让智能体合并":
    "The child session has not finished; merge it after it completes",
  "派出合并子会话，把该子会话的分支合并到当前分支（冲突由它自行解决）":
    "Dispatch a merge child session to merge this child's branch into the current branch (it resolves conflicts itself)",
  "该子会话没有可合并的分支": "This child session has no branch to merge",
  "清理子会话": "Clean up the child session",
  "删除子会话「{0}」的工作目录？分支上未合并的提交会被保留；工作目录里未提交的改动会被一并删除，无法恢复。":
    "Delete the working directory of child session “{0}”? Unmerged commits on its branch are kept, but uncommitted changes in the working directory are deleted permanently.",
  "清理": "Clean up",
  "清理中": "Cleaning up",
  "合并中": "Merging",
  "重试中": "Retrying",
  "子会话还在运行，先中断再清理": "Stop the child session before cleaning it up",
  "中断该子会话": "Interrupt this child session",
  "中断子会话": "Interrupt the child session",
  "中断": "Interrupt",
  "中断子会话「{0}」？子会话进程会立即终止，本次任务不会自动提交或合并；工作目录里已有的改动会保留，之后可以重试。":
    "Interrupt child session “{0}”? Its process stops immediately and this task is neither committed nor merged automatically; changes already written to its working directory are kept, and you can retry later.",
  "中断全部 {0} 个进行中的子会话？它们各自的进程会立即终止，本次任务不会自动提交或合并；工作目录里已有的改动会保留，之后可以重试。":
    "Interrupt all {0} running child sessions? Each process stops immediately and their tasks are neither committed nor merged automatically; changes already written to their working directories are kept, and you can retry later.",
  "重试该子会话（沿用原工作目录，保留已有改动）":
    "Retry this child session (reuses its working directory and keeps existing changes)",
  "第 {0} 次尝试": "Attempt {0}",
  "仅目录隔离": "Directory isolation only",
  "主仓工作区（无隔离）": "Main workspace (no isolation)",
  "待回答": "Needs answer",
  "分支 {0}": "Branch {0}",
  "目录 {0}": "Directory {0}",
  "工作目录与分支已清理": "Working directory and branch cleaned up",
  "工作目录已回收，分支保留": "Working directory reclaimed; branch kept",
  "工作目录 {0} 个": "{0} working directories",
  "已结束 {0} 个可回收": "{0} finished and reclaimable",
  "清理已结束": "Clean up finished",
  "清理已结束的子会话": "Clean up finished child sessions",
  "将删除 {0} 个子会话的工作目录；分支上一律保留（未合并的提交不会丢），工作目录里未提交的改动会被一并删除，无法恢复。":
    "Delete the working directories of {0} child sessions? Their branches are all kept (unmerged commits are not lost), but uncommitted changes in the working directories are deleted permanently.",
  "收起摘要": "Hide summary",
  "查看摘要": "Show summary",
  "查看实时操作": "Show live activity",
  "子会话实时操作": "Child session live activity",
  "上次运行": "From a previous run",
  "这次子会话在上一次运行里就已经结束（扩展重启后恢复的历史记录）":
    "This child session had already finished in a previous run (a historical record restored after the extension restarted)",
  "准备中…": "Preparing…",
  "暂无输出": "No output yet",
  "需要确认执行工具调用": "Needs confirmation to run a tool call",
  "子会话请求批准执行计划": "The child session asks to execute its plan",
  "批准": "Approve",
  "子会话需要你回答": "The child session needs an answer",
  "提交回答": "Send answer",
  "子会话合计开销": "Total child-session usage",
  "输入 {0} · 输出 {1}": "Input {0} · Output {1}",
  "按公开单价估算，仅供参考": "Estimated at published prices; indicative only",
  "输入为内核上报的末次请求上下文；输出按子会话文本估算":
    "Input is the core-reported context of the final request; output is estimated from the child's text",
  "本轮变更": "Changes this turn",
  "变更说明": "Changes-this-turn help",
  "1 个文件已更改": "1 file changed",
  "{0} 个文件已更改": "{0} files changed",
  "{0} 次修改": "{0} edits",
  "这里只列出 iFlow 记录到改动的文件，可能不包含你手动改的内容，也不代表文件现在的最终差异。点击文件可在编辑器中打开。": "Lists files iFlow recorded changes to; manual edits may be missing, and this is not necessarily the file's final diff. Click a file to open it in the editor.",
  "在编辑器中打开": "Open in editor",
  "撤销此文件的本轮修改": "Undo this file's changes from this turn",
  "这一轮的变更记录已不可用。": "This turn's change records are no longer available.",
  "正在读取本轮变更…": "Loading turn changes…",
  "本轮没有可显示的改动记录；这不表示没有文件修改。": "No change records to show for this turn; this does not mean no files were modified.",
  // loading / topbar
  "连接中…（内核启动可能需要十几秒，配置了多个 MCP server 时更久）":
    "Connecting… (Core startup can take 10+ seconds, longer with multiple MCP servers)",
  "历史会话（选择后恢复该会话上下文）": "Recent sessions (pick one to restore its context)",
  "当前会话": "Current session",
  "API 配置（点击切换后重新认证）": "API profile (click to switch, re-authenticates)",
  "权限模式": "Permission mode",
  "智能": "Smart",
  "iFlow 会自行判断风险，必要时才征求你的确认": "iFlow judges the risk itself and only asks when it matters",
  "免确认": "Auto-approve",
  "所有操作直接执行，不再询问": "Every action runs directly — nothing is asked",
  "标准": "Standard",
  "每次执行操作前都要你确认": "You confirm before each action runs",
  "规划": "Plan",
  "只读：只分析、出计划，不改动文件": "Read-only: analyze and plan without changing files",
  "模型": "Model",
  "搜索模型…": "Search models…",
  "新会话": "New session",
  "API 凭据配置": "API credentials",
  "主题": "Theme",
  "浅色": "Light",
  "深色": "Dark",
  "浅色主题": "Light theme",
  "深色主题": "Dark theme",
  "心流·驭光": "iFlow Harness",
  "连接中": "Connecting",
  "就绪": "Ready",
  "正在生成": "Generating",
  "生成中": "Generating",
  "正在规划": "Planning",
  "正在压缩": "Compressing",
  "初始化中": "Initializing",
  "出错了": "Something went wrong",
  "管理配置与凭据…": "Manage profiles & credentials…",
  "会话历史": "Session history",
  // approval card
  "工具执行审批": "Tool execution approval",
  "iFlow 请求执行工具": "iFlow requests to run a tool",
  "取消": "Cancel",
  // user message delete
  "删除该消息及其后所有内容": "Delete this message and everything after it",
  // edit & resend (M4 P1-9)
  "编辑并重发该消息": "Edit and resend this message",
  "重发": "Resend",
  "重发会先把这一轮的文件改回原样，并删除之后的对话": "Resending first restores this turn's files, then deletes the conversation after it",
  "重发会删除这条消息和之后的所有对话": "Resending deletes this message and everything after it",
  // turn-level checkpoint rollback (M3 P0-1)
  "回滚到这一轮之前": "Roll back to before this turn",
  "文件": "Files",
  "对话": "Chat",
  "全部": "Both",
  "只把工作区文件恢复到这一轮之前": "Restore workspace files to before this turn",
  "只删除这条消息及之后的所有对话": "Delete this message and everything after it",
  "恢复文件，并删除这条消息及之后的对话": "Restore files and delete this message and everything after it",
  "这一轮的快照不完整，无法恢复文件": "This turn's snapshot is incomplete, so files cannot be restored",
  "选择回滚范围：只把文件恢复到这一轮之前、只删除这条消息及之后的对话，或两者都做。":
    "Choose the rollback scope: restore files to before this turn, delete this message and everything after it, or both.",
  "这一轮的快照不完整，无法恢复文件，只能删除这条消息及之后的对话。":
    "This turn's snapshot is incomplete, so files cannot be restored — you can only delete this message and everything after it.",
  "确定清空队列中全部 {0} 条待发送消息吗？": "Clear all {0} queued messages?",
  // tool cards / message list
  "已完成": "Completed",
  "失败": "Failed",
  "等待执行": "Waiting",
  "执行中": "Running",
  "操作输出": "Output",
  "实时输出": "Live output",
  "执行参数": "Execution details",
  "技能任务": "Skill task",
  "读取文件": "Read file",
  "搜索文件": "Search files",
  "执行命令": "Run command",
  "写入文件": "Write file",
  "替换内容": "Replace content",
  "读取命令结果": "Read command output",
  "分析图片": "Analyze image",
  "读取内容": "Read content",
  "编辑内容": "Edit content",
  "搜索内容": "Search content",
  "执行操作": "Run operation",
  "工具操作": "Tool operation",
  "调用一项专用能力": "Invoke a specialized capability",
  "查看文件内容": "View file contents",
  "在文件内容中查找信息": "Find information in file contents",
  "在工作区运行一条命令": "Run a command in the workspace",
  "创建或更新文件内容": "Create or update file contents",
  "按指定内容修改文件": "Modify a file using specified content",
  "查看命令执行后的输出": "View command output",
  "读取并理解图片内容": "Read and understand an image",
  "正在处理一项工具任务": "Processing a tool task",
  "MCP 外部工具": "External MCP tool",
  // long-session memory eviction markers
      "内容已释放": "Content released",
      "加载剩余 {0} 行": "Load remaining {0} rows",  "附件图片已释放": "Attached images released",
  "为了不让长会话占用太多内存，这块输出与差异已从界面释放；回退和导出仍使用完整记录":
    "Released from the UI to keep long sessions light; revert and export still use the full record",
  "为了不让长会话占用太多内存，附件图片已从界面释放；完整记录仍然保留":
    "Attached images released from the UI to keep long sessions light; the full record is still kept",
  "回退此改动": "Revert this change",
  "已回退": "Reverted",
  "部分回退": "Partially reverted",
  "保留": "Keep",
  "回退": "Revert",
  "第 {0}/{1} 处改动": "Change {0} of {1}",
  "应用（保留 {0} · 回退 {1}）": "Apply (keep {0} · revert {1})",
  "全部保留": "Keep all",
  "保留此改动": "Keep this change",
  "回退此改动（恢复为编辑前内容）": "Revert this change (restore pre-edit content)",
  "把标记为回退的改动恢复成修改前的内容，其余改动保留": "Restore the changes marked for revert to their pre-edit content, keeping the rest",
  "文件对比": "File diff",
  "任务清单": "Task list",
  "已截断 {0} 字符": "Truncated {0} chars",
  "为省内存只显示前 {0} 字符": "Showing the first {0} chars to save memory",
  "复制全部": "Copy all",
  "查看完整输出": "View full output",
  "标记完成": "Mark done",
  "取消勾选": "Uncheck",
  "打开 API 设置": "Open API settings",
  "打开运行时设置": "Open runtime settings",
  "可能是 API 密钥无效、过期，或账户余额 / 额度不够。到设置里检查或换一个 API 配置后再试。":
    "The API key may be invalid or expired, or the account may be out of balance/quota. Check it in Settings, or switch to another API profile and try again.",
  "网络或代理没连上。检查网络连接和代理设置后重试。":
    "The network or proxy could not connect. Check your connection and proxy settings, then retry.",
  "当前模型可能已下架，或没有这项能力。到设置里换一个可用模型再试。":
    "The current model may be delisted or may not support this. Pick an available model in Settings and try again.",
  "内核文件缺失（安装不完整，或被安全软件删掉了）。重新安装扩展并重启窗口即可恢复。":
    "Core files are missing (incomplete install, or removed by security software). Reinstall the extension and reload the window to recover.",
  "平台一直在限流（请求太频繁）。稍等一下再重试，或在设置里换一个模型 / API 配置。":
    "The platform is rate-limiting requests. Wait a moment and retry, or switch to another model / API profile in Settings.",
  "对话已经超出模型能记住的上限，自动压缩也没能救回来。可以发送 /compress 再压一次，或新建会话继续。":
    "The conversation exceeded what the model can remember and auto-compression could not recover it. Send /compress to compact again, or start a new session to continue.",
  "运行中": "Running",
  "子代理": "Subagent",
  "停止此子代理": "Stop this subagent",
  "已停止": "Stopped",
  "tokens": "tokens",
  "耗时": "Duration",
  "查看完整记录": "View full log",
  "token 数为按对话估算，包含子代理": "Token count is estimated from the conversation and includes subagents",
  "启动子代理 {0}：{1}": "Launch subagent {0}: {1}",
  "读取 {0}": "Reading {0}",
  "运行：{0}": "Running: {0}",
  "更新任务清单": "Updating todos",
  "正在恢复历史会话…": "Restoring session…",
  "正在创建新会话…": "Creating new session…",
  "正在删除会话…": "Deleting session…",
  "正在删除消息…": "Deleting message…",
  "正在回滚对话…": "Rolling back the conversation…",
  "正在恢复会话…": "Restoring session…",
  "删除中…": "Deleting…",
  // Super Agent: 等待子会话汇报期间的「新会话」按钮禁用说明
  "子会话还在运行，等它们汇报完才能新建会话":
    "Child sessions are still running — you can start a new session once they have reported",
  // 用户按了停止、汇报被压住：「新会话」必须放行，否则面板死锁。
  "已停止：可以新建会话，待处理的汇报仍留在原会话":
    "Stopped — you can start a new session; pending results stay with the original session",
  "你按了停止，还有 {0} 项子会话结果没处理。新建会话不会丢掉它们：结果留在原会话里，切回去才会继续处理。要新建吗？":
    "You pressed Stop and {0} child-session result(s) are still unprocessed. Starting a new session will not lose them: they stay with the original session and are processed when you switch back. Start a new session?",
  // 恢复进行中：「新会话」按钮可点（宿主会放弃恢复并立刻新建会话）
  "取消正在进行的会话恢复并新建会话": "Cancel the session restore in progress and start a new session",
  "删除会话 {0}": "Delete session {0}",
  // M4 P1-8 session pin & archive
  "置顶": "Pin",
  "取消置顶": "Unpin",
  "归档": "Archive",
  "取消归档": "Unarchive",
  "已归档（{0}）": "Archived ({0})",
  "重命名": "Rename",
  "会话名称": "Session name",
  // UI-audit 4.2: session row ⋯ action menu + Intl date labels
  "会话操作": "Session actions",
  "搜索会话": "Search sessions",
  "昨天": "Yesterday",
  // UI-audit 4.3: activity group header, action bar, quiet empty state
  "执行了 {0} 个工具": "Executed {0} tool(s)",
  "修改 {0} 个文件": "Modified {0} file(s)",
  "{0} 个失败": "{0} failed",
  "工具活动": "Tool activity",
  "思考了 {0}s": "Thought for {0}s",
  "回滚这一轮": "Roll back this turn",
  "回滚本轮（文件与对话）": "Roll back this turn (files and conversation)",
  "有什么可以帮你？": "What can I help with?",
  "输入 / 查看命令 · @ 引用文件": "Type / for commands, @ to reference files",
  // composer
  "发送": "Send",
  "停止": "Stop",
  // settings modal (unified: API profiles / MCP / approval policies)
  "设置": "Settings",
  "高级，可选填": "Advanced (optional)",
  "点击配置即可切换并重新认证": "Click a profile to switch and re-authenticate",
  "API 配置": "API profiles",
  "已保存（{0}）— 留空保持不变": "saved (…{0}) — leave empty to keep",
  "Base URL 必须以 http:// 或 https:// 开头": "Base URL must start with http:// or https://",
  "API Key 不能为空": "API key is required",
  "模型名称不能为空": "Model name is required",
  "连接 iFlow 需要配置 API 凭据": "Connect to iFlow by configuring API credentials",
  "服务商预设": "Provider presets",
  "自定义": "Custom",
  "获取 API Key": "Get an API key",
  "查看文档": "Documentation",
  "常用模型": "Suggested models",
  "自定义配置": "Custom profile",
  "选择服务商预设可自动填入端点，也可以手动填写任意 OpenAI 兼容端点。":
    "Pick a provider preset to fill in the endpoint, or enter any OpenAI-compatible endpoint manually.",
  "在 DeepSeek 开放平台创建 API Key；端点兼容 OpenAI 协议。":
    "Create an API key on the DeepSeek platform; the endpoint is OpenAI-compatible.",
  "在 Moonshot 开放平台创建 API Key，用于 Kimi 系列模型。":
    "Create an API key on the Moonshot platform for Kimi models.",
  "在智谱开放平台创建 API Key，使用 GLM 系列模型。":
    "Create an API key on the Zhipu platform for GLM models.",
  "在阿里云百炼控制台创建 API Key，使用通义千问系列模型。":
    "Create an API key in the Alibaba Cloud Bailian console for Qwen models.",
  "在硅基流动控制台创建 API Key，可访问多家开源模型。":
    "Create an API key in the SiliconFlow console to access many open-source models.",
  "在 OpenRouter 创建 API Key，可路由到多家供应商的模型。":
    "Create an API key on OpenRouter to route to models from many providers.",
  "本地 Ollama 不校验 API Key，填任意非空值（如 ollama）即可；请确认 Ollama 服务已启动。":
    "Local Ollama does not check the API key — any non-empty value (e.g. ollama) works; make sure the Ollama service is running.",
  // first-run onboarding wizard
  "初始化引导": "Getting started",
  "连接 iFlow": "Connect iFlow",
  "选择模型": "Choose a model",
  "第 {0} / {1} 步": "Step {0} of {1}",
  "稍后设置": "Set up later",
  "上一步": "Back",
  "保存并继续": "Save & continue",
  "开始使用": "Start using",
  "欢迎使用 心流·驭光": "Welcome to iFlow Harness",
  "连接模型服务后即可开始对话；其他设置都能在 ⚙ 中修改。":
    "Connect a model provider to start chatting; everything else stays editable in the ⚙ settings.",
  "尚未选择": "Not selected",
  "尚未配置（可稍后在设置中完成）": "Not configured (finish later in settings)",
  "选择默认使用的模型；随时可以在面板顶部的模型下拉中切换。":
    "Pick the default model. You can switch at any time from the model dropdown in the panel header.",
  "正在连接内核并获取模型列表…": "Connecting to Core and fetching models…",
  "尚未连接": "Not connected",
  "暂无可用模型列表": "No models available yet",
  "保存凭据后会自动获取模型；也可以稍后在模型下拉中选择。":
    "Models are fetched automatically once credentials are saved — or pick one later from the dropdown.",
  "可点击下方按钮重新获取。": "Use the button below to fetch again.",
  "重新获取": "Fetch again",
  "返回填写凭据": "Back to credentials",
  "当前模型：{0}": "Current model: {0}",
  "选择新会话默认的权限模式；点击选项后当前会话也会立即切换。之后可在设置 → 审批策略中细化规则。":
    "Pick the default approval mode for new sessions; clicking an option also switches the current session. Fine-grained rules live in Settings → Approval policies.",
  "初始化进度": "Setup progress",
  "提示音": "Sound",
  "回复完成或失败时播放提示音。": "Play a cue when a reply finishes or fails.",
  "默认权限模式": "Default approval mode",
  "新会话使用的权限模式；当前会话可用输入框下方的模式菜单切换。":
    "Approval mode for new sessions; switch the current session from the mode menu below the composer.",
  "审批说明": "Approval help",
  "「允许一次」只执行这一次；「始终允许」会让本次会话记住这个操作，之后不再询问。":
    "\"Allow once\" runs it just this time; \"Always allow\" remembers this action for the session and stops asking.",
  "拒绝或取消都不会执行任何操作。想提前定好规则，可到「设置 → 审批策略」。":
    "Reject or cancel runs nothing. To set rules in advance, go to Settings → Approval policies.",
  "Y 允许一次 · N 拒绝 · Esc 取消": "Y allow once · N reject · Esc cancel",
  "Y 允许一次 · N/Esc 拒绝": "Y allow once · N/Esc reject",
  "计划说明": "Plan help",
  "Plan 模式只做分析和规划，不改动文件。批准后 iFlow 会开始执行，并可以修改工作区里的文件。":
    "Plan mode only analyzes and plans — it does not change files. Once you approve, iFlow starts working and can modify files in the workspace.",
  "批准的计划会存到 .iflow/specs/，方便以后回看。":
    "Approved plans are saved under .iflow/specs/ so you can review them later.",
  "编辑的内容只在你点「重新规划」时交给 iFlow；点「批准计划」执行的仍是原计划。":
    "Your edits are handed to iFlow only when you choose Re-plan; Approve still runs the original plan.",
  "Y 批准 · N 拒绝 · R 重新规划": "Y approve · N reject · R re-plan",
  "提问说明": "Question help",
  "iFlow 正在等你回答，回答前它会先暂停。":
    "iFlow is waiting for your answer and pauses until you reply.",
  "超时没回答，iFlow 会按「未回答」继续往下走。": "If it times out, iFlow continues as if unanswered.",
  // pending-card convergence (milestone 14 §4.5)
  "约 {0} 分钟后{1}": "{1} in about {0} min",
  "自动继续": "Auto-continue",
  "允许一次": "Allow once",
  "始终允许": "Always allow",
  "拒绝": "Reject",
  "始终拒绝": "Always reject",
  "iFlow 想执行一项操作": "iFlow wants to run an action",
  "读取": "read",
  "写入": "write",
  "搜索": "search",
  "执行": "execute",
  "移动": "move",
  "读取网页": "fetch a page",
  "不回答并继续": "Continue without answering",
  "回车只确认当前输入框；要提交整张卡片，请点「提交回答」或按 Ctrl/Cmd + 回车。":
    "Enter confirms just that field; to submit the whole card, use the Submit answer button or Ctrl/Cmd+Enter.",
  "保存并重新规划": "Save and re-plan",
  "快捷键": "Keyboard shortcuts",
  "停止生成（审批卡中为取消/拒绝）": "Stop generating (cancels/rejects on an approval card)",
  "审批允许 / 拒绝": "Approve / reject",
  "计划批准 / 拒绝 / 重新规划": "Plan approve / reject / re-plan",
  "上一个 / 下一个会话": "Previous / next session",
  "聚焦输入框": "Focus the composer",
  "切换 Focus 视图": "Toggle Focus view",
  "配置完成": "You're all set",
  "可以开始对话了；其余设置在 ⚙ 中随时可改。":
    "You can start chatting now; the rest stays editable in the ⚙ settings.",
  "连接": "Connection",
  "默认模式": "Default mode",
  "继续配置": "Continue configuring",
  "这些能力可以稍后再设置。": "These capabilities can be set up later.",
  "还没配置 API 密钥，现在还不能开始对话。": "No API key configured yet — you cannot start chatting.",
  "去配置": "Set it up",
  "重新运行引导": "Run setup again",
  "收起": "Collapse",
  "展开": "Expand",
  "复制错误信息": "Copy error message",
  "已复制": "Copied",
  "扩展": "Extension",
  "内核": "Core",
  "删除 {0}": "Delete {0}",
  "编辑 {0}": "Edit {0}",
  "添加 API 配置": "Add API profile",
  "添加配置": "Add profile",
  "编辑配置": "Edit profile",
  "尚未添加 API 配置": "No API profiles yet",
  "配置名称（可选，默认为模型名）": "Profile name (optional, defaults to the model name)",
  "如 BUZZ、工作密钥…": "e.g. BUZZ, work key…",
  "Base URL（OpenAI 兼容）": "Base URL (OpenAI-compatible)",
  "模型名称": "Model name",
  "如 glm-5.3-flash-free": "e.g. glm-5.3-flash-free",
  "打开 VSCode 设置…": "Open VSCode Settings…",
  "重启内核": "Restart Core",
  "重启内核进程（会话自动恢复），语言 / 审批模式 / MCP 等设置重启后生效":
    "Restart the Core process (the session restores automatically); language / approval-mode / MCP settings take effect after the restart",
  "点击配置即切换并重新认证会话；配置与密钥保存在内核配置文件 ~/.iflow/settings.json（本机明文）。":
    "Click a profile to switch and re-authenticate the session; profiles and keys are stored in the Core config file ~/.iflow/settings.json (plaintext on this machine).",
  "配置保存在内核配置文件 ~/.iflow/settings.json（本机明文），保存后以 openai-compatible 方式重新认证会话。":
    "The configuration is stored in the Core config file ~/.iflow/settings.json (plaintext on this machine). Saving re-authenticates the session via openai-compatible.",
  "配置保存在内核配置文件 ~/.iflow/settings.json（本机明文）；编辑当前配置会重新认证会话，编辑其他配置只保存、不切换。":
    "The configuration is stored in the Core config file ~/.iflow/settings.json (plaintext on this machine). Editing the active profile re-authenticates the session; editing another profile only saves it without switching.",
  "当前配置正在使用中，生成中或有子会话运行时无法保存":
    "This profile is currently in use; it cannot be saved while a turn is generating or a child session is running.",
  "正在重新认证…": "Re-authenticating…",
  "等待选择…": "Waiting for your choice…",
  "审批策略": "Approval policies",
  "审批规则": "Approval rule",
  "自动允许": "Auto-allow",
  "自动拒绝": "Auto-deny",
  "弹卡确认": "Ask (card)",
  "尚未配置审批规则": "No approval rules configured",
  "项目规则（只读）": "Project rules (read-only)",
  "启用": "Enabled",
  "点击启用": "Click to enable",
  "点击停用": "Click to disable",
  "命中 {0} 次": "hit {0}×",
  "规则名称": "Rule name",
  "如 允许读取 src 下文件": "e.g. Allow reading files under src",
  "动作": "Action",
  "路径通配（相对会话目录）": "Path glob (relative to the session cwd)",
  "命令首词（逗号分隔，仅执行类）": "Command first-words (comma-separated, execute only)",
  "MCP 服务器名": "MCP server name",
  "工具名（精确匹配）": "Tool name (exact match)",
  "维度全部留空将匹配所有请求（谨慎）；编辑只改本地副本，点击「保存」才生效。":
    "Leaving every dimension empty matches ALL requests (use with care); editing only changes a local copy — click Save to apply.",
  "审批请求按顺序匹配规则（项目规则优先），首条命中即生效：自动允许 / 自动拒绝 / 弹卡。内置硬底线：rm、git push 等破坏性命令永不被自动允许，命中时仍弹卡确认。":
    "Approval requests match rules in order (project rules first); the first match decides: auto-allow / auto-deny / ask. Built-in hard floor: destructive commands such as rm or git push are never auto-allowed — they still show the card.",
  // MCP management card
  "MCP 服务器": "MCP servers",
  "添加 MCP 服务器": "Add MCP server",
  "编辑 MCP 服务器": "Edit MCP server",
  "返回列表": "Back to list",
  "读取中…": "Loading…",
  "尚未配置 MCP 服务器": "No MCP servers configured",
  "添加": "Add",
  "保存": "Save",
  "已保存": "Saved",
  "完成": "Done",
  "名称": "Name",
  "如 chrome-devtools": "e.g. chrome-devtools",
  "描述": "Description",
  "传输类型": "Transport type",
  "服务器信息": "Server info",
  "传输与运行": "Transport & run",
  "命令": "Command",
  "参数": "Arguments",
  "添加参数": "Add argument",
  "删除参数": "Delete argument",
  "环境变量": "Environment variables",
  "添加变量": "Add variable",
  "删除变量": "Delete variable",
  "服务 URL": "Service URL",
  "请求头": "Request headers",
  "添加 header": "Add header",
  "删除 header": "Delete header",
  "stdio 配置需 command field": "stdio config needs a command field",
  "sse/streamable-http 配置需 url field": "sse/streamable-http config needs a url field",
  "额外字段保留：{0}": "Extra fields preserved: {0}",
  "名称不能为空": "Name cannot be empty",
  "JSON 格式不合法": "Invalid JSON",
  "配置必须是 JSON 对象": "Config must be a JSON object",
  "名称重复：{0}": "Duplicate name: {0}",
  "编辑只改本地副本，点击「保存」才写入文件。":
    "Editing only changes a local copy; click Save to write the file.",
  "安装只把模板本地草稿，点击「保存」才写入文件。":
    "Installing keeps a local draft only; click Save to write the file.",
  "配置作用域": "Config scope",
  "无项目上下文（未打开工作区）": "No project context (no workspace open)",
  "写入 {0}": "Writes to {0}",
  "覆盖全局": "Overrides global",
  "被项目覆盖": "Overridden by project",
  "项目级": "Project scope",
  "项目级覆盖全局": "Project scope (overrides global)",
  "两级同名时内核用项目级配置整体替换全局条目（不合并字段）":
    "For a name present in both scopes the Core replaces the global entry with the project one wholesale (fields are not merged)",
  "全局读写 ~/.iflow/settings.json 的 mcpServers 字段；保存后点击底部「重启内核」生效（当前会话自动恢复）。":
    "The global scope reads/writes the mcpServers field in ~/.iflow/settings.json; after saving, click Restart Core in the footer to apply (the current session restores automatically).",
  "项目级读写 <工作区>/.iflow/settings.json 的 mcpServers 字段；与全局同名时内核用项目条目整体替换全局条目（不合并字段）。保存后点击底部「重启内核」生效。":
    "The project scope reads/writes the mcpServers field in <workspace>/.iflow/settings.json; for a name also present globally, the Core replaces the global entry with the project one wholesale (fields are not merged). After saving, click Restart Core in the footer to apply.",
  "保存中…": "Saving…",
  // MCP status indicators + detail sub-page
  "状态未知": "Status unknown",
  "已禁用": "Disabled",
  "已屏蔽": "Blocked",
  "已连接": "Connected",
  "连接中…": "Connecting…",
  "未连接": "Not connected",
  "状态不可获取": "Status unavailable",
  "连接状态不可获取（内核未连接或状态上报未启用）":
    "Connection status unavailable (Core not connected, or status reporting not enabled)",
  "连接状态读取中…": "Reading connection status…",
  "详情": "Details",
  "MCP 服务器详情": "MCP server details",
  "刷新": "Refresh",
  "刷新中…": "Refreshing…",
  "返回": "Back",
  "工具声明注入模型上下文约 {0} tokens（估算）":
    "Tool declarations inject ≈{0} tokens into the model context (estimated)",
  "≈{0} tokens": "≈{0} tokens",
  "连接失败：": "Connection failed:",
  "该服务器当前暴露无工具与提示": "This server currently exposes no tools or prompts",
  "工具声明读取中…": "Reading tool declarations…",
  "工具声明不可获取（未连接或状态上报未启用）":
    "Tool declarations unavailable (not connected, or status reporting not enabled)",
  "工具 ({0})": "Tools ({0})",
  "提示 ({0})": "Prompts ({0})",
  "参数 schema": "Parameter schema",
  "参数 schema 已省略（上报预算超限）": "Parameter schema omitted (report budget exceeded)",
  // profile-switch choice dialog
  "切换 API 配置": "Switch API profile",
  "取消切换": "Cancel the switch",
  "切换到 API 配置「{0}」后，当前对话如何处理？": "How should the current conversation be handled when switching to API profile \"{0}\"?",
  "停留在当前会话": "Stay in the current session",
  "保留当前对话，改用新配置继续": "Keep the current conversation and continue with the new configuration",
  "开启新会话": "Start a new session",
  "以新配置开始新对话": "Start new conversation with the new configuration",
  // composer
  "（见附图）": "(see attached image)",
  "移除": "Remove",
  "思考级别": "Reasoning",
  "自动": "Auto",
  "快速": "Fast",
  "平衡": "Balanced",
  "深度": "Deep",
  "模型自行决定思考投入": "Let the model decide how much to think",
  "优先响应速度": "Prioritize response speed",
  "平衡速度与分析能力": "Balance speed and analysis",
  "适合复杂任务、规划和调试": "For complex tasks, planning, and debugging",
  "当前模型不支持思考模式": "Current model does not support thinking mode",
  "无匹配模型": "No matching models",
  "Tab 补全": "Tab to complete",
  "无匹配文件": "No matching files",
  "无匹配文件夹": "No matching folders",
  "向 iFlow 提问…": "Ask iFlow…",
  "（见附件）": "(see attached files)",
  "（见附带的上下文）": "(see attached context)",
  "工作区诊断（Problems）": "Workspace diagnostics (Problems)",
  "Git 状态与变更": "Git status & changes",
  "终端最近输出": "Recent terminal output",
  "在终端中打开（预填命令，不自动执行）": "Open in terminal (prefills the command, does not run it)",
  "在集成终端重跑该命令": "Re-run this command in the integrated terminal",
  "输入 URL 后回车附加": "Type a URL, then press Enter to attach",
  // M2 P0-3 message queue strip
  "队列 · {0} 条待发送": "Queue · {0} pending",
  "已暂停": "paused",
  "继续依序发送队列": "Resume sending the queue in order",
  "继续": "Resume",
  "清空队列": "Clear queue",
  "清空": "Clear",
  "（附件消息）": "(attachment message)",
  "排队中": "Queued",
  "附件 {0}": "{0} attachment(s)",
  "打断并立即发送": "Interrupt & send now",
  "取回编辑": "Edit (back to composer)",
  "上移": "Move up",
  "下移": "Move down",
  "删除": "Delete",
  // delete confirmation dialogs (ConfirmDialog)
  "删除会话": "Delete session",
  "删除消息": "Delete message",
  "删除配置": "Delete profile",
  "删除审批规则": "Delete approval rule",
  "确定删除会话「{0}」吗？此操作不可撤销。": "Delete session \"{0}\"? This cannot be undone.",
  "确定删除该消息及其后所有内容吗？此操作不可撤销。":
    "Delete this message and everything after it? This cannot be undone.",
  "确定删除配置「{0}」吗？其密钥将从 SecretStorage 中永久移除。":
    "Delete profile \"{0}\"? Its key will be permanently removed from SecretStorage.",
  "确定删除规则「{0}」吗？保存后生效。": "Delete rule \"{0}\"? Takes effect after saving.",
  "确定删除「{0}」吗？保存后将从内核配置中移除。":
    "Delete \"{0}\"? It will be removed from the Core configuration when saved.",
  "输入框已有内容，没有填入（原条目仍在）":
    "The composer already has text — nothing was filled in (the original entry is still there)",
  "排队发送 (Enter)": "Queue (Enter)",
  "排队发送（Enter）": "Queue (Enter)",
  "排队": "Queue",
  "添加附件": "Add attachments",
  "{0} 个文件超过大小上限（50MB），已跳过": "Skipped {0} file(s) over the 50 MB limit",
  "{0} 个文件添加失败，已跳过": "Failed to add {0} file(s) — skipped",
  "停止生成": "Stop generating",
  "发送 (Enter)": "Send (Enter)",
  "当前上下文 {0} tokens（内核上报）": "Current context {0} tokens (reported by Core)",
  "当前上下文约 {0} tokens（本地估算；压缩后按压缩结果重算）":
    "Current context ≈ {0} tokens (local estimate; recomputed from the compaction result after compressing)",
  "输入 {0} tokens · 输出 {1} tokens": "Input {0} tokens · output {1} tokens",
  "当前上下文约 {0} tokens（本地估算；压缩后按压缩结果重算）· 输出 {1}":
    "Current context ≈ {0} tokens (local estimate; recomputed from the compaction result after compressing) · output {1}",
  "当前上下文（用户消息与工具结果，压缩后重算）": "Current context (user messages & tool results; recomputed after compression)",
  "输出（回复与思考）": "Output (replies & thinking)",
  // message list
  "在 VSCode 的差异视图里查看这次改动": "Open this change in the VSCode diff view",
  "把这个文件恢复成修改前的内容": "Restore this file to its content before the edit",
  "输出": "Output",
  "思考过程": "Thinking",
  "附件图片 {0}": "Attached image {0}",
  "在 VSCode 中打开": "Open in VSCode",
  "准备好了，向 iFlow 提问吧": "Ready — ask iFlow anything",
  "下发任务、粘贴代码上下文，或直接描述你想实现的功能":
    "Assign tasks, paste code context, or just describe what you want to build",
  // P0-4: empty-state example chips & capability hint
  "帮我梳理这个仓库的结构与核心模块": "Walk me through this repository's structure and core modules",
  "给核心模块补充单元测试": "Add unit tests to the core modules",
  "分析这个报错的可能原因并给出修复方案": "Analyze this error's likely causes and propose a fix",
  "/ 命令 · @ 文件/文件夹 · @problems · @git · @terminal · @url:":
    "/ commands · @ files/folders · @problems · @git · @terminal · @url:",
  // P0-3: splash patience line & error toast actions
  "等待时间偏长：可能是 MCP 服务器连接缓慢或网络不可达":
    "Taking longer than usual — an MCP server may be slow to connect or the network is unreachable",
  "重启内核后重试，当前会话会自动恢复": "Restart the Core and retry — this session restores automatically",
  "关闭": "Dismiss",
  "回到最新": "Jump to latest",
  "展开上下文": "Expand context",
  "拖放文件以添加附件": "Drop files to attach",
  "拖拽调整高度": "Drag to resize",
  "显示密码": "Show password",
  "隐藏密码": "Hide password",
  "展开更早 {0} 条消息": "Show {0} earlier messages",
  "显示更早 {0} 条": "Show {0} earlier steps",
  "上下文摘要": "Context summary",
      "系统提示词": "System prompt",
  "自动注入": "Auto-injected",
  "查看内容": "View content",
  "其余注入类别见展开详情": "Remaining injected categories — see the expanded details",
      "记忆": "Memory",  "上下文文件": "Context files",
      "{0} 个项目记忆文件": "{0} project memory file(s)",
      "{0} 个知识库文档": "{0} knowledge doc(s)",
        "MCP 未连接": "MCP not connected",
        "MCP 项目级": "MCP project-scope",
        "这次请求没有带上": "Not included in this request",  "{0} 字符": "{0} chars",
  "{0} 字节": "{0} bytes",
  "diff": "diff",
  // composer / message list (additional — new entries only)
  "复制": "Copy",
  "重新生成": "Regenerate",
  "增量刷新": "Incremental refresh",
  "增量更新": "incremental update",
  "全量生成": "full generation",
  "上次生成：{0} · {1} 个文件": "Last generated: {0} · {1} files",
  "全量重建": "Full rebuild",
  "只根据变化更新索引，无变化时不会调用模型":
    "Update the index from changes only; no model call when nothing changed",
  "重新分析整个工作区并覆盖索引": "Re-analyze the whole workspace and overwrite the index",
  "正在启动 …": "Starting …",
  "正在重新启动内核 …": "Restarting the Core …",
  "首次启动，或配置了多个 MCP 服务器时会多等一会儿":
    "Takes longer on first launch, or when several MCP servers are configured",
  // P1: edit & resend, session search, aria-live announcements
  "编辑并重发": "Edit & resend",
  "搜索会话…": "Search sessions…",
  "有操作等你批准": "An action is waiting for your approval",
  "iFlow 有问题等你回答": "iFlow has a question for you",
  "等你选择切换 API 配置后如何处理当前会话": "Choose how to handle this session after switching API profiles",
  "自定义回答": "Custom answer",
  "其他": "Other",
  "填写自定义回答": "Write a custom answer",
  "输入你的回答，回车确认": "Type your answer, press Enter to confirm",
  "已选 {0} 项": "{0} selected",
  "正在连接 iFlow…": "Connecting to iFlow…",
  "正在生成回复…": "Generating response…",
  "正在规划…": "Planning…",
  "正在压缩上下文…": "Compressing context…",
  "已停止生成": "Generation stopped",
  "已就绪": "Ready",
  // Plan-mode exit confirmation card
  "iFlow 准备开始执行计划": "iFlow is ready to start the plan",
  "批准后 iFlow 会离开 Plan 模式，按下面的计划开始动手：": "Once approved, iFlow leaves Plan mode and starts working through this plan:",
  "批准计划": "Approve plan",
  "拒绝计划": "Reject plan",
  "重新规划": "Re-plan",
  "编辑计划": "Edit plan",
  "预览计划": "Preview plan",
  "编辑": "Edit",
  "预览": "Preview",
  "计划审批操作": "Plan approval actions",
  "计划已就绪，等你批准": "The plan is ready for your approval",
  // render-error fallback (ErrorBoundary)
  "重试": "Retry",
  "界面渲染异常": "Interface rendering error",
  "重新载入面板即可恢复；也可以直接重试。":
    "Reload the panel to recover, or just retry.",
  "消息区渲染异常": "Message area rendering error",
  "这段内容没能显示出来，下次更新时会自动重试。":
    "This content could not be displayed; it will retry automatically on the next update.",
  // M1: Focus view, context occupancy, cost, prompt enhancement
  "Focus 视图": "Focus view",
  "Focus 视图：只看对话，折叠工具与思考（Ctrl+Alt+F）":
    "Focus view: conversation only, tools and thoughts collapsed (Ctrl+Alt+F)",
  "退出 Focus 视图（Ctrl+Alt+F）": "Exit Focus view (Ctrl+Alt+F)",
  "上下文占用 {0} / {1}（{2}%{3}{4}）": "Context {0} / {1} ({2}%{3}{4})",
  "，上限为估算值": ", limit is an estimate",
  "，占用为内核上报值": ", occupancy reported by the Core",
  "当前上下文 {0} tokens（内核上报）· 输出 {1}（估算）":
    "Context {0} tokens (reported by the Core) · output {1} (estimated)",
  "用户 {0} · 助手 {1} · 工具 {2} · 思考 {3}": "User {0} · assistant {1} · tools {2} · thoughts {3}",
  "用户 {0} · 助手 {1} · 工具 {2} · 思考 {3} · 固定开销 {4}":
    "User {0} · assistant {1} · tools {2} · thoughts {3} · fixed overhead {4}",
  "固定开销 = 系统提示词、记忆和工具说明，每次请求都要带上":
    "Fixed overhead = system prompt, memory and tool descriptions — carried on every request",
  "估算没有算上内核内置的工具说明和目录清单":
    "The estimate leaves out the Core's built-in tool descriptions and directory listing",
  "缓存读取 {0} tokens": "Cache read {0} tokens",
  "预估成本 {0}（按公开单价估算）": "Estimated cost {0} (at published prices)",
  "该模型无单价记录，不显示成本": "No unit price recorded for this model — no cost shown",
  "上下文窗口占用": "Context window occupancy",
  "展开全部 {0} 张上下文卡": "Show all {0} context cards",
  "建议": "Suggested",
  "预估成本（token 估算 × 公开单价，仅供参考）": "Estimated cost (token estimate × published prices, indicative only)",
  "增强提示词（AI 改写为更清晰的请求）": "Enhance prompt (AI rewrites it into a clearer request)",
  "正在增强，点击取消": "Enhancing… click to cancel",
  "已取消增强": "Enhancement cancelled",
  "输入已修改，已放弃增强结果": "Input changed — enhancement result discarded",
  "还原原始输入": "Restore the original input",
  "已增强输入（再次点击增强可还原）": "Prompt enhanced (click Enhance again to restore)",
  "已还原原始输入": "Original input restored",
  // turn-end next-step suggestions + General settings tab
  "通用": "General",
  "下一步": "Next",
  "iFlow 猜的下一步，点一下填进输入框": "iFlow's guess at the next step — click to insert it into the composer",
  "关闭建议": "Dismiss suggestions",
  "正在想下一步建议…": "Thinking of next steps…",
  "下一步建议": "Next-step suggestions",
  "每轮回复完成后单独调用一次模型，推测可选的下一步操作并显示在输入框上方（会产生额外 token 消耗）。":
    "After each completed turn, make one extra model call to predict likely next actions and show them above the composer (extra token usage).",
  "默认开启。关闭后不再发起该模型调用，已显示的候选会被清除。":
    "Enabled by default. When off, no extra call is made and any displayed candidates are cleared.",
  "自动压缩上下文": "Auto-compress context",
  "默认关闭。未开启时仍会在网关报上下文超限后自动压缩，也可点击提示中的「立即压缩」。":
    "Off by default. When disabled, compression still runs after the gateway reports context overflow, and the「立即压缩」action remains available.",
  "界面": "Interface",
  "字号": "Font size",
  "调整面板中文字的大小；标准档会把常用的 11px 小字提升到约 12px。":
    "Adjusts text size in the panel; Standard raises the common 11px small text to about 12px.",
  "密度": "Density",
  "调整控件内边距与间距；不影响字号。":
    "Adjusts control padding and spacing; does not change text size.",
  "紧凑": "Compact",
  "大": "Large",
  "宽松": "Comfortable",

  // settings taxonomy + grouped settings (2026-10-18)
  "账户与模型": "Account & models",
  "外观与交互": "Appearance & interaction",
  "权限与审批": "Permissions & approvals",
  "MCP 与工具": "MCP & tools",
  "记忆与知识": "Memory & knowledge",
  "运行与数据": "Runtime & data",
  // settings information architecture (2026-10-21, milestone 14 §4.7)
  "账户": "Account",
  "工作方式": "Workflow",
  "系统": "System",
  "设置分区": "Settings sections",
  "设置如何保存": "How settings are saved",
  "面板设置写入 VSCode 用户 settings.json，可随 VSCode 设置同步；API 配置与密钥写入内核配置文件 ~/.iflow/settings.json（本机明文）。MCP、语言与审批模式同样在内核配置文件，重启内核生效。":
    "Panel settings are written to your VSCode user settings.json and follow VSCode Settings Sync; API profiles and keys are written to the Core config file ~/.iflow/settings.json (plaintext on this machine). MCP, language and approval mode also live in the Core config and apply after a Core restart.",
  "详细说明": "Details",
  "会话": "Session",
  "会话首轮完成后自动生成简短标题。": "Generate a short title after a session's first turn.",
  "每会话一次，会产生一次轻量模型调用。": "Once per session; one lightweight model call.",
  "并发上限": "Concurrency limit",
  "同时运行的子会话数量上限。": "Maximum number of child sessions running at the same time.",
  "默认 5，范围 1–20。超出的派发会排队，等有空位再启动；调低后已在运行的子会话不受影响。":
    "Defaults to 5, adjustable from 1 to 20. Extra dispatches queue and start as slots free up; lowering the limit does not interrupt sessions already running.",
  "个": "sessions",
  "回复完成后推测下一步操作，显示在输入框上方。":
    "Predict likely next actions after a reply and show them above the composer.",
  "每轮回复完成后单独调用一次模型（会产生额外 token）。关闭后不再发起调用，已显示的候选会被清除。":
    "One extra model call per completed turn (extra token usage). When off, no call is made and displayed candidates are cleared.",
  "上下文占用达到阈值时自动压缩会话。": "Compress the conversation when context occupancy reaches the threshold.",
  "每轮回复结束后，若上下文占用达到设定阈值，自动压缩会话后再继续下一轮。默认关闭；网关报超限时仍会自动压缩。":
    "After a turn settles, if context occupancy reaches the configured threshold, compress the conversation before continuing the next turn. Off by default; compression still runs after the gateway reports context overflow.",
  "回复完成后提取可长期保留的偏好候选。": "Extract long-term preference candidates after a reply.",
  "每轮回复结束后用当前模型提取可长期保留的偏好/约定候选；候选必须由你确认后才会写入（会产生额外 token）。":
    "After a turn settles, extract long-term preference candidates with the current model; they are written only after you confirm them (extra token usage).",
  "跟随编辑器主题，或固定为浅色/深色。": "Follow the editor theme, or pin light/dark.",
  "调整面板整体字号。": "Adjust the panel font size.",
  "标准为基准，紧凑约 0.92×，大约 1.1×。": "Standard is the baseline; compact is about 0.92×, large about 1.1×.",
  "调整控件内边距与间距。": "Adjust control padding and spacing.",
  "标准为基准，紧凑约 0.92×，宽松约 1.12×。不影响字号。":
    "Standard is the baseline; compact about 0.92×, comfortable about 1.12×. Font size is unaffected.",
  "面板不可见时发送系统通知。": "Send OS notifications while the panel is hidden.",
  "审批/提问/计划阻塞时，或整轮完成时发送。":
    "Sent when an approval, question or plan blocks, or when a turn completes.",
  "高级外观": "Advanced appearance",
  "可选": "Optional",
  "新会话使用的权限模式。": "The permission mode new sessions start with.",
  "当前会话可用输入框下方的模式菜单切换。": "Switch the current session's mode from the menu below the composer.",
  "内核兼容": "Core compatibility",
  "写入内核配置的启动审批模式。": "The approval mode the Core starts with.",
  "窗口打开时预热内核，首次打开面板无需等待。":
    "Warm up the Core when a window opens so the first panel open is instant.",
  "每窗口约 100MB 内存；下次窗口启动生效。": "About 100MB per window; takes effect on the next window start.",
  "面板启动时恢复上次使用的会话。": "Restore the last used session when the panel starts.",
  "无可恢复记录时新建会话。": "Falls back to a new session when nothing is restorable.",
  "VSCode 启动时自动打开聊天面板。": "Open the chat panel automatically when VSCode starts.",
  "下次启动生效。": "Takes effect on the next start.",
  "每轮对话前快照工作区，支持按轮回退。":
    "Snapshot the workspace before each turn so file changes can be rolled back per turn.",
  "快照写入独立的影子 git 仓库，不触碰你的 .git。":
    "Snapshots go to a separate shadow git repo — your own .git is never touched.",
  "检查点": "Checkpoints",
  "磁盘占用": "Disk usage",
  "快照保存在工作区存储中；容量上限等参数在「高级」中调整。":
    "Snapshots live in the workspace storage; adjust the limits under「Advanced」.",
  "高级": "Advanced",
  "检查点限额与内核运行时": "Checkpoint limits & Core runtime",
  "留空使用默认工作区存储。": "Leave empty for the default workspace storage.",
  "留空自动探测。": "Leave empty to auto-detect.",
  "修改后重启内核生效。": "Takes effect after a Core restart.",
  "内核的显示语言。": "The display language of the Core.",
  "配置 {0} 的操作": "Actions for {0}",
  "服务器 {0} 的操作": "Actions for server {0}",
  "更多操作": "More actions",
  "技能与命令": "Skills & commands",
  "设置写入用户 settings.json，可随 VSCode 设置同步。":
    "Stored in user settings.json and carried by VSCode Settings Sync.",
  "资产类型": "Asset type",
  "技能": "Skills",
  "记忆文件": "Memory files",
  "快速追加": "Quick add",
  "回合结束后": "After each turn",
  "可能产生额外的模型调用": "May make extra model calls",
  "下一步预测超时": "Next-step prediction timeout",
  "下一步建议的模型调用最长等待秒数。": "Longest wait (seconds) for the next-step prediction model call.",
  "记忆提取超时": "Memory extraction timeout",
  "自动提取记忆的模型调用最长等待秒数。": "Longest wait (seconds) for the memory extraction model call.",
  "回合末的标题、下一步、记忆提取合并为一次模型调用，实际等待时间取所含任务中最宽松的上限；填 0 表示不限制。":
    "The turn-end title, next-step and memory tasks share ONE model call, so the actual budget is the loosest ceiling among the tasks it carries; 0 means no limit.",
  "压缩超时": "Compression timeout",
  "压缩会话的最长等待秒数。": "Longest wait (seconds) for a context-compression turn.",
  "默认 0（不限制）：压缩一个很大的会话本来就可能需要几分钟。填入秒数后，超时会取消这次压缩并提示你。":
    "0 (no limit) by default: compressing a very large session can legitimately take minutes. Once set, an overrunning compression is cancelled and reported.",
  "自动压缩阈值": "Auto-compress threshold",
  "上下文占用达到该比例时自动压缩会话。": "Compress the conversation once context occupancy reaches this percentage.",
  "可调范围 50–100%。": "Adjustable between 50% and 100%.",
  "秒": "s",
  "自动生成标题": "Auto-generate titles",
  "会话首轮完成后用当前模型生成简短标题（每会话一次，会产生一次轻量调用）。":
    "Generate a short title with the current model after a session's first turn (once per session, one lightweight call).",
  "主题与排版": "Theme & typography",
  "跟随编辑器": "Follow editor",
  "跟随编辑器主题，或固定为浅色/深色。设置写入用户 settings.json，可随 VSCode 设置同步。":
    "Follow the editor theme, or pin light/dark. Stored in user settings.json and carried by VSCode Settings Sync.",
  "极光强度": "Aurora intensity",
  "背景光斑的不透明度（0–100）。": "Background aurora light-spot opacity (0–100).",
  "提示与通知": "Sound & notifications",
  "系统通知": "OS notifications",
  "面板不可见时发送系统通知：审批/提问/计划阻塞时，或整轮完成时。":
    "Send an OS notification while the panel is hidden: on blocking approvals/questions/plans, or when a turn completes.",
  "仅审批/提问/计划": "Approvals, questions & plans",
  "全部完成事件": "All completions",
  "从不": "Never",
  "面板默认权限模式": "Default panel approval mode",
  "内核默认审批模式": "Core default approval mode",
  "写入 ~/.iflow/settings.json；与面板默认模式相互独立，修改后重启内核生效。":
    "Written to ~/.iflow/settings.json; independent of the panel default and applied after a Core restart.",
  "不覆写": "Do not override",
  "启动与会话": "Startup & sessions",
  "后台预热内核": "Warm up the Core",
  "窗口打开时在后台启动内核，首次打开面板无需等待（每窗口约 100MB 内存）。下次窗口启动生效。":
    "Start the Core in the background when a window opens so the first panel open is instant (about 100MB per window). Takes effect on the next window start.",
  "恢复上次会话": "Restore last session",
  "面板启动时恢复上次使用的会话；无可恢复记录时新建会话。":
    "Restore the last used session when the panel starts; fall back to a new session when nothing is restorable.",
  "启动时自动打开面板": "Open the panel on startup",
  "VSCode 启动时自动打开聊天面板。下次启动生效。":
    "Open the chat panel automatically when VSCode starts. Takes effect on the next start.",
  "内核运行时": "Core runtime",
  "重启内核生效": "Takes effect after a Core restart",
  "Node.js 路径": "Node.js path",
  "留空自动探测；修改后重启内核生效。": "Leave empty to auto-detect; restart the Core after changing.",
  "内核语言": "Core language",
  "写入 ~/.iflow/settings.json；修改后重启内核生效。":
    "Written to ~/.iflow/settings.json; takes effect after a Core restart.",
  "跟随内核": "Leave to the Core",
  "检查点与存储": "Checkpoints & storage",
  "启用检查点": "Enable checkpoints",
  "每轮对话前把工作区快照到独立的影子 git 仓库，以支持按轮回退。":
    "Snapshot the workspace into a separate shadow git repo before each turn so file changes can be rolled back per turn.",
  "最大文件数": "Max files",
  "超过该文件数时关闭快照。": "Disable snapshots when the workspace has more files than this.",
  "单文件上限（MB）": "Max file size (MB)",
  "跳过大于该尺寸的文件；0 表示不限。": "Skip files larger than this; 0 means no limit.",
  "保留轮数": "Turns to keep",
  "每会话保留的快照轮数；0 表示不清理。": "Snapshot turns kept per session; 0 means no cleanup.",
  "总大小上限（MB）": "Total size cap (MB)",
  "所有会话快照的总磁盘上限；0 表示不限制。": "Total on-disk cap for all session snapshots; 0 means unlimited.",
  "存储目录": "Storage directory",
  "留空使用默认 workspaceStorage；支持 ~ 与相对路径。":
    "Leave empty for the default workspaceStorage; supports ~ and relative paths.",
  "同步与原始设置": "Sync & raw settings",
  "需要直接编辑原始 JSON 时，可使用底部的「在 VSCode 设置中编辑…」；面板中的改动已写入同一份用户设置。":
    "To edit the raw JSON directly, use「在 VSCode 设置中编辑…」at the bottom; panel changes already write to the same user settings.",
  "这些设置写入 VSCode 用户 settings.json；开启 VSCode 设置同步后会跨设备同步。API Key 保存在 SecretStorage，不会同步。":
    "These settings are written to your VSCode user settings.json and follow VSCode Settings Sync across machines. API keys stay in SecretStorage and are never synced.",
  "MCP 服务器配置保存在 ~/.iflow/settings.json，由内核读取；不随 VSCode 设置同步。":
    "MCP server configuration lives in ~/.iflow/settings.json and is read by the Core; it is not part of VSCode Settings Sync.",
  "在 VSCode 设置中编辑…": "Edit in VSCode settings…",
  "已写入用户 settings.json": "Saved to user settings.json",
  "模型元数据": "Model metadata",
  "上下文窗口覆写": "Context window overrides",
  "每行「模型名=token数」（如「glm-4.6=200000」）；未知模型回退默认值。":
    "One「model=tokenCount」per line (e.g.「glm-4.6=200000」); unknown models fall back to the default.",
  "成本单价": "Unit prices",
  "每行「模型名=输入价,输出价」（USD/百万 token，如「deepseek-v3=0.27,1.1」）。":
    "One「model=inputPrice,outputPrice」per line (USD per million tokens, e.g.「deepseek-v3=0.27,1.1」).",
  "思考模型规则": "Thinking model rules",
  "JSON 数组，每项含 pattern / supportsThinking 等字段；保存后同步到 ~/.iflow/thinking-models.json，重启内核生效。":
    "JSON array of rules with pattern / supportsThinking; saved to ~/.iflow/thinking-models.json and applied after a Core restart.",
  "应用": "Apply",
  "JSON 格式无效": "Invalid JSON",
  "条目必须是数组": "The value must be an array",
  "联网检索官方资料，由当前模型提炼后追加到下表。":
    "Web-searches official docs and appends the rows the current model extracts below.",
  "检索由扩展直接发起，不经过内核会话；资料会交给当前模型做一次提炼（产生一次额外 token 消耗）。只追加、不覆盖，在资料中找不到依据的条目会被丢弃。":
    "The extension runs the search itself (no core session); the retrieved text goes to the current model for one extraction pass, which costs extra tokens. Rows are only appended — anything the cited source cannot back is dropped.",
  "联网补充模型数据": "Fetch model data online",
  "开始检索": "Start search",
  "正在检索…": "Searching…",
  "正在检索资料，随后交给当前模型提炼…": "Searching the web, then asking the current model to extract the rows…",
  "停止检索": "Stop search",
  "已追加：上下文窗口 {0} 条 · 成本单价 {1} 条 · 思考规则 {2} 条":
    "Appended: {0} context windows · {1} unit prices · {2} thinking rules",
  "检索完成，资料中没有可补充的新数据。": "Search finished; nothing new to add from the retrieved sources.",
  "会调用当前模型提炼检索资料，产生一次额外 token 消耗。":
    "Invokes the current model once to extract the rows — this costs extra tokens.",
  // F3 memory manager (Phase 1)
  "全局记忆": "Global memory",
  "项目记忆": "Project memory",
  "主文件": "Primary",
  "自动发现": "Auto-discovered",
  "遗留文件": "Legacy",
  "已注入": "Injected",
  "未注入": "Not injected",
  "约 {0} tokens（BPE 估算）": "About {0} tokens (BPE estimate)",
  "打开文件": "Open file",
  "编辑记忆": "Edit memory",
  "尚未创建": "Not created yet",
  "更新于 {0}": "Updated {0}",
  "当前内核不会加载此文件": "The current Core does not load this file",
  "删除这条记忆": "Delete this memory",
  "还有 {0} 条…": "{0} more…",
  "{0} 条记忆": "{0} memories",
  "收起记忆列表": "Collapse memory list",
  "展开全文": "Expand full text",
  "收起全文": "Collapse full text",
  "记忆在新建会话或恢复会话时加载。当前会话需要重启内核才会读取新内容。":
    "Memory is loaded when a new session is created or a session is restored. The current session only sees new content after the Core restarts.",
  "重新加载": "Reload",
  "{0} 字符 · ≈{1} tokens": "{0} chars · ≈{1} tokens",
  "已保存 {0}": "Saved {0}",
  "新建会话或重启内核后生效": "Takes effect after a new session or Core restart",
  "以下是内核每次请求都会自动注入的记忆文件。内容会随请求发送给模型，请勿写入密钥。":
    "These are the memory files the Core injects into every request. Their content is sent to the model — do not store secrets here.",
  "重新扫描": "Rescan",
  "未打开工作区": "No workspace open",
  "当前工作区没有可用的项目记忆文件": "No project memory files are available in this workspace",
  "新建项目记忆": "New project memory",
  "添加一条记忆": "Add a memory",
  "全局": "Global",
  "项目": "Project",
  "例如：本项目的测试命令是 npm test；不要修改 vendor/ 下的文件。":
    "e.g. This project's test command is npm test; do not modify files under vendor/.",
  "写入中…": "Writing…",
  "保存到{0}": "Save to {0}",
  "保存后新建会话或重启内核生效": "Takes effect after a new session or Core restart",
  "请先创建项目记忆文件": "Create a project memory file first",
  "新建会话": "New session",
  "重启内核使记忆生效": "Restart Core to apply memory",
  "重启内核并恢复当前会话，使记忆立即生效":
    "Restart the Core and restore the current session so memory applies immediately",
  "记忆不会热更新到正在进行的会话。": "Memory is not hot-reloaded into an ongoing session.",
  "文件已在磁盘上发生变化，请重新加载后再保存":
    "The file changed on disk — reload before saving",
  "保存失败": "Save failed",
  "保存超时，请重试": "Save timed out — please retry",
  "读取 {0}…": "Loading {0}…",
  // F3 Phase 2: quick add + candidate review
  "记住这条": "Remember this",
  "保存到全局记忆": "Save to global memory",
  "保存到项目记忆": "Save to project memory",
  "要记住的内容（可编辑）": "What to remember (editable)",
  "记忆会随每次请求发送给模型，请勿写入密钥。":
    "Memory is sent to the model with every request — never store secrets here.",
  "已加入记忆（新会话生效）": "Memory added (effective in a new session)",
  "记忆候选": "Memory candidates",
  "iFlow 建议沉淀记忆": "iFlow suggests saving memories",
  "查看并确认": "Review and confirm",
  "忽略": "Dismiss",
  "确认后才会写入记忆": "Nothing is written until you confirm",
  "记忆作用域": "Memory scope",
  "置信度 {0}%": "Confidence {0}%",
  "模型对该候选的置信度（0–100%）":
    "The model's confidence in this candidate (0–100%)",
  "偏好": "Preference",
  "约定": "Convention",
  "决策": "Decision",
  "陷阱": "Gotcha",
  "保存选中（{0}）": "Save selected ({0})",
  "全部忽略": "Ignore all",
  "自动提取只生成候选，确认后才会写入记忆":
    "Auto-extraction only produces candidates; nothing is written until you confirm",
  "以下是模型从最近对话中提取的长期记忆候选。请勾选要保留的内容，并确认作用域。":
    "These long-term memory candidates were extracted from the recent conversation. Check what to keep and confirm the scope.",
  "自动提取记忆": "Auto-extract memories",
  "每轮回复结束后用当前模型提取可长期保留的偏好/约定候选；候选必须由你确认后才会写入。":
    "After each turn, ask the current model for durable preference/convention candidates; nothing is written until you confirm.",
  "默认开启。关闭后不再发起该模型调用；自动提取只生成候选，不会自动写入。":
    "Enabled by default. When off, no extra model call is made; extraction only produces candidates and never writes automatically.",
  // F3 Phase 3: project knowledge
  "项目知识库": "Project knowledge",
  "{0} 篇文档": "{0} doc(s)",
  "生成项目知识": "Generate project knowledge",
  "尚未生成项目知识。点击「生成项目知识」分析当前工作区。":
    "No project knowledge yet. Click “Generate project knowledge” to analyze this workspace.",
  "取消注入": "Stop injecting",
  "注入": "Inject",
  "项目知识已注入约 {0} tokens，会随每次请求发送；建议只保留索引或精简文档。":
    "Project knowledge injects about {0} tokens into every request; keep only the index or trim the docs.",
  "导入位置：{0}": "Imported by: {0}",
  "知识索引生成后写入 .iflow/knowledge/，通过项目记忆的 @ 导入注入；默认只在新建或恢复会话时生效。":
    "The generated index lives in .iflow/knowledge/ and is injected through an @ import in project memory; it takes effect in a new or restored session.",
  "正在扫描工作区…": "Scanning workspace…",
  "正在生成知识索引…": "Generating knowledge index…",
  "正在写入项目知识…": "Writing project knowledge…",
  "正在生成…": "Generating…",
  "生成失败": "Generation failed",
  // super-agent 协议块卡片（转录里取代裸 JSON 代码块）
  "子会话委派": "Child-session delegation",
  "{0} 个任务": "{0} task(s)",
  "第 {0}/{1} 个任务": "Task {0}/{1}",
  "载荷未能完整解析，以下任务书仅供阅读，可能尚未派发":
    "The payload could not be fully parsed; the task briefs below are for reading only and may not have been dispatched yet.",
  "工具参数未能完整解析，任务列表暂不可用，以下保留原始参数":
    "The tool arguments could not be fully parsed, so the task list is unavailable. The raw arguments are kept below.",
  "工具参数未能完整解析，动作列表暂不可用，以下保留原始参数":
    "The tool arguments could not be fully parsed, so the action list is unavailable. The raw arguments are kept below.",
  "子会话操作": "Child session actions",
  "{0} 个动作": "{0} action(s)",
  "回答": "Answer",
  "{0} 个回答": "{0} answer(s)",
  "保留分支": "Keep branch",
  "正在编写任务书…": "Writing the task brief…",
  "正在编写子会话操作…": "Writing child session actions…",
  "原始协议块": "Raw protocol block",
  "{0} · {1} 字符": "{0} · {1} chars",
  "内容不是合法 JSON": "The body is not valid JSON",
  "缺少 tasks 数组": "Missing the tasks array",
  "缺少 actions 数组": "Missing the actions array",
  "没有可展示的任务": "No task to display",
  "没有可展示的动作": "No action to display",
  "未知的协议块语言": "Unknown protocol fence language",
  "展开任务说明": "Expand the task description",
  "收起任务说明": "Collapse the task description",
  "展开全文（还有 {0} 字）": "Show full text ({0} more characters)",
  "未指定子会话": "No child session specified",
  // 多张待处理卡的堆叠计数器（审批 / Plan 退出 / 提问）
  "还有 {0} 张卡片待处理": "{0} more card(s) need you",
  "还有 {0} 张卡片待处理：{1}": "{0} more card(s) need you: {1}",
  "收起待处理卡": "Collapse pending cards",
  "iFlow 有问题想问你": "iFlow has a question for you",
  // 对话区反馈：复制回执 / 文件暂存占位 / 请求在飞的进行态
  "复制失败": "Copy failed",
  "搜索中…": "Searching…",
  "解析中…": "Resolving…",
  "读取上下文超时了，请重试": "Reading the context timed out. Try again.",
  "切换中…": "Switching…",
  "正在停止…": "Stopping…",
  "暂存中…": "Staging…",
  "添加文件超时了，请重试": "Adding the file timed out. Try again.",
  "、": ", ",

  // 2026-11-16 文案优化：设置 / 引导 / 认证 / 审批规则（键变更后的新词条）
  "设置保存在哪里": "Where settings are saved",
  "外观、提示这类面板偏好保存在 VSCode 用户设置里，可以随 VSCode 设置同步。API 配置与密钥、MCP、语言、审批模式保存在本机 iFlow 配置中（密钥为明文，请注意本机安全），重启内核后生效。":
    "Panel preferences such as appearance and sound live in your VSCode user settings and follow VSCode Settings Sync. API profiles and keys, MCP, language and approval mode live in the local iFlow config (keys are plaintext — mind who can read this machine) and apply after a Core restart.",
  "打开 VSCode 设置": "Open VSCode settings",
  "重启内核，当前会话会自动恢复。语言、审批模式与 MCP 的改动在重启后生效。":
    "Restart the Core — the current session comes back automatically. Language, approval mode and MCP changes apply after the restart.",
  "内容需要是列表（最外层用 [ ]）": "The content must be a list (wrap it in [ ])",
  "JSON 格式有误，请检查括号与引号": "Invalid JSON — check the brackets and quotes",
  "用 JSON 列表写明哪些模型支持思考：每项包含 pattern（模型匹配）与 supportsThinking（是否支持）。保存后写入本机 iFlow 配置，重启内核生效。":
    "List which models support thinking as JSON: each entry has pattern (which models match) and supportsThinking. Saved to the local iFlow config and applied after a Core restart.",
  "应用修改": "Apply changes",
  "首轮对话结束后，自动给会话起一个简短标题。":
    "Give the session a short title once its first turn finishes.",
  "每个会话只生成一次，会额外消耗少量 token。":
    "Generated once per session; costs a small amount of extra tokens.",
  "最多同时运行几个子会话。": "How many child sessions may run at once.",
  "默认 5，可设 1–20。超出上限的派发会排队，等有空位再开始；调低后已经在跑的子会话不受影响。":
    "Defaults to 5, adjustable 1–20. Extra dispatches queue up and start when a slot frees; lowering the limit does not interrupt child sessions already running.",
  "每轮结束可能多花一次模型调用": "Each turn may cost one extra model call",
  "每轮回复结束后，推测你接下来可能想做什么，显示在输入框上方。":
    "After each reply, guess what you may want next and show it above the composer.",
  "每轮结束会多调用一次模型（消耗额外 token）。关闭后不再调用，已显示的候选会立即清除。":
    "Adds one model call per turn (extra tokens). When off, no call is made and shown suggestions disappear.",
  "下一步建议最多等多久。": "How long to wait for this suggestion.",
  "回合结束时，标题、下一步建议与记忆提取会合并成一次模型调用，实际按其中最长的时间等待。填 0 表示一直等。":
    "At the end of a turn, the title, next-step and memory tasks share one model call, so the wait follows the longest limit among them. 0 means wait indefinitely.",
  "上下文快满时自动压缩会话，腾出空间继续对话。":
    "Compress the conversation when context is nearly full, so you can keep going.",
  "每轮结束后检查一次，达到设定比例就先压缩再继续。默认关闭；即使关闭，模型报「上下文超出上限」时仍会自动压缩。":
    "Checked after every turn: once occupancy reaches the set percentage, compress before continuing. Off by default; even when off, an overflow error from the model still triggers compression.",
  "压缩最多等多久。": "How long to wait for compression.",
  "默认 0，表示一直等——很大的会话压缩几分钟是正常的。填入秒数后，超时会取消这次压缩并提示你。":
    "0 by default, meaning no limit — a very large session can legitimately take minutes. Once set, an overrunning compression is cancelled and reported.",
  "上下文用到多少时开始压缩。": "How full the context gets before compression starts.",
  "可调 50–100%，默认 95%。": "Adjustable 50–100%; default 95%.",
  "每轮结束后，找出值得长期记住的偏好与约定。":
    "After each turn, look for preferences and conventions worth remembering.",
  "用当前模型提取候选，必须经你确认才会写入记忆；每轮会多消耗一次 token。":
    "The current model proposes candidates; nothing is written until you confirm. Costs one extra call per turn.",
  "记忆提取最多等多久。": "How long to wait for memory extraction.",
  "保存在 VSCode 用户设置里，可随 VSCode 设置同步。":
    "Stored in your VSCode user settings and carried by VSCode Settings Sync.",
  "以标准为基准：紧凑约 0.92 倍，大约 1.1 倍。":
    "Standard is the baseline: compact ≈0.92×, large ≈1.1×.",
  "调整控件之间的间距，不改字号。": "Adjusts spacing between controls; text size stays the same.",
  "以标准为基准：紧凑约 0.92 倍，宽松约 1.12 倍。":
    "Standard is the baseline: compact ≈0.92×, comfortable ≈1.12×.",
  "面板不在前台时，用系统通知提醒你。":
    "Send a system notification when the panel is not in the foreground.",
  "仅等待你处理时": "Only when you're needed",
  "每轮完成时": "When each turn finishes",
  "停止生成（在审批卡上为拒绝）": "Stop generating (rejects on an approval card)",
  "背景光晕的浓淡：0 为关闭，100 最亮。":
    "How strong the background glow is: 0 turns it off, 100 is brightest.",
  "只影响新会话；当前会话可在输入框下方的模式菜单里切换。":
    "New sessions only; switch the current one from the mode menu below the composer.",
  "内核启动时使用的审批模式。": "The approval mode the Core starts with.",
  "与上面的面板默认模式互不影响；保存后重启内核生效。":
    "Independent of the panel default above; applies after a Core restart.",
  "窗口打开时提前启动内核，首次打开面板不用等。":
    "Start the Core ahead of time when a window opens, so the first panel open is instant.",
  "每个窗口约 100MB 内存；下次窗口启动生效。":
    "About 100MB per window; takes effect on the next window start.",
  "没有可恢复的记录时会新建会话。": "Falls back to a new session when nothing is restorable.",
  "每轮对话前保存一份工作区快照，之后可以按轮回退。":
    "Save a workspace snapshot before each turn so you can roll back per turn.",
  "快照放在单独的目录里，不会动你的 Git 仓库。":
    "Snapshots live in a separate directory; your own Git repo is never touched.",
  "快照会占用磁盘空间，上限等参数在「高级」里调整。":
    "Snapshots take disk space; limits and other options are under「Advanced」.",
  "工作区文件超过这个数量就不再保存快照。":
    "Stop taking snapshots when the workspace has more files than this.",
  "快照存放在哪里。": "Where snapshots are stored.",
  "留空则用默认位置；支持 ~ 和相对路径。":
    "Leave empty for the default location; ~ and relative paths are supported.",
  "留空则自动查找。": "Leave empty to detect it automatically.",
  "配置名称（可选，默认用模型名）": "Profile name (optional; defaults to the model name)",
  "如 工作密钥、备用线路": "e.g. Work key, Backup route",
  "接口地址（Base URL）": "Endpoint (Base URL)",
  "这是正在使用的配置。正在生成或有子会话在跑，暂时不能保存。":
    "This is the profile in use. It cannot be saved while a turn is generating or a child session is running.",
  "配置与密钥以明文保存在本机 iFlow 配置中。编辑正在使用的配置会重新连接；编辑其他配置只是保存，不会切换。":
    "Profiles and keys are stored in plaintext in the local iFlow config. Editing the profile in use reconnects the session; editing another one only saves it.",
  "还没有 API 配置，暂时无法开始对话": "No API profile yet — chat is unavailable for now.",
  "正在重新连接…": "Reconnecting…",
  "点一下配置即可切换，当前会话会重新连接":
    "Click a profile to switch; the current session reconnects.",
  "还没有 API 配置": "No API profiles yet",
  "选一个服务商预设可自动填好接口地址，也可以手动填写任意兼容 OpenAI 的接口。":
    "Pick a provider preset to fill in the endpoint, or enter any OpenAI-compatible endpoint yourself.",
  "点击配置即可切换，当前会话会用新配置重新连接。配置与密钥以明文保存在本机 iFlow 配置中。":
    "Click a profile to switch; the current session reconnects with it. Profiles and keys are stored in plaintext in the local iFlow config.",
  "联网查官方资料，由当前模型提炼后补进下面的表。":
    "Search official docs online, then let the current model extract rows into the tables below.",
  "检索由面板直接发起，不占用当前会话；资料交给当前模型提炼一次（额外消耗 token）。只补充、不覆盖已有数据；资料里找不到依据的条目会被丢弃。":
    "The panel runs the search itself (no session involved) and asks the current model for one extraction pass (extra tokens). Existing rows are never overwritten; anything the sources cannot back is dropped.",
  "检索到的资料会交给当前模型提炼一次，额外消耗 token。":
    "The retrieved text goes to the current model for one extraction pass — extra tokens.",
  "每行写「模型名=上下文长度」，如 glm-4.6=200000；没列出的模型用默认值。":
    "One「model=context length」per line, e.g. glm-4.6=200000. Models not listed use the default.",
  "每行写「模型名=输入价,输出价」，单位为美元/百万 token，如 deepseek-v3=0.27,1.1。":
    "One「model=input price,output price」per line, in USD per million tokens, e.g. deepseek-v3=0.27,1.1.",
  "配置「{0}」和它的密钥会一起删除，无法恢复。":
    "Profile \"{0}\" and its key are deleted together, and this cannot be undone.",
  "连接模型服务": "Connect a model provider",
  "初次设置": "Getting started",
  "设置进度": "Setup progress",
  "连上模型服务就能开始对话，其他设置随时能在 ⚙ 里改。":
    "Connect a model provider to start chatting; everything else stays editable in ⚙.",
  "已保存（{0}），留空则不改": "Saved (…{0}) — leave empty to keep",
  "请填写 API Key": "Enter an API key",
  "保存后会用新配置重新连接。配置与密钥以明文保存在本机 iFlow 配置中。":
    "Saving reconnects with the new profile. Profiles and keys are stored in plaintext in the local iFlow config.",
  "这是新会话默认使用的模型，随时可以在面板顶部的模型菜单里切换。":
    "This is the default model for new sessions; switch it any time from the model menu in the panel header.",
  "正在连接并读取可用模型…": "Connecting and loading available models…",
  "暂时拿不到模型列表": "No model list available yet",
  "保存配置后会自动读取模型；也可以稍后在模型菜单里选择。":
    "Models load automatically once the profile is saved; you can also pick one later from the model menu.",
  "可以点下面的按钮再试一次。": "Use the button below to try again.",
  "返回填写配置": "Back to the profile form",
  "没有匹配的模型": "No matching models",
  "新会话默认用这个权限模式；点选后当前会话也会立即切换。之后可以在「设置 → 权限与审批」里细化规则。":
    "New sessions start in this mode; picking one also switches the current session. Fine-grained rules live in Settings → Permissions & approvals.",
  "可以开始对话了，其余设置在 ⚙ 里随时能改。":
    "You can start chatting now; the rest stays editable in ⚙.",
  "这几项可以稍后再配。": "These can be set up later.",
  "尚未配置（稍后可在设置里完成）": "Not configured (finish later in Settings)",
  "切换配置": "Switch profile",
  "切换到配置「{0}」后，当前对话要怎么处理？":
    "How should the current conversation be handled after switching to profile \"{0}\"?",
  "这段对话保留，用新配置接着聊": "Keep this conversation and continue with the new profile",
  "从一段空白对话重新开始": "Start over with a blank conversation",
  "每次询问": "Ask every time",
  "审批请求会从上往下匹配规则（项目规则优先），第一条命中的规则决定结果：自动允许、自动拒绝或每次询问。破坏性命令（如 rm、git push）永远不会被自动允许，即使命中规则也会先问你。":
    "Approval requests match rules top to bottom (project rules first); the first match decides: auto-allow, auto-deny, or ask. Destructive commands such as rm or git push are never auto-allowed — you are always asked first.",
  "还没有审批规则": "No approval rules yet",
  "项目内的规则（只读）": "Rules from the project (read-only)",
  "已命中 {0} 次": "Matched {0}×",
  "添加规则": "Add rule",
  "如 允许读取 src 目录": "e.g. Allow reading the src folder",
  "路径范围（相对工作区，支持通配）":
    "Path scope (relative to the workspace; globs allowed)",
  "命令开头（逗号分隔，仅对执行类生效）":
    "Command prefix (comma-separated; execute only)",
  "加入列表": "Add to list",
  "更新列表": "Update list",
  "所有条件都留空会匹配全部请求，请谨慎使用。这里的修改只作用于列表，点「保存」后才真正生效。":
    "Leaving every condition empty matches ALL requests — use with care. Edits only change the list; click Save to apply.",
  "删除规则「{0}」？点「保存」后才会真正生效。":
    "Delete rule \"{0}\"? It takes effect once you save.",
};

export function t(message: string, ...args: Array<string | number>): string {
  let out = isEnglish() ? (en[message] ?? message) : message;
  for (let i = 0; i < args.length; i++) {
    out = out.replaceAll(`{${i}}`, String(args[i]));
  }
  return out;
}

/**
 * W6: localized display for the CLI's permission modes (ids come from the
 * agent, names may be English) — label + one-line description per the design
 * spec. Lives next to the dictionary so a new mode id is added in ONE place.
 * Unknown ids fall back to the agent-provided name.
 */
export function modeDisplay(mode: { id: string; name: string }): { label: string; desc: string } {
  switch (mode.id) {
    case "smart":
      return { label: t("智能"), desc: t("iFlow 会自行判断风险，必要时才征求你的确认") };
    case "yolo":
      return { label: t("免确认"), desc: t("所有操作直接执行，不再询问") };
    case "default":
      return { label: t("标准"), desc: t("每次执行操作前都要你确认") };
    case "plan":
      return { label: t("规划"), desc: t("只读：只分析、出计划，不改动文件") };
    default:
      return { label: mode.name || mode.id, desc: "" };
  }
}
