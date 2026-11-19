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
   * 子会话是否直接跑在**主仓工作区**（repo 档 / 合并子会话，无隔离）。
   *
   * 这一档没有自己的分支与临时工作目录：`git reset --hard` / `git clean -fd`
   * / `git checkout -- .` 会直接在用户的工作区里丢掉未提交改动，不可逆。
   * worktree 档的同一条命令只毁掉自己的临时工作目录（删掉即可重建），因此
   * 破坏性 git 规则的判定**只在这一档生效** —— 由宿主按
   * `session.isolation.kind === "repo"` 显式传入，不靠路径猜测（repo 档的
   * 子会话可以 `cd` 到子目录里执行 git，路径相等判断会漏）。
   */
  repoWorkspace?: boolean;
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

/** git 可执行名（basename，小写）。 */
const GIT_BINARIES: ReadonlySet<string> = new Set(["git"]);

/**
 * git 的**取值型全局选项**：`git -C <dir> reset` / `git -c <k=v> ...` 里的
 * 第一个非选项词其实是选项取值，不是子命令。不跳过它们会把子命令读成路径，
 * 破坏性命令因此逃过判定。带 `=` 的形态（`--git-dir=x`）自带取值，不经这里。
 */
const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

/**
 * repo 档的破坏性 git 命令拒绝文案（英文，面向模型）。
 *
 * 这类命令在 worktree 档是允许的（毁掉的是自己的临时目录），所以文案必须
 * 点名「这里是主仓工作区」，否则模型会以为自己被无理由拦下。
 */
const DESTRUCTIVE_GIT_REASON =
  "Blocked by the host guard: this working directory is the MAIN repository workspace (no isolation), so destructive git commands are not allowed. `git reset --hard`, `git clean -fd`, `git checkout -- .` and `git restore` irreversibly discard the user's uncommitted work. Stop and report the repository state instead of throwing changes away.";

/**
 * repo 档合并子会话的「任务书硬边界」拒绝文案（`session` 档）。
 *
 * 与上面的破坏性 git 规则分开：这些命令不一定毁掉工作区文件，但都越过
 * 了合并任务书明确写死的边界 —— push 会把结果推到远端（不可逆、外部可见），
 * rebase 改写历史，删分支会丢掉来源子会话的工作，切分支会离开合并现场，
 * stash 会把用户的改动藏进栈里。任何一条都说明执行者没有遵守硬边界，
 * 必须在命令执行前终止整个子会话。
 */
const MERGE_BOUNDARY_GIT_REASON =
  "Blocked by the host guard: this merge child session runs in the MAIN repository workspace under a merge-only boundary. `git push`, `git rebase`, branch deletion, branch switching and `git stash` are not part of the merge task and are not allowed. Finish the merge in the current branch and report faithfully.";

/**
 * repo 档合并子会话「会把用户其它改动卷进合并」的拒绝文案（`tool` 档）。
 *
 * 只拒这一次调用而非终止会话：这类命令最可能出现在冲突解决的中途，终止
 * 会把仓库留在 MERGE_HEAD 中间态（任务书明令禁止），而拒掉单次调用后
 * 执行者可以改用 `git add <具体文件>` / `git commit` 继续完成合并。
 *
 * 注意：预检路径（yolo 免确认）只能终止会话，无法拒单次调用，因此本条
 * 只在审批路径生效；这正是「不把合成提交风险升级成半合并仓库」的取舍。
 */
const MERGE_STAGE_GIT_REASON =
  "Blocked by the host guard: `git add -A` / `git add .` / `git commit -a` would stage the user's unrelated uncommitted changes into the merge. Stage only the conflicted files you resolved (e.g. `git add src/foo.ts`) and let `git merge` create the merge commit.";

/**
 * repo 档写/编辑工具命中受保护路径的拒绝文案（`session` 档）。
 *
 * `.git/` 是仓库元数据（config / hooks / MERGE_HEAD / refs），`.iflow/super/`
 * 是宿主自己的子会话工作树与归档元数据 —— 两者都不是合并产物，改写它们
 * 等于绕过宿主的安全网。命令还没执行就终止，避免留下半改写的元数据。
 */
const PROTECTED_PATH_REASON =
  "Blocked by the host guard: this merge child session must not write to protected repository metadata (.git/) or the host's Super Agent metadata (.iflow/super/). Only resolve the conflicted source files and let git create the merge commit.";

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

  // ① repo 档（主仓工作区）的破坏性 git 命令 —— 不可逆地丢掉用户未提交
  //    改动。worktree 档不走这条规则（毁掉的是自己的临时目录）。
  //    紧随其后的是 repo 档合并任务书的硬边界（push / rebase / 删分支 /
  //    切分支 / stash / 扫走用户改动的 add -A）—— 同样只作用于 repo 档，
  //    在命令执行的那一帧就终止，不等它真的跑起来。
  const gitVerdict =
    classifyDestructiveGit(segments, ctx) ?? classifyMergeBoundaryGit(segments, ctx);
  if (gitVerdict) return gitVerdict;

  // ② 创建指向 node_modules 的链接（mklink / New-Item -ItemType Junction /
  //    ln -s / os.symlink / junction.exe ...）。
  if (mentionsNodeModules(text) && createsLink(lower)) {
    return { decision: "deny", reason: LINK_REASON, severity: linkSeverity(segments) };
  }

  // ③ Node 内联脚本 / 脚本文件 —— 命令藏在 JS 里，按词切分看不见。
  //    放在安装/删除规则之前：这类写法的命令文本里根本没有包管理器词。
  const nodeVerdict = classifyNodeInvocation(segments, ctx);
  if (nodeVerdict) return nodeVerdict;

  // ④ 包管理器安装类命令 —— 只在「会动到主工作区依赖」时拒绝。
  if (findInstallInvocation(segments)) {
    const reason = installDenyReason(segments, text, ctx);
    if (reason) return { decision: "deny", reason, severity: "session" };
  }

  // ⑤ 显式删除依赖树（同一段里既有删除动词又提到 node_modules）。
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
 * repo 档合并子会话的「写/编辑工具」预检（纯逻辑）。
 *
 * 背景：`run_shell_command` 的命令文本走 {@link classifyChildToolCall}，
 * 但 `write_file` / `replace` 这类工具根本不带命令文本，护栏对它们完全失明
 * —— 而合并子会话就跑在主仓工作区，能直接改写 `.git/config`、hooks、
 * MERGE_HEAD 或宿主的 `.iflow/super/` 子会话元数据，绕过全部安全网。
 * 这条检查补上这个缺口：只对 repo 档（`repoWorkspace`）生效，只看「即将
 * 执行」的两帧，目标落在受保护路径下即终止会话。
 *
 * 目标取不到时返回 null（放行，不猜）—— 与 shell 护栏同一纪律：参数形态
 * 未知时不假装拦得住，避免误伤正常的冲突文件编辑。
 */
export function classifyChildFileWrite(
  frame: {
    sessionUpdate?: string;
    toolName?: string;
    kind?: string;
    status?: string;
    args?: unknown;
  },
  ctx: ChildShellGuardContext,
): ChildShellGuardResult | null {
  if (!ctx.repoWorkspace) return null;
  if (frame.sessionUpdate !== "tool_call" && frame.sessionUpdate !== "tool_call_update") {
    return null;
  }
  if (frame.status !== "pending" && frame.status !== "in_progress") return null;
  const name = (frame.toolName ?? "").trim().toLowerCase();
  if (!WRITE_TOOL_NAMES.has(name) && frame.kind !== "edit") return null;
  const target = extractWritePath(frame.args);
  if (!target) return null;
  const base = normalizePath(ctx.cwd).replace(/\/+$/, "");
  if (!base) return null;
  const resolved = resolvePath(base, target);
  for (const protectedRel of PROTECTED_REPO_PATHS) {
    const forbidden = `${base}/${protectedRel}`;
    if (resolved === forbidden || resolved.startsWith(`${forbidden}/`)) {
      return { decision: "deny", reason: PROTECTED_PATH_REASON, severity: "session" };
    }
  }
  return null;
}

/** 会写文件的工具名（内核内置 + 常见编辑类 MCP 工具）。 */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "replace",
  "xml_escape",
  "edit_block",
  "fast_edit_block",
  "edit_file",
  "create_file",
]);

/** repo 档里禁止子会话直接改写的路径（相对主仓根，都是宿主 / git 元数据）。 */
const PROTECTED_REPO_PATHS: readonly string[] = [".git", ".iflow/super"];

/** 写工具参数里可能出现的路径键（与 shared/session-state.ts 的口径一致）。 */
const WRITE_PATH_KEYS: readonly string[] = [
  "file_path",
  "absolute_path",
  "filePath",
  "path",
  "file",
  "filename",
  "target_file",
];

/** 从写工具参数里取第一个能识别的路径字符串。 */
function extractWritePath(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  for (const key of WRITE_PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
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

// ---------------------------------------------------------------------------
// repo 档：破坏性 git 命令
// ---------------------------------------------------------------------------

/**
 * 判定命令里是否有「在主仓工作区里不可逆丢改动」的 git 调用。
 *
 * **只在 `ctx.repoWorkspace` 为真时生效**：worktree 档的目录是宿主建的临时
 * 副本，`git reset --hard` / `git clean -fd` 毁掉的只是子会话自己的现场
 * （而且这类命令在 worktree 里本来就是正常操作），拦它属于误伤。
 *
 * 处置档位是 `session`：预检路径（wire 上的 tool_call 帧）只能终止整个子会话，
 * 而这些命令的后果是用户工作区里不可逆的数据丢失 —— 宁可停掉子会话，也绝不
 * 让命令跑下去。审批路径下则拒掉这一次调用。
 */
function classifyDestructiveGit(
  segments: string[][],
  ctx: ChildShellGuardContext,
): ChildShellGuardResult | null {
  if (!ctx.repoWorkspace) return null;
  for (const tokens of segments) {
    const invocation = findGitInvocation(tokens);
    if (!invocation) continue;
    if (isDestructiveGitCommand(invocation.subcommand, invocation.args)) {
      return { decision: "deny", reason: DESTRUCTIVE_GIT_REASON, severity: "session" };
    }
  }
  return null;
}

/**
 * repo 档合并子会话的「任务书硬边界」git 规则（仅 `repoWorkspace` 生效）。
 *
 * {@link classifyDestructiveGit} 管的是「丢用户未提交文件」，这里管的是
 * 「越过合并任务书写死的边界」：push / rebase / 删分支 / 切分支 / stash
 * 都是不可逆或会脱离合并现场的动作 —— 它们一旦执行，宿主就再也收不回
 * 结果（推送到远端、改写历史、丢掉来源分支、藏起用户改动）。预检帧据此
 * 终止整个子会话。
 *
 * 另一类 `git add -A` / `git commit -a` 会把用户**其它**未提交改动卷进
 * 合并提交：后果严重但可由用户恢复，且这类命令常出现在冲突解决中途 ——
 * 终止会话会把仓库留在 MERGE_HEAD 中间态（任务书明令禁止）。因此按
 * `tool` 档处理：审批路径拒掉单次调用，预检路径刻意不终止（见
 * MERGE_STAGE_GIT_REASON 的说明）。
 *
 * worktree 档完全不受这些规则约束：那些子会话本就被允许 push / 建 PR。
 */
function classifyMergeBoundaryGit(
  segments: string[][],
  ctx: ChildShellGuardContext,
): ChildShellGuardResult | null {
  if (!ctx.repoWorkspace) return null;
  for (const tokens of segments) {
    const invocation = findGitInvocation(tokens);
    if (!invocation) continue;
    const { subcommand, args } = invocation;
    if (subcommand === "push" || subcommand === "rebase" || subcommand === "stash") {
      return { decision: "deny", reason: MERGE_BOUNDARY_GIT_REASON, severity: "session" };
    }
    if (deletesBranch(subcommand, args) || switchesBranch(subcommand, args)) {
      return { decision: "deny", reason: MERGE_BOUNDARY_GIT_REASON, severity: "session" };
    }
    if (stagesAllChanges(subcommand, args)) {
      return { decision: "deny", reason: MERGE_STAGE_GIT_REASON, severity: "tool" };
    }
  }
  return null;
}

/** `git branch -d/-D/--delete`（删分支会丢掉来源子会话的工作）。 */
function deletesBranch(subcommand: string, args: readonly string[]): boolean {
  if (subcommand !== "branch") return false;
  return args.some((arg) => {
    const lower = arg.toLowerCase();
    return (
      lower === "-d" || lower === "--delete" || shortFlagBundleIncludes(lower, "d")
    );
  });
}

/**
 * `git checkout <分支>` / `git switch`（切分支会离开合并现场）。
 *
 * 刻意放行 `git checkout -b/-B/--orphan`（建分支而非切分支），与既有
 * worktree 档 allowCase 一致；`git checkout -- .` / `-f` 已由破坏性规则先拦，
 * 这里不再重复判定（返回 false 只是让破坏性 reason 保留）。
 */
function switchesBranch(subcommand: string, args: readonly string[]): boolean {
  if (subcommand === "switch") return true;
  if (subcommand !== "checkout") return false;
  const lower = args.map((arg) => arg.toLowerCase());
  if (lower.some((arg) => arg === "-b" || arg === "-B" || arg === "--orphan")) return false;
  if (lower.includes("--")) return false;
  return lower.some((arg) => !arg.startsWith("-") && arg !== "." && arg !== "./" && arg !== ".\\");
}

/** `git add -A` / `git add .` / `git commit -a`（把用户其它改动卷进合并）。 */
function stagesAllChanges(subcommand: string, args: readonly string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase());
  if (subcommand === "add") {
    return (
      lower.some((arg) => arg === "-a" || arg === "--all") ||
      lower.some((arg) => arg === "." || arg === "./" || arg === ".\\")
    );
  }
  if (subcommand === "commit") {
    return (
      lower.includes("--all") ||
      lower.some((arg) => shortFlagBundleIncludes(arg, "a"))
    );
  }
  return false;
}

/**
 * 在一个命令段里找 git 调用，返回子命令与它之后的参数。
 *
 * 跳过 git 的全局选项：取值型（`-C <dir>` / `-c <k=v>` / `--git-dir <path>`）
 * 连它后面那个词一起跳过，布尔型（`--no-pager`）只跳过自己 —— 否则
 * `git -C repo reset --hard` 的子命令会被读成 `repo`，规则直接失明。
 */
function findGitInvocation(tokens: string[]): { subcommand: string; args: string[] } | null {
  for (let i = 0; i < tokens.length; i++) {
    if (!GIT_BINARIES.has(commandName(tokens[i]!))) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const token = tokens[j]!;
      if (!token.startsWith("-")) break;
      if (token.includes("=")) {
        j += 1;
        continue;
      }
      if (GIT_GLOBAL_VALUE_OPTIONS.has(token.toLowerCase())) {
        j += 2;
        continue;
      }
      j += 1;
    }
    const subcommand = tokens[j];
    if (!subcommand) return null;
    return { subcommand: commandName(subcommand), args: tokens.slice(j + 1) };
  }
  return null;
}

/** 该子命令+参数是否会不可逆地丢改动（repo 档口径）。 */
function isDestructiveGitCommand(subcommand: string, args: readonly string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase());
  switch (subcommand) {
    // git reset --hard 丢掉工作区与暂存区的全部未提交改动。
    case "reset":
      return lower.some((arg) => arg === "--hard" || arg.startsWith("--hard="));
    // git clean -fd 删除未跟踪文件/目录；`-n` 是 dry-run，不实际删除。
    case "clean": {
      const dryRun =
        lower.some((arg) => arg === "--dry-run") ||
        lower.some((arg) => shortFlagBundleIncludes(arg, "n"));
      const force =
        lower.some((arg) => arg === "--force") ||
        lower.some((arg) => shortFlagBundleIncludes(arg, "f"));
      return force && !dryRun;
    }
    // git checkout -- . / git checkout . / -f：用索引/HEAD 覆盖工作区。
    case "checkout":
      return discardsWorktreeViaCheckout(lower);
    // git restore 默认就是把工作区文件恢复成索引版本（丢改动）；只暂存区
    // 操作（`--staged` 且不带 `--worktree`）是安全的。
    case "restore": {
      const stagedOnly = lower.includes("--staged") && !lower.includes("--worktree");
      return !stagedOnly;
    }
    default:
      return false;
  }
}

/** `-fd` / `-fdx` 这类短选项串里是否含某个字母（`-f` 单独出现也算）。 */
function shortFlagBundleIncludes(token: string, letter: string): boolean {
  if (!/^-[A-Za-z]+$/.test(token)) return false;
  return token.slice(1).includes(letter);
}

/**
 * checkout 是否在用路径/强制方式覆盖工作区。
 *
 * 判据（宁可多拦一点，也不放过不可逆丢失）：
 *  - 出现 `--`：明确的路径检出（`git checkout -- .` / `[...] -- src/a.ts`）；
 *  - `-f` / `--force`：强制覆盖；
 *  - `-b` / `-B` / `--orphan`：这是建分支/切分支，不是用路径覆盖工作区（放行）；
 *  - 位置参数是 `.`（`git checkout .`）。
 */
function discardsWorktreeViaCheckout(lower: readonly string[]): boolean {
  if (lower.includes("--")) return true;
  if (lower.some((arg) => arg === "-f" || arg === "--force" || shortFlagBundleIncludes(arg, "f"))) {
    return true;
  }
  if (lower.some((arg) => arg === "-b" || arg === "-B" || arg === "--orphan")) return false;
  return lower
    .filter((arg) => !arg.startsWith("-"))
    .some((arg) => arg === "." || arg === "./" || arg === ".\\");
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

/**
 * 会「吃掉下一个词」的包管理器选项（取值型）。
 *
 * `npm --prefix <dir> ci` / `pnpm --dir <dir> install` / `yarn --cwd <dir>
 * install` 里的第一个非选项词其实是选项的取值。旧实现把它当成子命令，于是
 * 整条命令被判成「不是安装」—— 护栏对这类写法完全失明（审计发现的缺陷）。
 *
 * 只收这几个（外加 pnpm 的 `-C` 简写）：把所有选项都当成取值型会让
 * `npm --silent ci` 里的 `ci` 被吞掉，那是反向的失明。`--opt=value` 自带取值，
 * 不经这里。
 */
const VALUE_TAKING_MANAGER_OPTIONS: ReadonlySet<string> = new Set([
  "--prefix",
  "--dir",
  "--cwd",
  "-c",
]);

/** 这个选项是否把后一个词当作取值（`--opt=value` 不算）。 */
function takesValueOption(token: string): boolean {
  if (!token.startsWith("-") || token.includes("=")) return false;
  return VALUE_TAKING_MANAGER_OPTIONS.has(token.toLowerCase());
}

/**
 * 找出安装类调用（扫每个命令段，取该段包管理器词后的首个**真正的**子命令词）。
 *
 * 选项先跳过：取值型选项连它后面那个词一起跳过（见
 * {@link VALUE_TAKING_MANAGER_OPTIONS}），布尔型选项只跳过自己。
 */
function findInstallInvocation(segments: string[][]): { manager: string; subcommand: string } | null {
  for (const tokens of segments) {
    for (let i = 0; i < tokens.length; i++) {
      const name = commandName(tokens[i]!);
      const subcommands = INSTALL_SUBCOMMANDS[name];
      if (!subcommands) continue;
      const rest = tokens.slice(i + 1);
      let first: string | undefined;
      for (let j = 0; j < rest.length; j += 1) {
        const token = rest[j]!;
        if (token.startsWith("-")) {
          // 取值型选项：下一个词是它的取值，不是子命令。
          if (takesValueOption(token)) j += 1;
          continue;
        }
        first = token;
        break;
      }
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
 * 路径段内部的字符（小写）。`root` 后面紧跟这些字符说明它只是更长路径的
 * **前缀子串**（兄弟仓库 `J:\git\project-x` 以 `J:\git\proj` 开头），不是命中。
 *
 * 引号 / 空白 / `;` `,` `:` `=` / 括号 / `/` 等都不是段内字符 —— 带引号的
 * `--prefix "J:\git\proj"` 与 `cd "J:\git\proj"` 仍按命中处理。
 */
function isPathSegmentChar(ch: string): boolean {
  return /[a-z0-9._~-]/.test(ch);
}

/**
 * `probe`（已统一成小写正斜杠）里 `root`（归一化路径）是否作为完整路径出现。
 *
 * 不裸用 `includes`：`J:\git\project-x` 会以 `J:\git\proj` 为前缀误命中，把对
 * 兄弟仓库的操作升级成 `session` 档、终止整个合法子会话。逐个候选 occurrence
 * 检查右边界，只有 root 后面是「路径段结束」才算命中。
 */
function probeContainsRoot(probe: string, root: string): boolean {
  if (!root) return false;
  let from = 0;
  for (;;) {
    const at = probe.indexOf(root, from);
    if (at < 0) return false;
    const after = probe.charAt(at + root.length);
    if (!after || !isPathSegmentChar(after)) return true;
    from = at + 1;
  }
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
  return probeContainsRoot(probe, root);
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