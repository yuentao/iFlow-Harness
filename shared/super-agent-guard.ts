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
 * 两条落地路径（能力不同，必须分开看 —— 否则会误判护栏到底有没有用）：
 *  1. **审批路径**（`session/request_permission`）：宿主能**拒掉单次调用**。
 *     前提是 shell 工具每一次都回到宿主 —— 见 `pickChildPermissionOption`
 *     与 `src/panel/super-agent.ts` 的 `callbacksFor` 注释；若对 shell 工具回
 *     `allow_always`，CLI 后续同类调用不再请求权限，护栏从此失明。
 *  2. **预检路径**（`session/update` 的 tool_call 帧）：子会话跑在 `yolo`
 *     免确认模式下，内核**通常根本不发** `session/request_permission`
 *     （见 `src/panel/super-agent.ts` 的 `callbacksFor` 注释），审批路径
 *     形同虚设。宿主改从 wire 上「命令即将执行」的那一帧读命令文本
 *     （`tool_call_update(in_progress)`，CLI 在 `execute` 之前推送）——
 *     但这条路径**只能终止整个子会话**，拒不掉单次调用。
 *
 * 所以判定结果带一档 **severity**：
 *  - `tool`：只该拒掉这一次调用 —— 终止整个子会话属于误伤；
 *  - `session`：命令会（可能）破坏用户主工作区的依赖树 —— 预检路径据此
 *    终止子会话，审批路径据此拒掉这次调用。
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
  /**
   * 读取子会话工作目录内的脚本文件内容（可选）。
   *
   * 由宿主注入（护栏本身零文件系统依赖，纯函数才能单测）。用途：判定
   * `node <脚本文件>` 这类把命令藏进文件的写法 —— 脚本内容里有危险调用就
   * 拦，读不到就不拦（见 `classifyNodeInvocation` 的说明）。
   *
   * 传入的是**绝对路径**；实现方应自行再确认它落在子会话工作目录内
   * （护栏已经判过一次，宿主侧再兜一层：护栏是纯逻辑，边界归宿主管）。
   */
  readLocalFile?: (absolutePath: string) => string | null;
}

export type ChildShellDecision = "allow" | "deny";

/**
 * 命中后的处置档位。
 *
 * - `tool`：只该拒掉**这一次**工具调用（子会话可以换个方案继续）。
 * - `session`：足以终止整个子会话 —— 命令会（可能）破坏用户主工作区的
 *   依赖树。
 *
 * 为什么分档：护栏有两条落地路径，能力不同（见模块头注释）。审批路径能拒掉
 * 单次调用，预检路径只能终止整个子会话。用同一档位去终止，会把「删掉自己
 * worktree 里的 node_modules」这种无害动作升级成「杀掉整个子会话」—— 那是
 * 误伤。所以只有**明确会动到用户主工作区依赖树**的命中才是 `session`。
 */
export type ChildShellSeverity = "tool" | "session";

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
  /** 处置档位（`decision === "deny"` 时有意义）。 */
  severity?: ChildShellSeverity;
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

/**
 * 会「在原位再开一层 shell」的包装命令（小写 basename）。
 *
 * 这些命令把内层命令放在一个参数里，最常见的写法还会给整段命令加引号 ——
 * `cmd /c "npm ci"` 经 `tokenize` 之后 `npm ci` 变成**一个词**，安装/删除
 * 规则因此全部失明（2026-11-11 实测：`powershell -c "npm ci"` 在
 * `nodeModulesIsLink` 为真时照样被放行，正是事故重现路径）。
 */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  "cmd",
  "powershell",
  "pwsh",
  "bash",
  "sh",
  "zsh",
  "fish",
  "call",
]);

/** 包装命令中「下一段就是完整命令」的开关（去掉 `-`/`/` 前缀后比较）。 */
const INLINE_COMMAND_FLAGS: ReadonlySet<string> = new Set(["c", "k", "command", "lc", "cl"]);

/** Node 解释器名（basename，小写）。 */
const NODE_BINARIES: ReadonlySet<string> = new Set(["node", "nodejs"]);

/**
 * Node 的「内联求值」开关 —— 脚本内容直接跟在命令行里。
 *
 * 这类写法把真正的命令藏在一段 JS 里：命令文本里根本没有「npm」这个词，
 * 按词切分也切不出来（审计实测：`node -e "require('child_process').execSync('npm ci')"`
 * 与 `node make-link.js` 两类写法都被判成放行）。
 */
const NODE_EVAL_FLAGS: ReadonlySet<string> = new Set(["-e", "--eval", "-p", "--print"]);

/**
 * 脚本里出现「从子进程里跑包管理器安装」的形态。
 *
 * 必须同时出现 `child_process`（脚本确实能起子进程）与「包管理器 + 安装子命令」
 * 的组合：只看到 `npm ci` 这几个字（例如脚本里只是打印一句提示）不算危险，
 * 只看到 `child_process`（例如跑个 `git status`）也不算 —— 两个条件合起来
 * 才是「这条命令会去装依赖」。
 *
 * 允许中间夹少量字符（`npm', ['ci']` 这种数组写法、`npm ' + 'ci` 这种拼接），
 * 但不许跨行 —— 跨行的两个词多半不是同一个调用。
 */
const INSTALL_CALL_IN_SCRIPT =
  /\b(npm|pnpm|yarn|bun)\b[^\n]{0,40}?\b(ci|install|i|add)\b/i;

/** 脚本里「创建链接」的 API 调用形态。 */
const LINK_CALL_IN_SCRIPT = /symlinksync|symlink\s*\(|fs\.symlink|junction|mklink|hardlink/i;

const LINK_REASON =
  "Blocked by the host guard: creating a link (mklink / junction / symlink) that points at node_modules is not allowed. A child session must not share the main workspace's dependencies — deleting a linked node_modules (e.g. `npm ci`) destroys the real dependency tree. Install dependencies inside your own working directory instead.";

const LINK_INSTALL_REASON =
  "Blocked by the host guard: this working directory's node_modules is a link to another location, so install/delete commands would destroy the real dependency tree (possibly the user's main workspace). Delete the link and install dependencies inside your own working directory.";

const MAIN_WORKSPACE_INSTALL_REASON =
  "Blocked by the host guard: this install/delete command targets the main workspace, which would rewrite the user's own node_modules. Install dependencies inside your own working directory instead.";

const MAIN_WORKSPACE_DELETE_REASON =
  "Blocked by the host guard: this command deletes a node_modules dependency tree. Removing dependencies is not allowed for child sessions.";

const SCRIPT_INSTALL_REASON =
  "Blocked by the host guard: this command runs a dependency install from inside a Node script (child_process + npm/pnpm/yarn/bun install). The host cannot see which directory the script installs into, so it cannot rule out that it rewrites the main workspace's node_modules. Run the install directly in your own working directory instead — that is allowed as long as your node_modules is not a link.";

const SCRIPT_LINK_REASON =
  "Blocked by the host guard: this command creates a link that points at node_modules from inside a Node script. A linked node_modules turns the next `npm ci` into a deletion of the real dependency tree (possibly the user's main workspace). Install dependencies inside your own working directory instead.";

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
  return classifyText(command ?? "", ctx, 4);
}

function classifyText(
  text: string,
  ctx: ChildShellGuardContext,
  depth: number,
): ChildShellGuardResult {
  if (!text.trim()) return { decision: "allow" };

  // ⓪ 先解包 `cmd /c "..."` / `powershell -Command "..."`：引号里的命令在
  //    下面按词切分时会粘连成一个词，安装/删除规则看不到它。内层命令按同一
  //    张表重新判定（只认带内联命令开关的形态 —— `bash script.sh` 的脚本名
  //    不是命令，不去猜它内容）。
  if (depth > 0) {
    for (const nested of unwrapShellCommands(text)) {
      const result = classifyText(nested, ctx, depth - 1);
      if (result.decision === "deny") return result;
    }
  }

  const segments = splitSegments(text).map(tokenize);
  const lower = text.toLowerCase();

  // ① 创建指向 node_modules 的链接（mklink / New-Item -ItemType Junction /
  //    ln -s / os.symlink / junction.exe ...）。
  if (mentionsNodeModules(text) && createsLink(lower)) {
    return { decision: "deny", reason: LINK_REASON, severity: linkSeverity(segments) };
  }

  // ② Node 内联脚本 / 脚本文件 —— 命令藏在 JS 里，按词切分看不见。
  //    放在安装/删除规则之前：这类写法的命令文本里根本没有包管理器词。
  const nodeVerdict = classifyNodeInvocation(segments, ctx);
  if (nodeVerdict) return nodeVerdict;

  // ③ 包管理器安装类命令 —— 只在「会动到主工作区依赖」时拒绝。
  if (findInstallInvocation(segments)) {
    const reason = installDenyReason(segments, text, ctx);
    if (reason) return { decision: "deny", reason, severity: "session" };
  }

  // ④ 显式删除依赖树（同一段里既有删除动词又提到 node_modules）。
  if (deletesNodeModules(segments)) {
    return {
      decision: "deny",
      reason: MAIN_WORKSPACE_DELETE_REASON,
      severity: deleteSeverity(text, ctx),
    };
  }

  return { decision: "allow" };
}

/**
 * 判定「命令即将执行」的那一帧（`session/update` 的 tool_call 帧）。
 *
 * 存在的理由：子会话跑在 `yolo` 免确认模式下，内核通常**不发**
 * `session/request_permission` —— 审批路径上的护栏形同虚设。宿主能观察到的
 * 唯一命令文本入口是 wire 上的 tool_call 帧：`args` 里带原始参数
 * （probed CLI 0.5.19：`tool_call_update(in_progress)` 才带 args，而那一帧
 * 恰好在 `execute` 之前推送）。
 *
 * 只看「即将执行」的那两帧（`pending` / `in_progress`）：完成帧里可能还带着
 * 同一段命令，重判一次只是白费力气。
 *
 * 返回 null 表示「这条帧不走护栏」（不是工具调用 / 不是 shell 类 / 取不到命令
 * 文本）。取不到命令文本时**不猜**：无法判定就不假装拦得住。
 */
export function classifyChildToolCall(
  frame: {
    sessionUpdate?: string;
    toolCallId?: string;
    toolName?: string;
    kind?: string;
    status?: string;
    title?: string;
    args?: unknown;
  },
  ctx: ChildShellGuardContext,
): ChildShellGuardResult | null {
  if (frame.sessionUpdate !== "tool_call" && frame.sessionUpdate !== "tool_call_update") {
    return null;
  }
  if (frame.status !== "pending" && frame.status !== "in_progress") return null;
  if (!isShellToolCall({ toolName: frame.toolName, kind: frame.kind })) return null;
  const command = extractShellCommand({ title: frame.title, args: frame.args });
  if (!command) return null;
  return classifyChildShellCommand(command, ctx);
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

/**
 * 把 `cmd /c "npm ci"` / `powershell -NoProfile -Command "npm ci"` 的内层命令
 * 取出来（`tokenize` 已去掉引号，内层文本可以直接再切分）。
 *
 * 只在包装命令后面紧跟内联命令开关时才解包 —— 否则 `bash run.sh` 的脚本名
 * 会被当成命令本身，凭空制造误判。
 */
function unwrapShellCommands(text: string): string[] {
  const out: string[] = [];
  for (const segment of splitSegments(text)) {
    const tokens = tokenize(segment);
    const name = tokens[0] ? commandName(tokens[0]) : "";
    if (!WRAPPER_COMMANDS.has(name)) continue;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!/^[-/]/.test(token)) continue;
      if (!INLINE_COMMAND_FLAGS.has(token.replace(/^[-/]/, "").toLowerCase())) continue;
      const inner = tokens
        .slice(i + 1)
        .join(" ")
        .trim();
      if (inner) out.push(inner);
      break;
    }
  }
  return out;
}

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

/**
 * 链接命令的「被创建出来的那个路径」。
 *
 * 只有当**被创建的路径本身就是 node_modules** 时，创建链接才等于「把依赖树
 * 换成链接」—— 那正是 2026-11-11 事故的第一步。反过来，链接建在 node_modules
 * **里面**（monorepo 常见的 `ln -s ../../packages/core node_modules/core`）
 * 并不让 node_modules 变成链接，爆炸半径完全不同。
 *
 * 各家命令的语法不同，这里按形态分别取：
 *  - `mklink /J <link> <target>`：第一个非开关参数；
 *  - `junction <link> <target>`（Sysinternals）：第一个非开关参数；
 *  - `New-Item -Path <link> -Target ...`：`-Path` 的值；
 *  - `ln -s <target> <link>`：**最后一个**非开关参数。
 *
 * 取不到就返回 null（按「不终止子会话」的保守档处理）。
 */
function linkDestination(tokens: string[]): string | null {
  const name = tokens[0] ? commandName(tokens[0]) : "";
  const rest = tokens.slice(1);
  const plain = rest.filter((token) => !/^[-/]/.test(token));
  if (name === "mklink" || name === "junction") return plain[0] ?? null;
  if (name === "new-item") {
    const index = rest.findIndex((token) => token.toLowerCase() === "-path");
    if (index < 0) return null;
    return rest[index + 1] ?? null;
  }
  if (name === "ln") return plain.length > 0 ? plain[plain.length - 1]! : null;
  return null;
}

/** 被创建的路径是不是 node_modules 本身。 */
function isNodeModulesPath(value: string): boolean {
  const base = value.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.toLowerCase() === "node_modules";
}

/**
 * 链接命中的处置档位。
 *
 * `session` 档只给「被创建的路径就是 node_modules」—— 那是事故的第一步，
 * 必须当场终止。链接建在 node_modules 里面之类（爆炸半径有限）只按 `tool` 档
 * 拒掉这一次调用，不因此杀掉整个子会话。
 */
function linkSeverity(segments: string[][]): ChildShellSeverity {
  for (const tokens of segments) {
    const destination = linkDestination(tokens);
    if (destination && isNodeModulesPath(destination)) return "session";
  }
  return "tool";
}

/**
 * 删除依赖树命中的处置档位。
 *
 * 只有「删到的是用户的依赖树」才是 `session` 档：worktree 的 node_modules
 * 本身就是链接（删它等于删用户主工作区的依赖），或命令文本点名了主工作区。
 * 删自己 worktree 里那份真实的 node_modules 爆炸半径仅限子会话自己的目录，
 * 按 `tool` 档拒掉这一次调用即可。
 */
function deleteSeverity(text: string, ctx: ChildShellGuardContext): ChildShellSeverity {
  if (ctx.nodeModulesIsLink) return "session";
  if (mentionsMainWorkspace(text, ctx)) return "session";
  return "tool";
}

// ---------------------------------------------------------------------------
// Node 内联脚本 / 脚本文件
// ---------------------------------------------------------------------------

/**
 * 一段命令里有没有 Node 解释器调用，以及它带的是内联脚本还是脚本文件。
 *
 * 找不到就返回 null（不是 node 调用，或 node 后面没有可执行的东西，例如
 * `node --version`）。
 */
function findNodeInvocation(
  tokens: string[],
): { kind: "inline"; script: string } | { kind: "file"; file: string } | null {
  for (let i = 0; i < tokens.length; i++) {
    if (!NODE_BINARIES.has(commandName(tokens[i]!))) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j]!;
      const lower = token.toLowerCase();
      // `--eval=<脚本>` / `--print=<脚本>`：脚本跟在等号后面。
      if (lower.startsWith("--eval=") || lower.startsWith("--print=")) {
        const script = token.slice(token.indexOf("=") + 1);
        return script ? { kind: "inline", script } : null;
      }
      // `-e <脚本>` / `-p <脚本>`：脚本是下一个词。
      if (NODE_EVAL_FLAGS.has(lower)) {
        const script = tokens[j + 1];
        return script ? { kind: "inline", script } : null;
      }
      if (token.startsWith("-")) continue; // node 自己的选项
      // 第一个非选项词 = 脚本文件。
      return { kind: "file", file: token };
    }
    return null;
  }
  return null;
}

/**
 * 判定 Node 调用里的脚本是否危险。
 *
 * 两种危险形态：
 *  1. 脚本里创建指向 node_modules 的链接 —— 事故的第一步，无条件拦；
 *  2. 脚本里用 child_process 跑包管理器安装 —— 装到哪儿脚本说了算（可以
 *     chdir、可以 `--prefix`），宿主看不见，拦。
 *
 * 为什么第 2 条不区分「装到自己的 worktree」：脚本内容里能看见目标目录时，
 * 宿主能判断（见 `scriptInstallSeverity`）；看不见时（目标在变量里、在
 * 拼接里、在配置里）一律按「装到哪儿不知道」处理。
 */
function classifyDangerousScript(
  script: string,
  ctx: ChildShellGuardContext,
): ChildShellGuardResult | null {
  if (mentionsNodeModules(script) && LINK_CALL_IN_SCRIPT.test(script)) {
    return { decision: "deny", reason: SCRIPT_LINK_REASON, severity: "session" };
  }
  if (!/child_process/.test(script)) return null;
  if (!INSTALL_CALL_IN_SCRIPT.test(script)) return null;
  return {
    decision: "deny",
    reason: SCRIPT_INSTALL_REASON,
    severity: scriptInstallSeverity(script, ctx),
  };
}

/**
 * 脚本里装依赖的处置档位。
 *
 * `session` 档：worktree 的 node_modules 已经是链接，或脚本文本点名了主工作区
 * —— 这两种情况下装依赖明确会动到用户的依赖树。其余（脚本在自己 worktree
 * 里装自己的依赖）按 `tool` 档：拒掉这一次调用，子会话可以换成直接跑
 * `npm ci`（那是允许的）。
 */
function scriptInstallSeverity(
  script: string,
  ctx: ChildShellGuardContext,
): ChildShellSeverity {
  if (ctx.nodeModulesIsLink) return "session";
  if (mentionsMainWorkspace(script, ctx)) return "session";
  return "tool";
}

/**
 * 逐段判定 Node 调用。
 *
 * 脚本文件只在**子会话自己的工作目录内**才读：护栏没有理由为了判定去碰用户
 * 主工作区里的文件，也没有理由去读工作目录外的脚本（那本来也不在子会话的
 * 隔离边界内）。
 *
 * 读不到就放行（刻意不拒绝）：脚本可能根本不存在（命令自己会失败）、可能
 * 不是文本、也可能宿主没给读取能力。一刀切拒绝会误伤大量正常用法（本仓库
 * 自己的 `node scripts/harness.mjs` 就是常规操作），而真正危险的形态会在
 * 别处再被看见（命令文本里的包装命令、脚本里的链接创建）。
 */
function classifyNodeInvocation(
  segments: string[][],
  ctx: ChildShellGuardContext,
): ChildShellGuardResult | null {
  let dir = ctx.cwd;
  for (const tokens of segments) {
    const name = tokens[0] ? commandName(tokens[0]) : "";
    // 段内的 `cd` 会改变后续脚本的相对路径基准。
    if (CD_COMMANDS.has(name)) {
      const target = tokens
        .slice(1)
        .find((token) => !token.startsWith("-") && token.toLowerCase() !== "/d");
      if (target && target !== "-") dir = resolvePath(normalizePath(dir), target);
      continue;
    }
    const invocation = findNodeInvocation(tokens);
    if (!invocation) continue;
    if (invocation.kind === "inline") {
      const verdict = classifyDangerousScript(invocation.script, ctx);
      if (verdict) return verdict;
      continue;
    }
    const resolved = resolveInside(dir, invocation.file);
    if (!resolved) continue;
    const reader = ctx.readLocalFile;
    if (!reader) continue;
    const content = reader(resolved);
    if (!content) continue;
    const verdict = classifyDangerousScript(content, ctx);
    if (verdict) return verdict;
  }
  return null;
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
      // `yarn` / `yarn --frozen-lockfile` / 裸 `pnpm` 本身就是安装。
      if ((name === "yarn" || name === "pnpm") && !first) {
        return { manager: name, subcommand: "" };
      }
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

/**
 * 归一化绝对路径但**保留大小写** —— 读文件要拿原始路径，比较边界才用小写。
 *
 * 与 {@link normalizePath} 的区别只有大小写：后者一律小写（Windows / POSIX
 * 都当大小写无关处理），这里保留原样。
 */
function normalizePathCase(value: string): string {
  const raw = value.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\//.exec(raw);
  const prefix = drive ? `${drive[1]}:` : "";
  const rest = drive ? raw.slice(drive[0].length - 1) : raw;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${prefix}/${parts.join("/")}`;
}

/** 拼接路径（保留原始分隔符风格）。 */
function joinPath(base: string, target: string): string {
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${target.replace(/^[\\/]+/, "")}`;
}

/**
 * 把一个脚本路径解析成「**确实落在 base 目录内**」的绝对路径。
 *
 * 落在外面就返回 null（护栏不去读工作目录外的文件：那是用户主工作区的东西，
 * 护栏没有理由为了判定去碰它）。
 *
 * 比较用小写归一（Windows 大小写无关），返回的仍是原始大小写的路径 —— 读文件
 * 要用它。
 */
function resolveInside(base: string, target: string): string | null {
  if (!base || !target) return null;
  const raw = isAbsolutePath(target) ? target : joinPath(base, target);
  const resolved = normalizePathCase(raw);
  const baseKey = normalizePath(base);
  const key = normalizePath(resolved);
  if (!baseKey || key === baseKey) return null;
  const prefix = baseKey.endsWith("/") ? baseKey : `${baseKey}/`;
  if (!key.startsWith(prefix)) return null;
  return resolved;
}