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
  "本轮变更": "Changes this turn",
  "变更说明": "Changes-this-turn help",
  "1 个文件已更改": "1 file changed",
  "{0} 个文件已更改": "{0} files changed",
  "{0} 次修改": "{0} edits",
  "仅列出已记录的工具差异文件，不保证覆盖全部磁盘修改或代表当前净变更。点击文件在编辑器中打开。": "Lists files with recorded tool diffs; may not cover all disk changes or the current net change. Click a file to open it in the editor.",
  "在编辑器中打开": "Open in editor",
  "撤销此文件的本轮修改": "Undo this file's changes from this turn",
  "该轮次已不可用。": "This turn is no longer available.",
  "正在读取本轮变更…": "Loading turn changes…",
  "本轮没有可展示的变更记录；这不表示没有文件修改。": "No change records are available for this turn; files may still have changed.",
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
  "MCP 外部工具": "External MCP tool",
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
  "已截断 {0} 字符": "Truncated {0} chars",
  "仅渲染前 {0} 字符": "Rendering first {0} chars only",
  "复制全部": "Copy all",
  "查看完整输出": "View full output",
  "标记完成": "Mark done",
  "取消勾选": "Uncheck",
  "打开 API 设置": "Open API settings",
  "打开运行时设置": "Open runtime settings",
  "检查 API Key 是否有效、账户余额/额度是否充足，或在设置中切换到其他 API 配置后重试":
    "Check that the API key is valid and the account has remaining balance/quota, or switch to another API profile in Settings and retry",
  "本机网络或代理不可达，检查网络连接与代理设置后点击重试":
    "The local network or proxy is unreachable — check connectivity/proxy settings, then hit retry",
  "当前模型可能已下架或不支持该能力，在设置中重新选择可用模型后重试":
    "The current model may be delisted or lacks this capability — pick an available model in Settings and retry",
  "扩展包不完整或内置 CLI 文件被安全软件删除，重新安装扩展后重启窗口即可恢复":
    "The extension package is incomplete or the bundled CLI was removed by security software — reinstall the extension and reload the window",
  "平台速率限制持续触发，可稍候片刻再重试，或在设置中切换到其他模型 / API 配置":
    "The platform rate limit keeps triggering — wait a moment and retry, or switch to another model / API profile in Settings",
  "上下文已超出模型上限且自动压缩未能恢复，可发送 /compress 再次压缩，或开启新会话后继续":
    "Context exceeded the model limit and auto-compression did not recover it — send /compress to compact again, or start a new session",
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
  "回滚本轮": "Roll back this turn",
  "回滚本轮（文件与对话）": "Roll back this turn (files and conversation)",
  "有什么可以帮你?": "What can I help with?",
  "输入 / 查看命令 · @  引用文件": "Type / for commands, @ to reference files",
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
  "检测到 iFlow CLI 已有凭据": "Existing iFlow CLI credentials detected",
  "可从 ~/.iflow/settings.json 导入为扩展配置；密钥写入 SecretStorage 后由面板管理。":
    "Import them as extension profiles from ~/.iflow/settings.json; the key is stored in SecretStorage and managed by the panel.",
  "导入并激活": "Import & activate",
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
  "欢迎": "Welcome",
  "连接模型": "Connect a model",
  "选择模型": "Choose a model",
  "使用偏好": "Preferences",
  "第 {0} / {1} 步": "Step {0} of {1}",
  "跳过引导": "Skip setup",
  "开始配置": "Get started",
  "上一步": "Back",
  "稍后配置": "Later",
  "保存并继续": "Save & continue",
  "开始使用": "Start using",
  "欢迎使用 心流·驭光": "Welcome to iFlow Harness",
  "用一到两分钟完成最初配置。随时可以跳过，跳过后仍可从设置或面板提示重新配置。":
    "Set things up in a minute or two. You can skip at any time and reconfigure later from settings or the panel prompt.",
  "对话即工作台": "One panel for the whole job",
  "流式对话、工具审批、逐块回滚都在一个面板里。":
    "Streaming chat, tool approvals, and per-hunk rollback all live in one panel.",
  "凭据只在本机": "Credentials stay local",
  "API Key 存入 VSCode SecretStorage，不写入磁盘明文。":
    "API keys are stored in VSCode SecretStorage, never as plaintext on disk.",
  "随时可改": "Change anything later",
  "服务商、模型、权限与界面偏好都能在设置中调整。":
    "Provider, model, approval mode, and UI preferences can all be adjusted in settings.",
  "尚未选择": "Not selected",
  "尚未配置（可稍后在设置中完成）": "Not configured (finish later in settings)",
  "选择默认使用的模型；随时可以在面板顶部的模型下拉中切换。":
    "Pick the default model. You can switch at any time from the model dropdown in the panel header.",
  "正在连接 iFlow CLI 并获取模型列表…": "Connecting to iFlow CLI and fetching models…",
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
  "这些设置之后都能在齿轮 ⚙ 设置中随时修改。":
    "Everything here can be changed later from the ⚙ settings.",
  "提示音": "Sound",
  "回复完成或失败时播放提示音。": "Play a cue when a reply finishes or fails.",
  "默认权限模式": "Default approval mode",
  "新会话使用的权限模式；当前会话可用输入框下方的模式菜单切换。":
    "Approval mode for new sessions; switch the current session from the mode menu below the composer.",
  "审批说明": "Approval help",
  "允许会立即执行该工具；「始终允许」会在本次会话内记住该工具。":
    "Allow runs the tool immediately; \"Always allow\" remembers it for this session.",
  "拒绝或取消都不会执行；可在设置 → 审批策略中预审规则。":
    "Reject or cancel never runs it. Pre-review rules live in Settings → Approval policies.",
  "Y 允许一次 · N 拒绝 · Esc 取消": "Y allow once · N reject · Esc cancel",
  "Y 允许一次 · N/Esc 拒绝": "Y allow once · N/Esc reject",
  "计划说明": "Plan help",
  "Plan 模式只读分析与规划；批准后会退出 Plan 模式并开始执行。":
    "Plan mode is read-only analysis and planning; approving exits Plan mode and starts execution.",
  "批准的计划会保存到 .iflow/specs/ 以便留痕。":
    "Approved plans are saved under .iflow/specs/ for later review.",
  "编辑后的内容仅在「重新规划」时发送给 agent；「批准计划」执行原计划。":
    "Edits are sent to the agent only when you choose Re-plan; Approve executes the original plan.",
  "Y 批准 · N 拒绝 · R 重新规划": "Y approve · N reject · R re-plan",
  "提问说明": "Question help",
  "agent 正在等待你的回答；卡片未回答前其他操作会被阻塞。":
    "The agent is waiting for your answer; other actions stay blocked until this card is answered.",
  "超时未回答会按未回答继续。": "If it times out, the agent continues as if unanswered.",
  // pending-card convergence (milestone 14 §4.5)
  "约 {0} 分钟后{1}": "{1} in about {0} min",
  "自动继续": "Auto-continue",
  "允许一次": "Allow once",
  "始终允许": "Always allow",
  "拒绝": "Reject",
  "始终拒绝": "Always reject",
  "iFlow 请求执行": "iFlow wants to",
  "读取": "read",
  "写入": "write",
  "搜索": "search",
  "执行": "execute",
  "移动": "move",
  "读取网页": "fetch a page",
  "不回答并继续": "Continue without answering",
  "回车只确认该输入；「提交回答」按钮或 Ctrl/Cmd + 回车提交整卡。":
    "Enter confirms just that field; the Submit answer button or Ctrl/Cmd+Enter commits the whole card.",
  "保存并重新规划": "Save and re-plan",
  "快捷键": "Keyboard shortcuts",
  "停止生成（审批卡中为取消/拒绝）": "Stop generating (cancels/rejects on an approval card)",
  "审批允许 / 拒绝": "Approve / reject",
  "计划批准 / 拒绝 / 重新规划": "Plan approve / reject / re-plan",
  "上一个 / 下一个会话": "Previous / next session",
  "聚焦输入框": "Focus the composer",
  "切换 Focus 视图": "Toggle Focus view",
  "每轮回复后推测可选的下一步操作（会产生额外 token 消耗）。":
    "Suggest next steps after each reply (uses extra tokens).",
  "上下文占用达到 95% 时自动压缩会话。": "Compress the session automatically at 95% context usage.",
  "每轮结束后提取长期偏好候选，确认后才写入。":
    "Extract long-term preference candidates after each turn; nothing is written until you confirm.",
  "调整面板中文字的大小。": "Adjust the panel text size.",
  "调整控件内边距与间距，不影响字号。": "Adjust control padding and spacing without changing font size.",
  "默认跟随编辑器主题，也可以固定为浅色或深色。":
    "Follow the editor theme by default, or pin light/dark.",
  "配置完成": "You're all set",
  "可以开始对话了；所有设置都能随时在齿轮 ⚙ 中修改。":
    "You can start chatting now; everything remains editable from the ⚙ settings.",
  "连接": "Connection",
  "默认模式": "Default mode",
  "已开启": "On",
  "已关闭": "Off",
  "字号 / 密度": "Font / density",
  "继续配置": "Continue configuring",
  "这些高级能力可以稍后再设置。": "These advanced capabilities can be set up later.",
  "尚未配置 API 凭据，无法开始对话。": "API credentials are not configured yet — chat is unavailable.",
  "配置": "Configure",
  "重新运行引导": "Run setup again",
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
  "两级同名时 CLI 用项目级配置整体替换全局条目（不合并字段）":
    "For a name present in both scopes the CLI replaces the global entry with the project one wholesale (fields are not merged)",
  "全局读写 ~/.iflow/settings.json 的 mcpServers 字段；保存后点击底部「重启 CLI」生效（当前会话自动恢复）。":
    "The global scope reads/writes the mcpServers field in ~/.iflow/settings.json; after saving, click Restart CLI in the footer to apply (the current session restores automatically).",
  "项目级读写 <工作区>/.iflow/settings.json 的 mcpServers 字段；与全局同名时 CLI 用项目条目整体替换全局条目（不合并字段）。保存后点击底部「重启 CLI」生效。":
    "The project scope reads/writes the mcpServers field in <workspace>/.iflow/settings.json; for a name also present globally, the CLI replaces the global entry with the project one wholesale (fields are not merged). After saving, click Restart CLI in the footer to apply.",
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
  "/ 命令 · @ 文件/文件夹 · @problems · @git · @terminal · @url:":
    "/ commands · @ files/folders · @problems · @git · @terminal · @url:",
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
  "自动注入": "Auto-injected",
      "核心提示词": "Core prompt",
      "记忆": "Memory",  "上下文文件": "Context files",
      "{0} 个项目记忆文件": "{0} project memory file(s)",
      "{0} 个知识库文档": "{0} knowledge doc(s)",
      "MCP 未连接": "MCP not connected",
      "未随请求注入": "Not injected with the request",
  "{0} 字符": "{0} chars",
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
  "正在启动 iFlow…": "Starting iFlow…",
  "首次启动或配置了多个 MCP server 时较久":
    "Slower on first launch or with multiple MCP servers",
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
  // turn-end next-step suggestions + General settings tab
  "通用": "General",
  "下一步": "Next",
  "AI 推测的下一步操作，点击填入输入框": "AI-predicted next actions — click to insert into the composer",
  "关闭建议": "Dismiss suggestions",
  "预测下一步操作…": "Predicting next steps…",
  "下一步建议": "Next-step suggestions",
  "每轮回复完成后单独调用一次模型，推测可选的下一步操作并显示在输入框上方（会产生额外 token 消耗）。":
    "After each completed turn, make one extra model call to predict likely next actions and show them above the composer (extra token usage).",
  "默认开启。关闭后不再发起该模型调用，已显示的候选会被清除。":
    "Enabled by default. When off, no extra call is made and any displayed candidates are cleared.",
  "自动压缩上下文": "Auto-compress context",
  "每轮回复结束后，若上下文占用达到 95%，自动压缩会话后再继续下一轮（会产生一次压缩轮次）。":
    "After a turn settles, if context occupancy reaches 95%, compress the conversation before continuing the next turn (one extra compress turn).",
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
  "回合结束后": "After each turn",
  "可能产生额外的模型调用": "May make extra model calls",
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
  "CLI 默认审批模式": "CLI default approval mode",
  "写入 ~/.iflow/settings.json；与面板默认模式相互独立，修改后重启 CLI 生效。":
    "Written to ~/.iflow/settings.json; independent of the panel default and applied after a CLI restart.",
  "不覆写": "Do not override",
  "启动与会话": "Startup & sessions",
  "后台预热 CLI": "Warm up the CLI",
  "窗口打开时在后台启动 CLI，首次打开面板无需等待（每窗口约 100MB 内存）。下次窗口启动生效。":
    "Start the CLI in the background when a window opens so the first panel open is instant (about 100MB per window). Takes effect on the next window start.",
  "恢复上次会话": "Restore last session",
  "面板启动时恢复上次使用的会话；无可恢复记录时新建会话。":
    "Restore the last used session when the panel starts; fall back to a new session when nothing is restorable.",
  "启动时自动打开面板": "Open the panel on startup",
  "VSCode 启动时自动打开聊天面板。下次启动生效。":
    "Open the chat panel automatically when VSCode starts. Takes effect on the next start.",
  "CLI 运行时": "CLI runtime",
  "重启 CLI 生效": "Takes effect after a CLI restart",
  "Node.js 路径": "Node.js path",
  "留空自动探测；修改后重启 CLI 生效。": "Leave empty to auto-detect; restart the CLI after changing.",
  "CLI 语言": "CLI language",
  "写入 ~/.iflow/settings.json；修改后重启 CLI 生效。":
    "Written to ~/.iflow/settings.json; takes effect after a CLI restart.",
  "跟随 CLI": "Leave to the CLI",
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
  "MCP 服务器配置保存在 ~/.iflow/settings.json，由 CLI 读取；不随 VSCode 设置同步。":
    "MCP server configuration lives in ~/.iflow/settings.json and is read by the CLI; it is not part of VSCode Settings Sync.",
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
  "JSON 数组，每项含 pattern / supportsThinking 等字段；保存后同步到 ~/.iflow/thinking-models.json，重启 CLI 生效。":
    "JSON array of rules with pattern / supportsThinking; saved to ~/.iflow/thinking-models.json and applied after a CLI restart.",
  "应用": "Apply",
  "JSON 格式无效": "Invalid JSON",
  "条目必须是数组": "The value must be an array",
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
  "当前 CLI 不会加载此文件": "The current CLI does not load this file",
  "删除这条记忆": "Delete this memory",
  "还有 {0} 条…": "{0} more…",
  "记忆在新建会话或恢复会话时加载。当前会话需要重启 CLI 才会读取新内容。":
    "Memory is loaded when a new session is created or a session is restored. The current session only sees new content after the CLI restarts.",
  "重新加载": "Reload",
  "{0} 字符 · ≈{1} tokens": "{0} chars · ≈{1} tokens",
  "已保存 {0}": "Saved {0}",
  "新建会话或重启 CLI 后生效": "Takes effect after a new session or CLI restart",
  "以下是 CLI 每次请求都会自动注入的记忆文件。内容会随请求发送给模型，请勿写入密钥。":
    "These are the memory files the CLI injects into every request. Their content is sent to the model — do not store secrets here.",
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
  "保存后新建会话或重启 CLI 生效": "Takes effect after a new session or CLI restart",
  "请先创建项目记忆文件": "Create a project memory file first",
  "新建会话": "New session",
  "重启 CLI 使记忆生效": "Restart CLI to apply memory",
  "重启 CLI 并恢复当前会话，使记忆立即生效":
    "Restart the CLI and restore the current session so memory applies immediately",
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
