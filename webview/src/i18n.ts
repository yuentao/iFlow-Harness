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

/** True when the current locale is English (used for brand-name display). */
export function isEnglishLocale(): boolean {
  return isEnglish();
}

const en: Record<string, string> = {
  // loading / topbar
  "连接中…（iFlow CLI 启动可能需要十几秒，配置了多个 MCP server 时更久）":
    "Connecting… (iFlow CLI startup can take 10+ seconds, longer with multiple MCP servers)",
  "历史会话（选择后恢复该会话上下文）": "Recent sessions (pick one to restore its context)",
  "当前会话": "Current session",
  "API 配置（点击切换后重新认证）": "API profile (click to switch, re-authenticates)",
  "权限模式": "Permission mode",
  "智能": "Smart",
  "AI 评估风险后决定是否确认": "AI weighs the risk before running tools",
  "免确认": "Auto-approve",
  "所有工具直接执行": "Tools run without confirmation",
  "标准": "Standard",
  "执行前均需确认": "Confirm before every execution",
  "规划": "Plan",
  "只读，仅分析与规划": "Read-only — analyze and plan only",
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
  "错误": "Error",
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
  "重发将先回滚该轮文件变更并删除其后的对话": "Resending first restores this turn's file snapshot, then deletes the conversation after it",
  "重发将删除该消息及其后所有对话": "Resending deletes this message and everything after it",
  // turn-level checkpoint rollback (M3 P0-1)
  "回滚到此轮之前": "Roll back to before this turn",
  "文件": "Files",
  "对话": "Chat",
  "全部": "Both",
  "仅回滚工作区文件到本轮之前": "Restore workspace files to before this turn",
  "仅删除该消息及其后所有对话": "Delete this message and everything after it",
  "回滚文件并删除该消息及其后所有对话": "Restore files and delete this message and everything after it",
  "该轮快照不完整，无法恢复文件": "This turn's snapshot is incomplete; files cannot be restored",
  "选择回滚范围：文件恢复到此轮之前、删除该消息及其后对话，或两者都要。":
    "Choose the rollback scope: restore files to before this turn, delete this message and everything after it, or both.",
  "该轮快照不完整，无法恢复文件，只能删除该消息及其后所有对话。":
    "This turn's snapshot is incomplete; files cannot be restored — you can only delete this message and everything after it.",
  "确定清空队列中全部 {0} 条待发送消息吗？": "Clear all {0} queued messages?",
  // tool cards / message list
  "已完成": "Completed",
  "失败": "Failed",
  "等待执行": "Waiting",
  "执行中": "Running",
  "操作输出": "Output",
  "执行参数": "Execution details",
  "查看原始参数": "View raw details",
  "收起原始参数": "Hide raw details",
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
  // long-session memory eviction markers
      "内容已释放": "Content released",
      "加载剩余 {0} 行": "Load remaining {0} rows",  "附件图片已释放": "Attached images released",
  "为控制长会话内存，该块的输出与差异已自 webview 内存释放；回退与导出仍由 host 完整保留":
    "Released from webview memory to bound long-session usage; revert & export stay complete on the host",
  "为控制长会话内存，附件图片已自 webview 内存释放；host 仍保留完整记录":
    "Attached images released from webview memory to bound long-session usage; the host keeps the full record",
  "回退此改动": "Revert this change",
  "已回退": "Reverted",
  "部分回退": "Partially reverted",
  "保留": "Keep",
  "回退": "Revert",
  "改动 {0}/{1}": "Change {0}/{1}",
  "应用（保留 {0} · 回退 {1}）": "Apply (keep {0} · revert {1})",
  "全部保留": "Keep all",
  "保留此改动": "Keep this change",
  "回退此改动（恢复为编辑前内容）": "Revert this change (restore pre-edit content)",
  "将回退的块恢复为编辑前内容，保留其余改动": "Restore reverted hunks to their pre-edit content, keeping the rest",
  "文件对比": "File diff",
  "任务清单": "Task list",
  "运行中": "Running",
  "子代理": "Subagent",
  "停止此子代理": "Stop this subagent",
  "已停止": "Stopped",
  "tokens": "tokens",
  "耗时": "Duration",
  "只读转录": "Read-only transcript",
  "子代理 token 为转录估算，包含子代理": "Estimated transcript tokens, including child agents",
  "启动子代理（{0}）：{1}": "Launch agent ({0}): {1}",
  "读取 {0}": "Reading {0}",
  "运行：{0}": "Running: {0}",
  "更新任务清单": "Updating todos",
  "正在恢复历史会话…": "Restoring session…",
  "正在创建新会话…": "Creating new session…",
  "删除会话 {0}": "Delete session {0}",
  // M4 P1-8 session pin & archive
  "置顶": "Pin",
  "取消置顶": "Unpin",
  "归档": "Archive",
  "取消归档": "Unarchive",
  "已归档（{0}）": "Archived ({0})",
  // composer
  "发送": "Send",
  "停止": "Stop",
  // settings modal (unified: API profiles / MCP / approval policies)
  "设置": "Settings",
  "API 配置": "API profiles",
  "已保存（{0}）— 留空保持不变": "saved (…{0}) — leave empty to keep",
  "Base URL 必须以 http:// 或 https:// 开头": "Base URL must start with http:// or https://",
  "API Key 不能为空": "API key is required",
  "模型名称不能为空": "Model name is required",
  "连接 iFlow 需要配置 API 凭据": "Connect to iFlow by configuring API credentials",
  "收起": "Collapse",
  "展开": "Expand",
  "复制错误信息": "Copy error message",
  "已复制": "Copied",
  "扩展": "Extension",
  "CLI": "CLI",
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
  "保存并激活": "Save & activate",
  "打开 VSCode 设置…": "Open VSCode Settings…",
  "重启 CLI": "Restart CLI",
  "重启 CLI 进程（会话自动恢复），语言 / 审批模式 / MCP 等设置重启后生效":
    "Restart the CLI process (the session restores automatically); language / approval-mode / MCP settings take effect after the restart",
  "点击配置即切换并重新认证会话；来自 iFlow CLI 的配置为只读，可切换但不可在此删除。":
    "Click a profile to switch and re-authenticate the session. Profiles imported from the iFlow CLI are read-only: you can switch to them but not delete them here.",
  "凭据保存在 VSCode SecretStorage，不写入磁盘明文；保存后将以 openai-compatible 方式重新认证会话。":
    "Credentials are stored in VSCode SecretStorage, never in plaintext on disk. Saving re-authenticates the session via openai-compatible.",
  "这是只读的 CLI 配置；保存将另存为同名的扩展配置并优先使用它。":
    "This is a read-only CLI profile; saving creates an extension-owned profile with the same name that takes precedence.",
  "正在重新认证…": "Re-authenticating…",
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
  "配置 JSON（stdio：command/args/env；远程：url/headers/type）":
    "Config JSON (stdio: command/args/env; remote: url/headers/type)",
  "名称不能为空": "Name cannot be empty",
  "JSON 格式不合法": "Invalid JSON",
  "配置必须是 JSON 对象": "Config must be a JSON object",
  "名称重复：{0}": "Duplicate name: {0}",
  "编辑只改本地副本，点击「保存」才写入文件。":
    "Editing only changes a local copy; click Save to write the file.",
  "配置直接读写 ~/.iflow/settings.json 的 mcpServers 字段；保存后点击底部「重启 CLI」生效（当前会话自动恢复）。":
    "Config reads/writes the mcpServers field in ~/.iflow/settings.json directly; after saving, click Restart CLI in the footer to apply (the current session restores automatically).",
  "保存中…": "Saving…",
  // MCP status indicators + detail sub-page
  "状态未知": "Status unknown",
  "已禁用": "Disabled",
  "已屏蔽": "Blocked",
  "已连接": "Connected",
  "连接中…": "Connecting…",
  "未连接": "Not connected",
  "状态不可获取": "Status unavailable",
  "连接状态不可获取（CLI 未连接或状态上报未启用）":
    "Connection status unavailable (CLI not connected, or status reporting not enabled)",
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
  "推理级别": "Reasoning",
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
  "向 iFlow 提问…（/ 命令 · @ 文件 · @/ 文件夹 · @problems · @git · @url:）":
    "Ask iFlow… (/ commands · @ files · @/ folders · @problems · @git · @url:)",
  "（见附件）": "(see attached files)",
  "（见附带的上下文）": "(see attached context)",
  "工作区诊断（Problems）": "Workspace diagnostics (Problems)",
  "Git 状态与变更": "Git status & changes",
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
  "确定删除「{0}」吗？保存后将从 CLI 配置中移除。":
    "Delete \"{0}\"? It will be removed from the CLI configuration when saved.",
  "输入框非空，已放弃回填（队列条目仍在）":
    "Composer is not empty — refill dropped (the queue entry is still there)",
  "排队发送 (Enter)": "Queue (Enter)",
  "生成中 · Enter 排队发送": "Generating · Enter to queue",
  "规划中 · Enter 排队发送": "Planning · Enter to queue",
  "压缩中 · Enter 排队发送": "Compressing · Enter to queue",
  "排队": "Queue",
  "添加附件": "Add attachments",
  "{0} 个文件超过大小上限（50MB），已跳过": "Skipped {0} file(s) over the 50 MB limit",
  "{0} 个文件暂存失败，已跳过": "Failed to stage {0} file(s) — skipped",
  "停止生成": "Stop generating",
  "发送 (Enter)": "Send (Enter)",
  "当前上下文 {0} tokens（CLI 上报）": "Current context {0} tokens (reported by CLI)",
  "当前上下文约 {0} tokens（host 估算，压缩后按压缩上下文重算）":
    "Current context ≈ {0} tokens (host estimate; recomputed from the compressed context after compression)",
  "输入 {0} tokens · 输出 {1} tokens": "Input {0} tokens · output {1} tokens",
  "当前上下文约 {0} tokens（host 估算，压缩后按压缩上下文重算）· 输出 {1}":
    "Current context ≈ {0} tokens (host estimate; recomputed from the compressed context after compression) · output {1}",
  "当前上下文（用户消息与工具结果，压缩后重算）": "Current context (user messages & tool results; recomputed after compression)",
  "输出（回复与思考）": "Output (replies & thinking)",
  // message list
  "在 VSCode diff 视图中查看该变更": "Open this change in the VSCode diff view",
  "将该文件恢复为编辑前内容": "Revert this file to its pre-edit content",
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
  "/ 命令 · @ 文件 · @problems · @git · 粘贴文件添加附件":
    "/ commands · @ files · @problems · @git · paste to attach",
  // P0-3: splash patience line & error toast actions
  "等待时间偏长：可能是 MCP 服务器连接缓慢或网络不可达":
    "Taking longer than usual — an MCP server may be slow to connect or the network is unreachable",
  "重启 CLI 并重试（会话自动恢复）": "Restart the CLI and retry (the session restores automatically)",
  "关闭": "Dismiss",
  "回到最新": "Jump to latest",
  "展开上下文": "Expand context",
  "拖放文件以添加附件": "Drop files to attach",
  "拖拽调整高度": "Drag to resize",
  "展开更早 {0} 条消息": "Show {0} earlier messages",
  "显示更早 {0} 条": "Show {0} earlier steps",
  "上下文摘要": "Context summary",
      "系统提示词": "System prompt",
      "核心提示词": "Core prompt",
      "记忆": "Memory",  "上下文文件": "Context files",
  "{0} 字符": "{0} chars",
  "{0} 字节": "{0} bytes",
  "diff": "diff",
  // composer / message list (additional — new entries only)
  "复制": "Copy",
  "重新生成": "Regenerate",
  "正在启动 iFlow…（首次启动或配置了多个 MCP server 时较久）":
    "Starting iFlow… (slower on first launch or with multiple MCP servers)",
  // P1: edit & resend, session search, aria-live announcements
  "编辑并重发": "Edit & resend",
  "搜索会话…": "Search sessions…",
  "需要审批工具调用": "Tool approval required",
  "有待回答问题需要回答": "Question needs answering",
  "等待选择切换 API 配置的会话处理方式": "Choose how the session is handled when switching API profiles",
  "自定义回答": "Custom answer",
  "其他": "Other",
  "正在连接 iFlow…": "Connecting to iFlow…",
  "正在生成回复…": "Generating response…",
  "正在规划…": "Planning…",
  "正在压缩上下文…": "Compressing context…",
  "已停止生成": "Generation stopped",
  "已就绪": "Ready",
  // Plan-mode exit confirmation card
  "iFlow 请求退出 Plan 模式": "iFlow wants to exit Plan mode",
  "退出 Plan 模式后将开始执行以下计划：": "The following plan will be executed once Plan mode is exited:",
  "批准计划": "Approve plan",
  "拒绝计划": "Reject plan",
  "重新规划": "Re-plan",
  "编辑计划": "Edit plan",
  "预览计划": "Preview plan",
  "编辑": "Edit",
  "预览": "Preview",
  "计划审批操作": "Plan approval actions",
  "需要确认退出计划模式": "Plan exit needs confirmation",
  // render-error fallback (ErrorBoundary)
  "重试": "Retry",
  "界面渲染异常": "Interface rendering error",
  "界面渲染时遇到异常。重新载入面板即可恢复；也可以直接重试。":
    "The interface hit a rendering error. Reload the panel to recover, or just retry.",
  "消息区渲染异常": "Message area rendering error",
  "内容渲染时遇到异常，将在下一次更新时自动重试。":
    "Content hit a rendering error — it will retry automatically on the next update.",
  // M1: Focus view, context occupancy, cost, prompt enhancement
  "Focus 视图": "Focus view",
  "Focus 视图：只看对话，折叠工具与思考（Ctrl+Alt+F）":
    "Focus view: conversation only, tools and thoughts collapsed (Ctrl+Alt+F)",
  "退出 Focus 视图（Ctrl+Alt+F）": "Exit Focus view (Ctrl+Alt+F)",
  "上下文占用 {0} / {1}（{2}%{3}{4}）": "Context {0} / {1} ({2}%{3}{4})",
  "，窗口为估算值": ", window is an estimate",
  "，占用为 CLI 上报值": ", occupancy reported by the CLI",
  "当前上下文 {0} tokens（CLI 上报）· 输出 {1}（估算）":
    "Context {0} tokens (reported by the CLI) · output {1} (estimated)",
  "用户 {0} · 助手 {1} · 工具 {2} · 思考 {3}": "User {0} · assistant {1} · tools {2} · thoughts {3}",
  "缓存读取 {0} tokens": "Cache read {0} tokens",
  "预估成本 {0}（按公开单价估算）": "Estimated cost {0} (at published prices)",
  "该模型无单价记录，不显示成本": "No unit price recorded for this model — no cost shown",
  "上下文窗口占用": "Context window occupancy",
  "预估成本（token 估算 × 公开单价，仅供参考）": "Estimated cost (token estimate × published prices, indicative only)",
  "增强提示词（AI 改写为更清晰的请求）": "Enhance prompt (AI rewrites it into a clearer request)",
  "正在增强，点击取消": "Enhancing… click to cancel",
  "已取消增强": "Enhancement cancelled",
  "输入已修改，已放弃增强结果": "Input changed — enhancement result discarded",
  "还原原始输入": "Restore the original input",
  "已增强输入（再次点击增强可还原）": "Prompt enhanced (click Enhance again to restore)",
  "已还原原始输入": "Original input restored",
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
      return { label: t("智能"), desc: t("AI 评估风险后决定是否确认") };
    case "yolo":
      return { label: t("免确认"), desc: t("所有工具直接执行") };
    case "default":
      return { label: t("标准"), desc: t("执行前均需确认") };
    case "plan":
      return { label: t("规划"), desc: t("只读，仅分析与规划") };
    default:
      return { label: mode.name || mode.id, desc: "" };
  }
}
