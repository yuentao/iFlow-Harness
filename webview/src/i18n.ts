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
  "新会话": "New session",
  "API 凭据配置": "API credentials",
  "切换到浅色主题": "Switch to light theme",
  "切换到深色主题": "Switch to dark theme",
  "心流·驭光": "iFlow Harness",
  "连接中": "Connecting",
  "就绪": "Ready",
  "正在生成": "Generating",
  "错误": "Error",
  "管理配置与凭据…": "Manage profiles & credentials…",
  "会话历史": "Session history",
  // approval card
  "工具执行审批": "Tool execution approval",
  "iFlow 请求执行工具": "iFlow requests to run a tool",
  "取消": "Cancel",
  // tool cards / message list
  "已完成": "Completed",
  "失败": "Failed",
  "执行中": "Running",
  "操作输出": "Output",
  "回退此改动": "Revert this change",
  "已回退": "Reverted",
  "文件对比": "File diff",
  "任务清单": "Task list",
  "运行中": "Running",
  "子智能体日志": "SubAgent log",
  "启动子代理（{0}）：{1}": "Launch agent ({0}): {1}",
  "读取 {0}": "Reading {0}",
  "运行：{0}": "Running: {0}",
  "更新任务清单": "Updating todos",
  "正在恢复历史会话…": "Restoring session…",
  "正在创建新会话…": "Creating new session…",
  "删除会话 {0}": "Delete session {0}",
  // composer
  "发送": "Send",
  "停止": "Stop",
  // auth card
  "已保存（{0}）— 留空保持不变": "saved (…{0}) — leave empty to keep",
  "Base URL 必须以 http:// 或 https:// 开头": "Base URL must start with http:// or https://",
  "模型名称不能为空": "Model name is required",
  "API 配置": "API profiles",
  "连接 iFlow 需要配置 API 凭据": "Connect to iFlow by configuring API credentials",
  "收起": "Collapse",
  "API 配置（点击切换，切换后重新认证会话）": "API profiles (click to switch; switching re-authenticates the session)",
  "扩展": "Extension",
  "CLI": "CLI",
  "删除 {0}": "Delete {0}",
  "新增 / 更新配置": "Add / update profile",
  "配置名称（可选，默认为模型名）": "Profile name (optional, defaults to the model name)",
  "如 BUZZ、工作密钥…": "e.g. BUZZ, work key…",
  "Base URL（OpenAI 兼容）": "Base URL (OpenAI-compatible)",
  "模型名称": "Model name",
  "如 glm-5.3-flash-free": "e.g. glm-5.3-flash-free",
  "保存并激活": "Save & activate",
  "凭据保存在 VSCode SecretStorage，不写入磁盘明文；保存/切换后将以 openai-compatible 方式重新认证会话。来自 iFlow CLI 的配置为只读，可点击切换但不可在此删除。":
    "Credentials are stored in VSCode SecretStorage, never in plaintext on disk. Saving/switching re-authenticates the session via openai-compatible. Profiles imported from the iFlow CLI are read-only: you can switch to them but not delete them here.",
  // composer
  "（见附图）": "(see attached image)",
  "移除": "Remove",
  "Tab 补全": "Tab to complete",
  "无匹配文件": "No matching files",
  "向 iFlow 提问…（/ 命令 · @ 文件 · 粘贴或 📎 添加图片/文件）":
    "Ask iFlow… (/ commands · @ files · paste or 📎 attach images/files)",
  "（见附件）": "(see attached files)",
  "添加附件": "Add attachments",
  "{0} 张图片超过大小上限（5MB），已跳过": "Skipped {0} image(s) over the 5 MB limit",
  "{0} 个文件超过大小上限（50MB），已跳过": "Skipped {0} file(s) over the 50 MB limit",
  "{0} 个文件暂存失败，已跳过": "Failed to stage {0} file(s) — skipped",
  "停止生成": "Stop generating",
  "发送 (Enter)": "Send (Enter)",
  // message list
  "在 VSCode diff 视图中查看该变更": "Open this change in the VSCode diff view",
  "将该文件恢复为编辑前内容": "Revert this file to its pre-edit content",
  "输出": "Output",
  "思考过程": "Thinking",
  "附件图片 {0}": "Attached image {0}",
  "在 VSCode 中打开": "Open in VSCode",
  "向 iFlow 发送第一条消息开始": "Send your first message to iFlow to get started",
  "回到最新 ↓": "Jump to latest ↓",
  "上下文摘要": "Context summary",
  "diff": "diff",
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
