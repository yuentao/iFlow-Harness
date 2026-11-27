/**
 * 超流体（Super Agent 子会话）「派发可用工作目录」的解析 —— 纯决策逻辑。
 *
 * 目标语义：没有打开任何文件夹时**永远**有可用目录，不再因为「没配置」拒绝派发。
 * 用哪个目录派发必须有**唯一**的判定点，顺序是：
 *
 *   1. 有打开的 workspaceFolder → 用它（与既有行为逐字节一致，零 I/O）；
 *   2. 没有 → 读 `iflow.superAgent.defaultWorkspace`：
 *      - 空 / 纯空白 → 跳过设置值，直接用内置默认目录；
 *      - 非绝对路径（相对路径、`~` 开头）→ **非阻断**回退内置默认目录 + 警告；
 *      - 绝对路径 → 用它；不存在则由宿主异步创建；存在但是普通文件 →
 *        **非阻断**回退内置默认目录 + 警告；
 *   3. 内置默认目录 = 宿主注入的 `~/.iflow/workspace`。本模块不硬编码用户名、
 *      不引 Node 内建（`shared/` 也会进 webview bundle），家目录由宿主用
 *      `os.homedir()` 拼好后作为参数传进来；
 *   4. 只有真正的 mkdir / stat 失败（权限、磁盘……）或内置默认目录都不可用时
 *      才拒绝，并把底层错误**原样**带回给宿主（宿主据此给出真实 errno / message）。
 *
 * 陷阱 #18（外部探测必须异步）同样适用于这里：宿主绝不做同步探测，存在性 /
 * 目录判定 / 创建全部通过注入的异步 {@link SuperWorkspaceEnsure} 完成。
 */

/** 候选目录来自哪里：用户设置值，还是内置默认目录。 */
export type SuperWorkspaceOrigin = "configured" | "builtin";

/**
 * 为什么没用用户设置值、退回内置默认目录。
 *
 * 只是提示，不阻断派发 —— 设置写错不该让用户完全用不了超流体。
 */
export interface SuperWorkspaceFallback {
  reason: "not-absolute" | "not-a-directory" | "unavailable";
  /** 用户配置的原始值（原样回显；内置目录不可用时是内置目录路径）。 */
  configured: string;
  /** `unavailable` 时是底层错误（mkdir / stat 抛出），宿主负责提取 errno / message。 */
  cause?: unknown;
}

/** 所有候选都不可用时的真实原因。 */
export type SuperWorkspaceFailure =
  | {
      reason: "directory-unavailable";
      /** 真正尝试并失败的目录。 */
      path: string;
      /** 用户配置的原始值（有值时原样回显）。 */
      configured?: string;
      /** 底层错误（mkdir / stat 抛出）。 */
      error: unknown;
    }
  | {
      reason: "not-a-directory";
      /** 真正尝试并失败的目录（内置默认目录也可能被占成普通文件）。 */
      path: string;
      /** 用户配置的原始值（有值时原样回显）。 */
      configured?: string;
    };

/** 「派发可用工作目录」的解析结果。 */
export type SuperWorkspaceResolution =
  | {
      ok: true;
      /** 绝对路径（工作区根或默认目录）。 */
      root: string;
      /** 根的来源：已打开的工作区，还是回退链（设置值 / 内置默认）。 */
      source: "workspace" | "default-workspace";
      /** 只有回退到内置默认目录时才存在。 */
      fallback?: SuperWorkspaceFallback;
    }
  | ({ ok: false } & SuperWorkspaceFailure);

/** 目录准备结果（宿主用异步 `fs.stat` / `fs.mkdir` 得出）。 */
export type SuperWorkspaceEnsureOutcome =
  | { kind: "directory" }
  | { kind: "file" }
  | { kind: "error"; error: unknown };

/**
 * 异步「确保这个绝对路径是个目录」：缺失时由宿主 `mkdir -p` 创建，再 stat 确认。
 *
 * 叫 ensure 而不是 probe 是刻意的：内置默认目录是产品自己的位置，缺失就该创建，
 * 不该要求用户先去手工建好。绝不在这里做同步 I/O。
 */
export type SuperWorkspaceEnsure = (
  absolutePath: string,
) => Promise<SuperWorkspaceEnsureOutcome>;

/** 待按序尝试的候选目录。 */
export interface SuperWorkspaceCandidate {
  path: string;
  origin: SuperWorkspaceOrigin;
  /** 已知的退回原因（例如设置值不是绝对路径）；探测后才能知道的原因由 resolve 补。 */
  fallback?: SuperWorkspaceFallback;
}

/** 纯决策的中间结果（区分「已有工作区」与「按序尝试的候选」）。 */
export type SuperWorkspacePlan =
  | { kind: "workspace"; root: string }
  | { kind: "candidates"; candidates: SuperWorkspaceCandidate[] };

/**
 * 是否绝对路径。
 *
 * 不引 `node:path`：`shared/` 会进 webview bundle。这里覆盖 Windows 盘符
 * （`C:\` / `C:/`）、UNC（`\\server\share`）与 POSIX（`/...`）；`~/x`、
 * `.\x`、`sub/dir` 都不算绝对路径 —— 用户要的就是一个明确的可执行目录。
 */
export function isAbsoluteWorkspacePath(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    value.startsWith("/")
  );
}

/**
 * 纯决策（无 I/O）：有工作区根就用它；否则给出按序尝试的候选（设置值 →
 * 内置默认目录）。空字符串 / 空白的工作区根会被忽略（多根工作区里删掉的那个）。
 *
 * `builtinWorkspace` 由宿主传入（`~/.iflow/workspace`），本模块不拼家目录。
 */
export function planSuperWorkspaceRoot(
  workspaceRoots: readonly string[],
  defaultWorkspace: string | null | undefined,
  builtinWorkspace: string,
): SuperWorkspacePlan {
  for (const candidate of workspaceRoots) {
    const root = candidate.trim();
    if (root.length > 0) return { kind: "workspace", root };
  }
  const builtin = builtinWorkspace.trim();
  const builtinCandidate: SuperWorkspaceCandidate = { path: builtin, origin: "builtin" };
  const configured = (defaultWorkspace ?? "").trim();
  if (configured.length === 0) return { kind: "candidates", candidates: [builtinCandidate] };
  if (!isAbsoluteWorkspacePath(configured)) {
    return {
      kind: "candidates",
      candidates: [
        { ...builtinCandidate, fallback: { reason: "not-absolute", configured } },
      ],
    };
  }
  // 设置值是绝对路径：先试它，不可用时再退内置默认（探测后才能确定原因）。
  return {
    kind: "candidates",
    candidates: [{ path: configured, origin: "configured" }, builtinCandidate],
  };
}

/**
 * 完整解析：纯决策 + 注入的异步 ensure。
 *
 * 有工作区时一次 I/O 都不做（既有行为零变化）；只有回退链才 `await ensure()`。
 * 设置值不可用时**不阻断**，继续尝试内置默认目录并带上 fallback 原因；只有
 * 所有候选都不可用才返回 `ok:false`，附上真实的底层错误。
 */
export async function resolveSuperWorkspaceRoot(
  workspaceRoots: readonly string[],
  defaultWorkspace: string | null | undefined,
  builtinWorkspace: string,
  ensure: SuperWorkspaceEnsure,
): Promise<SuperWorkspaceResolution> {
  const plan = planSuperWorkspaceRoot(workspaceRoots, defaultWorkspace, builtinWorkspace);
  if (plan.kind === "workspace") {
    return { ok: true, root: plan.root, source: "workspace" };
  }
  const configured = (defaultWorkspace ?? "").trim();
  const configuredForEcho = configured.length > 0 ? configured : undefined;

  /** 上一个候选失败的原因，用于给「退回内置默认」的候选带上准确 fallback。 */
  let carriedFallback: SuperWorkspaceFallback | undefined;
  let lastFailure: SuperWorkspaceFailure | null = null;

  for (const candidate of plan.candidates) {
    const outcome = await ensure(candidate.path);
    if (outcome.kind === "directory") {
      const fallback = candidate.fallback ?? carriedFallback;
      return {
        ok: true,
        root: candidate.path,
        source: "default-workspace",
        ...(fallback ? { fallback } : {}),
      };
    }
    if (outcome.kind === "file") {
      lastFailure = {
        reason: "not-a-directory",
        path: candidate.path,
        ...(configuredForEcho ? { configured: configuredForEcho } : {}),
      };
      carriedFallback = candidate.fallback ?? {
        reason: "not-a-directory",
        configured: configuredForEcho ?? candidate.path,
      };
      continue;
    }
    lastFailure = {
      reason: "directory-unavailable",
      path: candidate.path,
      error: outcome.error,
      ...(configuredForEcho ? { configured: configuredForEcho } : {}),
    };
    carriedFallback = candidate.fallback ?? {
      reason: "unavailable",
      configured: configuredForEcho ?? candidate.path,
      cause: outcome.error,
    };
  }

  if (lastFailure) return { ok: false, ...lastFailure };
  // 理论上不可达（候选至少有一个），保底仍然如实报「目录不可用」。
  return {
    ok: false,
    reason: "directory-unavailable",
    path: builtinWorkspace.trim(),
    error: new Error("no usable super workspace directory"),
  };
}