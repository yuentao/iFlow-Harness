/**
 * Super Agent 子会话的 shell 命令护栏（纯逻辑，零 Node / VS Code / 文件系统依赖）。
 *
 * 动因（2026-11-11 真实事故）：子会话在自己的 git worktree 里建了一个指向
 * **主仓** `node_modules` 的 Windows 目录联接，然后执行 `npm ci`。`npm ci`
 * 的第一步就是删除 `node_modules` —— 它顺着联接把**用户主工作区**的依赖清空了
 * （实测只剩 1 个条目），本地 `npm run build` / F5 全部失效。这是用户环境级、
 * 静默、不可逆的破坏，必须由扩展本身拦住，而不是指望模型自觉。
 *
 * 因此宿主在**自动放行子会话的 shell 工具之前**先过这张表：命中即拒绝该次
 * 调用（模型看到工具被拒，可以自行换方案）。
 *
 * 前提（调用点必须保证）：护栏只看得到经过宿主审批的调用，所以 shell 工具
 * **每一次**都必须回到宿主 —— 见 `pickChildPermissionOption` 与
 * `src/panel/super-agent.ts` 的 `callbacksFor` 注释。若对 shell 工具回
 * `allow_always`，CLI 后续同类调用不再请求权限，护栏从此失明。
 *
 * 取舍：本模块刻意**不**碰文件系统 —— `nodeModulesIsLink` 由宿主用
 * `lstatSync` 取（Windows junction 在 Node 里同样报 `isSymbolicLink()` 为
 * true），规则表因此可以纯函数单测，不需要真造联接（建联接需要权限）。
 *
 * 取舍（刻意不做）：本护栏**不**帮子会话自动创建「指向主仓 node_modules 的
 * 联接」。那会把「删除 worktree」变成「顺着联接删掉用户依赖」的新风险 ——
 * 清理路径一旦跟着联接走，护栏本身就制造了它要防的事故。依赖请在子会话自己的
 * worktree 内安装（那是被放行的）。
 */

export interface ChildShellGuardContext {
  /** 子会话的工作目录（worktree / 独立目录 / 主仓根）。 */
  cwd: string;
  /**
   * 主仓（主工作区）根目录 —— 用户自己的仓库，装着用户的 `node_modules`。
   * 命令文本里出现它即视为「动到主工作区」。
   */
  repoRoot: string;
  /**
   * `cwd/node_modules` 当前是否为链接（Windows junction 也算）。
   * 由宿主用 `lstatSync(...).isSymbolicLink()` 取；缺省按「不是链接」处理。
   */
  nodeModulesIsLink?: boolean;
}

export type ChildShellDecision = "allow" | "deny";

export interface ChildShellGuardResult {
  decision: ChildShellDecision;
  /**
   * 拒绝原因（英文，面向模型）。
   *
   * ACP 的 permission 拒绝响应没有 message 字段（`RequestPermissionResponse`
   * 只有 outcome），所以宿主把它写进日志；模型读到的信号是「这次工具调用被
   * 拒绝」。
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

/** 包管理器 → 安装类子命令（小写）。 */
const INSTALL_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  npm: ["ci", "install", "i", "add", "isntall"],
  pnpm: ["install", "i", "add"],
  yarn: ["install", "add", "i"],
  bun: ["install", "i", "add"],
};

/** 显式删除命令（小写、去扩展名后的 basename）。 */
const DELETE_COMMANDS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "rd",
  "del",
  "erase",
  "remove-item",
  "ri",
  "rimraf",
  "unlink",
]);

/** 切换目录命令（用于判定「cd 到主工作区」）。只收可靠、可解析的形态。 */
const CD_COMMANDS: ReadonlySet<string> = new Set(["cd", "chdir", "set-location", "sl"]);

/** shell 类工具名（小写）。kind === "execute" 也算 shell 类。 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "run_shell_command",
  "shell",
  "shell_command",
  "bash",
  "powershell",
  "pwsh",
  "cmd",
  "terminal",
  "terminal_exec",
  "execute_command",
  "run_command",
]);

const LINK_REASON =
  "Blocked by the host guard: creating a link (mklink / junction / symlink) that points at node_modules is not allowed. A child session must not share the main workspace's dependencies — deleting a linked node_modules (e.g. `npm ci`) destroys the real dependency tree. Install dependencies inside your own working directory instead.";

const LINK_INSTALL_REASON =
  "Blocked by the host guard: this working directory's node_modules is a link to another location, so install/delete commands would destroy the real dependency tree (possibly the user's main workspace). Delete the link and install dependencies inside your own working directory.";

const MAIN_WORKSPACE_INSTALL_REASON =
  "Blocked by the host guard: this install/delete command targets the main workspace, which would rewrite the user's own node_modules. Install dependencies inside your own working directory instead.";

const MAIN_WORKSPACE_DELETE_REASON =
  "Blocked by the host guard: this command deletes a node_modules dependency tree. Removing dependencies is not allowed for child sessions.";

/**
 * 判定一条子会话 shell 命令是否放行。
 *
 * 只在调用点确认这是 shell 类工具、且能取到命令文本时调用 —— 非 shell 工具
 * （读写文件、MCP 查询等）不走这张表。
 */
export function classifyChildShellCommand(
  command: string,
  ctx: ChildShellGuardContext,
): ChildShellGuardResult {
  const text = command ?? "";
  if (!text.trim()) return { decision: "allow" };

  const segments = splitSegments(text).map(tokenize);
  const lower = text.toLowerCase();

  // ① 创建指向 node_modules 的链接（mklink / New-Item -ItemType Junction /
  //    ln -s / os.symlink / junction.exe ...）。
  if (mentionsNodeModules(text) && createsLink(lower)) {
    return { decision: "deny", reason: LINK_REASON };
  }

  // ② 包管理器安装类命令 —— 只在「会动到主工作区依赖」时拒绝。
  if (findInstallInvocation(segments)) {
    const reason = installDenyReason(segments, text, ctx);
    if (reason) return { decision: "deny", reason };
  }

  // ③ 显式删除依赖树（同一段里既有删除动词又提到 node_modules）。
  if (deletesNodeModules(segments)) {
    return { decision: "deny", reason: MAIN_WORKSPACE_DELETE_REASON };
  }

  return { decision: "allow" };
}

/**
 * 从 permission 请求的 toolCall 里取命令文本（wire 形态）。
 *
 * `run_shell_command` 在 live wire 与 transcript 里都把命令放在
 * `args.command`（probed CLI 0.5.19，见 `shared/session-state.ts` 的
 * `formatToolInput`）；某些路径只带 `title`，而 shell 工具的 title 本身就是
 * 命令整行（见 `test/os-notification.test.ts` 的注释）。取不到就返回 null ——
 * 调用点据此放行（无法判定时不假装拦得住）。
 */
export function extractShellCommand(toolCall: {
  title?: string;
  args?: unknown;
}): string | null {
  const args = toolCall.args;
  if (typeof args === "string" && args.trim()) return args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const command = (args as { command?: unknown }).command;
    if (typeof command === "string" && command.trim()) return command;
  }
  const title = toolCall.title;
  return typeof title === "string" && title.trim() ? title : null;
}

/**
 * 这是不是一个会执行命令的 shell 类工具。
 *
 * 判定取并集而不是只认 `run_shell_command`：工具名可能变，`kind === "execute"`
 * 是内核给的语义标签；名字里带 shell / bash / powershell / terminal 的 MCP
 * 终端工具同样会跑命令，必须同样「每次回到宿主」，否则护栏对它们失效。
 */
export function isShellToolCall(toolCall: { toolName?: string; kind?: string }): boolean {
  const name = (toolCall.toolName ?? "").trim().toLowerCase();
  if (SHELL_TOOL_NAMES.has(name)) return true;
  if (/(^|[_\s-])(shell|bash|powershell|pwsh|terminal|exec|execute|command)([_\s-]|$)/.test(name)) {
    return true;
  }
  return toolCall.kind === "execute";
}

/**
 * 选自动放行时用的 permission 选项。
 *
 * **shell 类必须 `allow_once`**：`allow_always` 会让 CLI 对该工具的后续调用
 * 不再请求权限，宿主护栏就只看得到第一条命令（形同虚设）。没有 `allow_once`
 * 时返回 undefined —— 调用点按「取消」处理，宁可让这一次调用失败（模型可以
 * 换方案），也不静默放开一个再也看不到的通道。
 *
 * 非 shell 工具维持原策略：`allow_always` 优先（少打扰），没有就退到任意允许项。
 */
export function pickChildPermissionOption<T extends { kind: string }>(
  options: readonly T[],
  shell: boolean,
): T | undefined {
  if (shell) return options.find((option) => option.kind === "allow_once");
  return (
    options.find((option) => option.kind === "allow_always") ??
    options.find((option) => option.kind.startsWith("allow"))
  );
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** 拆命令段：换行 / `;` / `&&` / `||` / 管道 / `&`。只用于逐段看首个命令词。 */
function splitSegments(text: string): string[] {
  return text.split(/\r?\n|;|&&|\|\||\||&/);
}

/** 按引号与空白切词（去掉引号，保留引号内的空格）。 */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  let buffer = "";
  let quote: '"' | "'" | null = null;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else buffer += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (buffer) {
        out.push(buffer);
        buffer = "";
      }
      continue;
    }
    buffer += char;
  }
  if (buffer) out.push(buffer);
  return out;
}

/** 命令词的 basename（小写、去 `.exe/.cmd/.bat/.ps1`）。 */
function commandName(token: string): string {
  const base = token.replace(/\\/g, "/").split("/").pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/** 文本里是否真的提到 node_modules（避免 `node_modules_backup` 这类误伤）。 */
function mentionsNodeModules(text: string): boolean {
  return /(^|[\\\/"'\s=])node_modules([\\\/"'\s]|$)/i.test(text);
}

/** 是否是创建链接的命令形态。 */
function createsLink(lowerCommand: string): boolean {
  if (/\bmklink\b/.test(lowerCommand)) return true;
  if (/-itemtype\s+["']?(symboliclink|junction|hardlink)\b/.test(lowerCommand)) return true;
  if (/\bnew-item\b/.test(lowerCommand) && /\b(symboliclink|junction|hardlink)\b/.test(lowerCommand)) {
    return true;
  }
  if (/\bln\b\s+(-s|--symbolic)\b/.test(lowerCommand)) return true;
  if (/\bsymlink\b/.test(lowerCommand)) return true;
  if (/\bjunction\b/.test(lowerCommand)) return true;
  return false;
}

/** 找出安装类调用（扫每个命令段，取该段第一个包管理器词后的首个非选项词）。 */
function findInstallInvocation(segments: string[][]): { manager: string; subcommand: string } | null {
  for (const tokens of segments) {
    for (let i = 0; i < tokens.length; i++) {
      const name = commandName(tokens[i]!);
      const subcommands = INSTALL_SUBCOMMANDS[name];
      if (!subcommands) continue;
      const rest = tokens.slice(i + 1);
      const first = rest.find((token) => !token.startsWith("-"));
      // `yarn` / `yarn --frozen-lockfile` 本身就是安装。
      if (name === "yarn" && !first) return { manager: name, subcommand: "" };
      if (first && subcommands.includes(first.toLowerCase())) {
        return { manager: name, subcommand: first.toLowerCase() };
      }
      // 该段里第一个包管理器不是安装调用（`npm run build` / `pnpm exec ...`）。
      break;
    }
  }
  return null;
}

/** 安装命令命中哪些「会动到主工作区依赖」的条件。 */
function installDenyReason(
  segments: string[][],
  text: string,
  ctx: ChildShellGuardContext,
): string | null {
  const root = normalizePath(ctx.repoRoot);
  const cwd = normalizePath(ctx.cwd);
  // 主仓工作区档（合并子会话）本身就是用户的工作区：装/删依赖一律不放行。
  if (root && cwd && root === cwd) return MAIN_WORKSPACE_INSTALL_REASON;
  if (ctx.nodeModulesIsLink) return LINK_INSTALL_REASON;
  if (mentionsMainWorkspace(text, ctx)) return MAIN_WORKSPACE_INSTALL_REASON;
  if (changesIntoMainWorkspace(segments, ctx)) return MAIN_WORKSPACE_INSTALL_REASON;
  return null;
}

/** 同一命令段里既有删除动词、又提到 node_modules。 */
function deletesNodeModules(segments: string[][]): boolean {
  for (const tokens of segments) {
    if (!tokens.some((token) => mentionsNodeModules(token))) continue;
    if (tokens.some((token) => DELETE_COMMANDS.has(commandName(token)))) return true;
  }
  return false;
}

/**
 * 命令文本里是否出现主工作区根。
 *
 * 子会话的 worktree 就在主仓里面（`.iflow/super/worktrees/...`），所以先把
 * 命令里出现的 **worktree 自己的路径** 抹掉再找主仓根 —— 否则
 * `cd <worktree> && npm ci` 会被误判成「动主工作区」，让子会话连自装依赖都做不了。
 */
function mentionsMainWorkspace(text: string, ctx: ChildShellGuardContext): boolean {
  const root = normalizePath(ctx.repoRoot);
  if (!root) return false;
  let probe = text.replace(/\\/g, "/").toLowerCase();
  const cwd = normalizePath(ctx.cwd);
  if (cwd && cwd !== root) probe = probe.split(cwd).join(" ");
  return probe.includes(root);
}

/** 命令里是否有 `cd` 落到主仓根（相对 / 绝对路径都解析；解析不了就不据此判定）。 */
function changesIntoMainWorkspace(
  segments: string[][],
  ctx: ChildShellGuardContext,
): boolean {
  const root = normalizePath(ctx.repoRoot);
  if (!root) return false;
  let cwd = normalizePath(ctx.cwd);
  for (const tokens of segments) {
    const name = tokens[0] ? commandName(tokens[0]) : "";
    if (!CD_COMMANDS.has(name)) continue;
    const target = tokens
      .slice(1)
      .find((token) => !token.startsWith("-") && token.toLowerCase() !== "/d");
    if (!target || target === "-") continue;
    cwd = resolvePath(cwd, target);
    if (cwd === root) return true;
  }
  return false;
}

/** 绝对路径判定（Windows 盘符 / POSIX 根 / UNC 开头的都算）。 */
function isAbsolutePath(value: string): boolean {
  const text = value.replace(/\\/g, "/");
  return text.startsWith("/") || /^[A-Za-z]:\//.test(text);
}

/** 归一化绝对路径：统一正斜杠、去掉 `.`/`..`/空段、盘符与段一律小写。 */
function normalizePath(value: string): string {
  const raw = value.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\//.exec(raw);
  const prefix = drive ? `${drive[1]!.toLowerCase()}:` : raw.startsWith("/") ? "" : "";
  const rest = drive ? raw.slice(drive[0].length - 1) : raw;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part.toLowerCase());
  }
  return `${prefix}/${parts.join("/")}`;
}

/** 以 `base`（绝对路径）为基准解析 `target`。 */
function resolvePath(base: string, target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return base;
  return normalizePath(isAbsolutePath(trimmed) ? trimmed : `${base}/${trimmed}`);
}