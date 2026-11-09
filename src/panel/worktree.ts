/**
 * Super Agent — git worktree 隔离（Extension Host only，零 vscode 依赖）。
 *
 * 每个子会话一个独立的 git worktree：分支独立、目录独立，因此多个子会话同时
 * 改同一批文件时不会互相踩踏（这正是用户要求的「防止会话之间操作文件导致
 * 冲突」）。
 *
 * 取自 Orca 的 worktree 模型（https://www.onorca.dev/docs/model/worktrees），
 * 但按本项目的边界做了三处调整：
 *  1. worktree 放在扩展的 globalStorage 下、**仓库之外** —— 放进仓库会让主
 *     仓库的 `git status` 多出一个未跟踪目录。
 *  2. 清理时**不静默删分支**：分支上还有未合并的提交时，删除 worktree 但保留
 *     分支，并把「有 N 个分支待审」交回用户（Orca 的 “Review N Branches”）。
 *  3. 非 git 仓库降级为一个独立空目录 —— 隔离强度只有「目录隔离」，看板与
 *     汇报都会如实标注，不谎称有版本隔离。
 *
 * 已知限制（诚实声明）：worktree 只包含**已提交**的内容。主仓库里未提交的
 * 改动与未跟踪文件对子会话不可见。
 *
 * 所有 git 调用都是异步 execFile + 超时（AGENTS.md 陷阱 #18：绝不在扩展宿主
 * 里同步阻塞）。
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";

const execFileAsync = promisify(execFileCb);

/** 单条 git 命令的超时。worktree add 可能会 checkout 一棵大目录树。 */
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** worktree 分支的命名空间（与用户的分支隔开，清理时可整体识别）。 */
export const SUPER_BRANCH_PREFIX = "iflow/super/";

// ---------------------------------------------------------------------------
// 纯函数：命名
// ---------------------------------------------------------------------------

/**
 * 把任务标题转成适合当目录名 / 分支名的一段 slug。
 *
 * 保留 Unicode 字母数字与 `-`；其余（空格、标点、路径分隔符）折叠成 `-`；
 * 连续的 `-` 合并；首尾的 `-` 去掉。中文标题原样保留（git 分支名支持
 * UTF-8，目录名在 NTFS / APFS 上也安全），空结果回退为 `task` —— 目录名
 * 另有随机后缀，重名不会真的撞上。
 */
export function sanitizeWorktreeName(raw: string): string {
  const slug = raw
    .normalize("NFKD")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return slug.length > 0 ? slug.slice(0, 40) : "task";
}

/** 分支全名。 */
export function superBranchName(slug: string): string {
  return `${SUPER_BRANCH_PREFIX}${slug}`;
}

/**
 * 仓库的稳定标识：目录名 + 绝对路径的短哈希。同名目录（`~/a/api` 与 `~/b/api`）
 * 因此不会互相覆盖。
 */
export function repoSlug(repoRoot: string): string {
  const base = path.basename(repoRoot) || "repo";
  const safe = base.replace(/[^\w.-]+/g, "-").slice(0, 30);
  const hash = createHash("sha1").update(path.resolve(repoRoot)).digest("hex").slice(0, 8);
  return `${safe}-${hash}`;
}

/** worktree 的落盘路径：`<storage>/super-worktrees/<repoSlug>/<slug>-<unique>`。 */
export function worktreePathFor(storageRoot: string, repoRoot: string, slug: string, unique: string): string {
  return path.join(storageRoot, "super-worktrees", repoSlug(repoRoot), `${slug}-${unique}`);
}

/** git 在 Windows 上更稳地接受正斜杠路径。 */
function gitPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// git 操作
// ---------------------------------------------------------------------------

export interface GitRepoProbe {
  isRepo: boolean;
  /** HEAD 的 commit sha（非仓库时为 null）。 */
  head: string | null;
}

/** 判断目录是否在 git 仓库内，并取当前 HEAD。 */
export async function probeGitRepo(repoRoot: string): Promise<GitRepoProbe> {
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
    if (stdout.trim() !== "true") return { isRepo: false, head: null };
  } catch {
    return { isRepo: false, head: null };
  }
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "HEAD"]);
    return { isRepo: true, head: stdout.trim() || null };
  } catch {
    // 空仓库（还没有任何提交）——仍是仓库，但没有可用起点。
    return { isRepo: true, head: null };
  }
}

export interface WorktreeCreateResult {
  path: string;
  branch: string;
  baseRef: string;
}

/**
 * 建一个 worktree：`<repoRoot>` 的 `baseRef` 上拉一条新分支并 checkout 到
 * `targetPath`。
 *
 * `targetPath` 必须**不存在**（git 的硬要求），因此调用方只建父目录。
 */
export async function createWorktree(options: {
  repoRoot: string;
  targetPath: string;
  branch: string;
  baseRef: string;
}): Promise<WorktreeCreateResult> {
  await mkdir(path.dirname(options.targetPath), { recursive: true });
  await git(options.repoRoot, [
    "worktree",
    "add",
    "-b",
    options.branch,
    gitPath(options.targetPath),
    options.baseRef,
  ]);
  return { path: options.targetPath, branch: options.branch, baseRef: options.baseRef };
}

/** worktree 是否还有未合并到 baseRef 的提交。 */
export async function branchHasUnmergedCommits(options: {
  repoRoot: string;
  branch: string;
  baseRef: string;
}): Promise<boolean> {
  try {
    const { stdout } = await git(options.repoRoot, [
      "rev-list",
      "--count",
      `${options.baseRef}..${options.branch}`,
    ]);
    return Number.parseInt(stdout.trim(), 10) > 0;
  } catch {
    // 分支已被删除或 baseRef 不可达 —— 保守当作「有未合并提交」，宁可让用户
    // 多点一次，也不要静默丢掉工作。
    return true;
  }
}

export interface WorktreeCommitResult {
  /** 是否产生了新提交（工作区本来就干净时为 false）。 */
  committed: boolean;
  /** 提交的改动条目数（`git status --porcelain` 非空行数）。 */
  files: number;
  /** 提交失败的原因（失败时工作区保持原样，绝不回滚用户工作）。 */
  error?: string;
}

/**
 * 把子会话 worktree 里未提交的改动固化成一个提交。
 *
 * 自动合并 / PR 只认**提交**，而子会话不一定自己 commit（系统提示禁止未经
 * 明示的提交）。宿主因此在子会话正常结束后补这一刀：只在它自己的 worktree
 * 内执行（主工作区完全不受影响），不推送、不切换分支、不 --no-verify ——
 * 钩子失败就如实上报并保留分支，绝不绕过项目检查。
 */
export async function commitWorktree(options: {
  repoRoot: string;
  worktreePath: string;
  message: string;
}): Promise<WorktreeCommitResult> {
  let files = 0;
  try {
    const { stdout } = await git(options.worktreePath, ["status", "--porcelain"]);
    files = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch (error) {
    return { committed: false, files: 0, error: errorMessage(error) };
  }
  if (files === 0) return { committed: false, files: 0 };
  try {
    await git(options.worktreePath, ["add", "-A"]);
    // 显式身份：子会话的提交不能依赖用户全局 git 配置是否存在。
    await git(options.worktreePath, [
      "-c",
      "user.name=iFlow Harness",
      "-c",
      "user.email=iflow-harness@local",
      "commit",
      "-m",
      options.message,
    ]);
    return { committed: true, files };
  } catch (error) {
    return { committed: false, files, error: errorMessage(error) };
  }
}

export interface WorktreeRemoveResult {
  /** worktree 目录是否已被移除。 */
  removed: boolean;
  /** 分支是否被保留（有未合并提交时必须保留）。 */
  branchKept: boolean;
  /** 保留分支的原因（branchKept 为 true 时有值）。 */
  reason?: string;
}

/**
 * 移除 worktree。
 *
 * `keepBranch` 为 false 且分支上没有未合并提交时才删分支；否则保留分支并
 * 说明原因（Orca 的 “Review N Branches”：不静默吞掉用户可能需要的提交）。
 */
export async function removeWorktree(options: {
  repoRoot: string;
  targetPath: string;
  branch?: string;
  baseRef?: string;
  keepBranch?: boolean;
}): Promise<WorktreeRemoveResult> {
  let removed = false;
  try {
    await git(options.repoRoot, ["worktree", "remove", "--force", gitPath(options.targetPath)]);
    removed = true;
  } catch {
    // git 拒绝删除（目录已被手工改坏 / 已被删）——退回到直接删目录 + prune。
    await git(options.repoRoot, ["worktree", "prune"]);
    removed = true;
  }

  const branch = options.branch;
  if (!branch) return { removed, branchKept: false };
  if (options.keepBranch) {
    return { removed, branchKept: true, reason: "用户选择保留分支" };
  }
  if (options.baseRef && (await branchHasUnmergedCommits({ repoRoot: options.repoRoot, branch, baseRef: options.baseRef }))) {
    return { removed, branchKept: true, reason: "分支上还有未合并的提交，已保留待你审阅" };
  }
  try {
    await git(options.repoRoot, ["branch", "-D", branch]);
    return { removed, branchKept: false };
  } catch {
    return { removed, branchKept: true, reason: "分支删除失败，已保留" };
  }
}

/**
 * 把子会话的分支合并回当前分支。
 *
 * 合并失败（冲突）时执行 `git merge --abort` 还原，绝不把用户仓库留在冲突
 * 状态里 —— 冲突由用户在自己的终端里解决。
 */
export async function mergeBranch(options: {
  repoRoot: string;
  branch: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await git(options.repoRoot, ["merge", "--no-ff", "--no-edit", options.branch]);
    return { ok: true };
  } catch (error) {
    await git(options.repoRoot, ["merge", "--abort"]).catch(() => undefined);
    return { ok: false, error: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// 集成：把子会话的改动带回主工作区（自动合并 / PR）
// ---------------------------------------------------------------------------

/**
 * 主工作区的状态。自动合并**只在干净、且不在中间态的工作区上执行** —— 合并
 * 会改写工作树，用户未提交的改动一旦混进冲突回滚就可能在不知情中丢失。
 */
export interface WorkingTreeState {
  clean: boolean;
  /** 未提交的条目数（已跟踪改动 + 未跟踪文件）。 */
  dirtyCount: number;
  /** 仓库是否停在 merge / rebase / cherry-pick 中间态。 */
  inProgress: "merge" | "rebase" | "cherry-pick" | null;
}

export async function inspectWorkingTree(repoRoot: string): Promise<WorkingTreeState> {
  let dirtyCount = 0;
  try {
    const { stdout } = await git(repoRoot, ["status", "--porcelain"]);
    dirtyCount = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch {
    // 连 status 都拿不到 —— 保守当作不可合并。
    return { clean: false, dirtyCount: 0, inProgress: null };
  }
  const has = async (ref: string): Promise<boolean> => {
    try {
      await git(repoRoot, ["rev-parse", "-q", "--verify", ref]);
      return true;
    } catch {
      return false;
    }
  };
  let inProgress: WorkingTreeState["inProgress"] = null;
  if (await has("MERGE_HEAD")) inProgress = "merge";
  else if (await has("REBASE_HEAD")) inProgress = "rebase";
  else if (await has("CHERRY_PICK_HEAD")) inProgress = "cherry-pick";
  return { clean: dirtyCount === 0 && inProgress === null, dirtyCount, inProgress };
}

/** 工作区的当前分支（detached HEAD 时为 null）。 */
export async function currentBranch(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const name = stdout.trim();
    return name && name !== "HEAD" ? name : null;
  } catch {
    return null;
  }
}

/** origin 的 URL；没有配置 origin 时为 null。 */
export async function remoteOriginUrl(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["remote", "get-url", "origin"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * gh CLI 是否可用。探测一次后缓存（AGENTS.md 陷阱 #18：外部进程探测必须
 * 异步，绝不在扩展宿主里同步阻塞 —— `where gh` 在 Windows 上可达数秒）。
 */
let ghProbe: Promise<boolean> | null = null;
export function ghAvailable(): Promise<boolean> {
  if (!ghProbe) {
    ghProbe = execFileAsync("gh", ["--version"], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
    }).then(
      () => true,
      () => false,
    );
  }
  return ghProbe;
}

/** 推送分支到远程（不做 force push）。 */
export async function pushBranch(options: {
  repoRoot: string;
  branch: string;
  remote?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await git(options.repoRoot, [
      "push",
      options.remote ?? "origin",
      `${options.branch}:${options.branch}`,
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * 用 gh 创建 PR。gh 缺失 / 未登录 / 无远程时返回错误原文 —— 调用方据此
 * 如实标注「PR 未创建」并保留分支，绝不假装成功。
 */
export async function createPullRequest(options: {
  repoRoot: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "create",
        "--head",
        options.branch,
        "--base",
        options.base,
        "--title",
        options.title,
        "--body",
        options.body,
      ],
      {
        cwd: options.repoRoot,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
      },
    );
    const match = /(https?:\/\/\S+)/.exec(stdout ?? "");
    return { ok: true, url: match?.[1] ?? "" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** worktree 列表（porcelain 输出）。 */
export async function listWorktrees(repoRoot: string): Promise<{ path: string; branch: string | null }[]> {
  try {
    const { stdout } = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    const result: { path: string; branch: string | null }[] = [];
    let currentPath: string | null = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch ") && currentPath) {
        // porcelain prints the FULL ref ("refs/heads/iflow/super/x"); the
        // callers compare against short branch names.
        result.push({
          path: currentPath,
          branch: line.slice("branch ".length).trim().replace(/^refs\/heads\//, ""),
        });
        currentPath = null;
      } else if (line === "detached" && currentPath) {
        result.push({ path: currentPath, branch: null });
        currentPath = null;
      }
    }
    return result;
  } catch {
    return [];
  }
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    encoding: "utf8",
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    // execFile 的 message 形如 "Command failed: git …\n<stderr>"，取 stderr 那段更有用。
    const text = error.message;
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1).trim() || text : text;
  }
  return String(error);
}
