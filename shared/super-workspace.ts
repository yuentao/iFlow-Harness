/**
 * 超流体（Super Agent 子会话）「派发可用工作目录」的解析 —— 纯决策逻辑。
 *
 * 为什么单独一个模块：用户没打开任何文件夹时（直接启动 VSCode）派发超流体会
 * 被拒绝。这不是误判 —— 确实没有可用的工作区。现在允许用户在设置里配置一个
 * 默认工作区作为回退，于是「用哪个目录派发」必须有**唯一**的判定点：
 *
 *   1. 有打开的 workspaceFolder → 用它（与既有行为逐字节一致）；
 *   2. 没有 → 读 `iflow.superAgent.defaultWorkspace`；
 *   3. 设置为空 / 非绝对路径 / 不存在 / 不是目录 → 拒绝，并给出**真实原因**。
 *
 * 陷阱 #18（外部探测必须异步）同样适用于这里：宿主绝不做同步探测，所以
 * 存在性 / 目录判定通过注入的异步 {@link SuperWorkspaceProbe} 完成。本模块
 * 因此零 VSCode、零 Node 内建依赖（`shared/` 也会进 webview bundle）。
 */

/** 拒绝派发的真实原因（宿主据此给出不同 toast，不用一刀切文案）。 */
export type SuperWorkspaceRejectReason =
  | "not-configured"
  | "not-absolute"
  | "not-found"
  | "not-a-directory";

/** 「派发可用工作目录」的解析结果。 */
export type SuperWorkspaceResolution =
  | {
      ok: true;
      /** 绝对路径（工作区根或默认工作区）。 */
      root: string;
      /** 根的来源：已打开的工作区，还是设置里的默认工作区。 */
      source: "workspace" | "default-workspace";
    }
  | {
      ok: false;
      reason: SuperWorkspaceRejectReason;
      /** 用户配置的原始值（用于如实回显；not-configured 时没有值）。 */
      configured?: string;
    };

/** 目录探测结果（宿主用异步 `fs.stat` 得出）。 */
export type SuperWorkspaceProbeOutcome = "directory" | "file" | "missing";

/** 异步探测：绝不在这里做同步 I/O。 */
export type SuperWorkspaceProbe = (
  absolutePath: string,
) => Promise<SuperWorkspaceProbeOutcome>;

/** 纯决策的中间结果（区分「已有工作区」「待探测的默认工作区」「直接拒绝」）。 */
export type SuperWorkspacePlan =
  | { kind: "workspace"; root: string }
  | { kind: "default"; path: string }
  | {
      kind: "reject";
      reason: "not-configured" | "not-absolute";
      configured?: string;
    };

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
 * 纯决策（无 I/O）：有工作区根就用它，否则给出「待探测的默认工作区」或拒绝
 * 原因。空字符串 / 空白的工作区根会被忽略（多根工作区里删掉的那个）。
 */
export function planSuperWorkspaceRoot(
  workspaceRoots: readonly string[],
  defaultWorkspace: string | null | undefined,
): SuperWorkspacePlan {
  for (const candidate of workspaceRoots) {
    const root = candidate.trim();
    if (root.length > 0) return { kind: "workspace", root };
  }
  const configured = (defaultWorkspace ?? "").trim();
  if (configured.length === 0) return { kind: "reject", reason: "not-configured" };
  if (!isAbsoluteWorkspacePath(configured)) {
    return { kind: "reject", reason: "not-absolute", configured };
  }
  return { kind: "default", path: configured };
}

/**
 * 完整解析：纯决策 + 注入的异步探测。
 *
 * 有工作区时一次 I/O 都不做（既有行为零变化）；只有回退到默认工作区时才
 * `await probe()`，并按探测结果给出真实原因。
 */
export async function resolveSuperWorkspaceRoot(
  workspaceRoots: readonly string[],
  defaultWorkspace: string | null | undefined,
  probe: SuperWorkspaceProbe,
): Promise<SuperWorkspaceResolution> {
  const plan = planSuperWorkspaceRoot(workspaceRoots, defaultWorkspace);
  if (plan.kind === "workspace") {
    return { ok: true, root: plan.root, source: "workspace" };
  }
  if (plan.kind === "reject") {
    return {
      ok: false,
      reason: plan.reason,
      ...(plan.configured !== undefined ? { configured: plan.configured } : {}),
    };
  }
  const outcome = await probe(plan.path);
  if (outcome === "missing") {
    return { ok: false, reason: "not-found", configured: plan.path };
  }
  if (outcome === "file") {
    return { ok: false, reason: "not-a-directory", configured: plan.path };
  }
  return { ok: true, root: plan.path, source: "default-workspace" };
}
