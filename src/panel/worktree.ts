/**
 * Super Agent — git worktree 隔离（Extension Host only，零 vscode 依赖）。
 *
 * 每个子会话一个独立的 git worktree：分支独立、目录独立，因此多个子会话同时
 * 改同一批文件时不会互相踩踏（这正是用户要求的「防止会话之间操作文件导致
 * 冲突」）。
 *
 * 取自 Orca 的 worktree 模型（https://www.onorca.dev/docs/model/worktrees），
 * 但按本项目的边界做了三处调整：
 *  1. worktree 放在**项目内**的 `.iflow/super/worktrees/` 下 —— 子会话的工作
 *     副本跟着项目走，不写扩展的 globalStorage。这棵子树通过仓库本地
 *     `.git/info/exclude` 排除（见 `ensureSuperIsolationIgnored`），因此主仓库
 *     的 `git status` 不会被它弄脏，也不会被 `git add -A` 带进提交。
 *  2. 清理时**不静默删分支**：分支上还有未合并的提交时，删除 worktree 但保留
 *     分支，并把「有 N 个分支待审」交回用户（Orca 的 “Review N Branches”）。
 *  3. 非 git 仓库降级为一个独立空目录 —— 隔离强度只有「目录隔离」，看板与
 *     汇报都会如实标注，不谎称有版本隔离。
 *  4. worktree 建好后立刻预置一份自己的 `node_modules`（硬链接树，见
 *     `presetWorktreeDependencies`）—— 子会话在其中跑 `npm ci` 只会重装
 *     自己这份，顺链接清空主工作区依赖的事故从结构上不可能再发生。
 *
 * 已知限制（诚实声明）：worktree 只包含**已提交**的内容。主仓库里未提交的
 * 改动与未跟踪文件对子会话不可见。
 *
 * 所有 git 调用都是异步 execFile + 超时（AGENTS.md 陷阱 #18：绝不在扩展宿主
 * 里同步阻塞）。
 */

import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { Dirent, Stats } from "node:fs";
import {
  appendFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";

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
 *
 * 截断到 24 字符：worktree 目录名会出现在它内部每个文件的路径前缀里，
 * Windows 的 260 字符上限（git 默认不开 core.longpaths）很容易被长标题 +
 * 深层源文件撞上，checkout 中途失败会让整个 worktree 建不起来。
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
  return slug.length > 0 ? slug.slice(0, 24) : "task";
}

/** 分支全名。 */
export function superBranchName(slug: string): string {
  return `${SUPER_BRANCH_PREFIX}${slug}`;
}

/** Super Agent 的隔离子树（相对仓库根）。整棵子树都是扩展的临时工作区。 */
const SUPER_ISOLATION_ROOT = path.join(".iflow", "super");

/** 隔离目录：worktree / 非 git 降级目录 / 子会话附件都在项目内的同一棵子树下。 */
export function superIsolationDir(
  repoRoot: string,
  kind: "worktrees" | "dirs" | "attachments",
): string {
  return path.join(repoRoot, SUPER_ISOLATION_ROOT, kind);
}

/**
 * 把隔离子树写进仓库的本地 exclude（`.git/info/exclude`）。
 *
 * 不写 `.gitignore`：那会改动用户受版本控制的文件。exclude 是纯本地元数据，
 * 效果相同且可逆 —— 隔离子树绝不能出现在 `git status` 里（自动合并只在干净
 * 工作区上执行，见 `inspectWorkingTree`），也不能被 `git add -A` 带进提交。
 *
 * exclude 的匹配基准是**仓库根**而不是调用方的 cwd：工作区是仓库子目录时，
 * 条目必须是 `pkg/.iflow/super/` 这种相对仓库根的写法。
 *
 * 非 git 仓库 / git 不可用时静默跳过：目录隔离本来就没有版本语义。
 */
export async function ensureSuperIsolationIgnored(repoRoot: string): Promise<void> {
  let excludePath: string;
  let pattern: string;
  try {
    const [exclude, top] = await Promise.all([
      git(repoRoot, ["rev-parse", "--git-path", "info/exclude"]),
      git(repoRoot, ["rev-parse", "--show-toplevel"]),
    ]);
    const relativeExclude = exclude.stdout.trim();
    const topLevel = top.stdout.trim();
    if (!relativeExclude || !topLevel) return;
    excludePath = path.resolve(repoRoot, relativeExclude);
    const relativeRoot = path.relative(topLevel, path.join(repoRoot, SUPER_ISOLATION_ROOT));
    if (!relativeRoot || relativeRoot.startsWith("..")) return;
    pattern = `${relativeRoot.replace(/\\/g, "/")}/`;
  } catch {
    return;
  }
  try {
    const current = await readFile(excludePath, "utf8").catch(() => "");
    const lines = current.split(/\r?\n/).map((line) => line.trim());
    if (lines.includes(pattern)) return;
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await mkdir(path.dirname(excludePath), { recursive: true });
    await appendFile(excludePath, `${separator}${pattern}\n`, "utf8");
  } catch {
    // 只读仓库 / 权限问题不阻断委派：工作区变脏只会让自动合并跳过。
  }
}

/** worktree 的落盘路径：`<repoRoot>/.iflow/super/worktrees/<slug>-<unique>`。 */
export function worktreePathFor(repoRoot: string, slug: string, unique: string): string {
  return path.join(superIsolationDir(repoRoot, "worktrees"), `${slug}-${unique}`);
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

// ---------------------------------------------------------------------------
// 依赖预置：让 worktree 自带一份 node_modules
// ---------------------------------------------------------------------------
//
// 事故背景：worktree 里没有依赖时，子会话会自己建一个指向主仓 node_modules
// 的目录联接，然后跑 `npm ci` —— `npm ci` 的第一步是删 node_modules，顺着
// 联接把**用户主工作区的依赖**清空了。所以不能靠子会话自觉：让 worktree
// 里本来就有一份独立依赖，它就没有理由去联接主工作区。
//
// 用**硬链接**（同卷零额外占用，删除只是 unlink，不影响主仓文件），不是
// 联接、不是符号链接、更不是整目录拷贝（几 GB × 并发子会话不可接受）。

/** 依赖目录名（固定，不随项目变化）。 */
export const DEPENDENCIES_DIR = "node_modules";

/** 并行建硬链接的并发度：目录遍历串行，只有 link 这一步值得并行。 */
const LINK_CONCURRENCY = 16;

/**
 * 预置依赖树时用到的 FS 表面。
 *
 * 抽成接口只为单测注入（模拟跨卷 `EXDEV` / 权限失败）；生产代码一律使用
 * `defaultDependencyFs`，不做路径改写。
 */
export interface DependencyPresetFs {
  lstat(p: string): Promise<Stats>;
  stat(p: string): Promise<Stats>;
  readdir(p: string): Promise<Dirent[]>;
  mkdir(p: string): Promise<void>;
  link(src: string, dest: string): Promise<void>;
  readlink(p: string): Promise<string>;
  symlink(target: string, dest: string, type?: "file" | "dir" | "junction"): Promise<void>;
  rm(p: string): Promise<void>;
}

const defaultDependencyFs: DependencyPresetFs = {
  lstat: (p) => lstat(p),
  stat: (p) => stat(p),
  readdir: (p) => readdir(p, { withFileTypes: true }),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
  link: async (src, dest) => {
    await link(src, dest);
  },
  readlink: (p) => readlink(p),
  symlink: async (target, dest, type) => {
    await symlink(target, dest, type);
  },
  rm: async (p) => {
    await rm(p, { recursive: true, force: true });
  },
};

/** 预置被跳过的原因（都是「结构上不该做」，不是错误）。 */
export type DependencyPresetSkip = "no-source" | "already-present" | "not-ignored";

export interface DependencyPresetResult {
  /** 是否真的建出了依赖树。 */
  ok: boolean;
  /** 建出的硬链接文件数。 */
  files: number;
  /** 建出的目录数（含 node_modules 本身）。 */
  dirs: number;
  /** 按链接复制（未跟随）的符号链接 / junction 数。 */
  symlinks: number;
  /** 跳过原因（`ok` 为 true 时不填）。 */
  skip?: DependencyPresetSkip;
  /** 失败原因（跨卷 / 权限 / 路径过长等，`ok` 为 true 时不填）。 */
  error?: string;
  durationMs: number;
}

export interface LinkTreeStats {
  files: number;
  dirs: number;
  symlinks: number;
}

/**
 * 把 `source` 目录树以**硬链接**复刻到 `target`。
 *
 * - 目录真实创建（`mkdir -p`），文件 `link`，因此零额外磁盘占用；
 * - 源里的符号链接 / junction **按链接复制**（`readlink` + `symlink`），
 *   绝不跟随 —— 跟随会把链接目标的内容也做成硬链接，越界到树外；
 * - 目标已存在则跳过该项（幂等）；
 * - 任何失败都向上抛，由调用方整体回退（不退化成拷贝）。
 *
 * 导出给单测与耗时实测用；生产路径经 `presetWorktreeDependencies` 走到这里。
 */
export async function linkDependencyTree(
  source: string,
  target: string,
  overrides?: Partial<DependencyPresetFs>,
): Promise<LinkTreeStats> {
  const fs = { ...defaultDependencyFs, ...overrides };
  const plan = await collectTree(fs, source, target);
  for (const rel of plan.dirs) {
    await fs.mkdir(rel === "" ? target : path.join(target, rel));
  }
  let files = 0;
  const fileFailure = await runPool(plan.files, LINK_CONCURRENCY, async (item) => {
    try {
      await fs.link(item.src, item.dest);
      files += 1;
    } catch (error) {
      // 目标已存在 → 幂等跳过。其余错误（EXDEV / EPERM / ENAMETOOLONG）上抛。
      if (!isErrno(error, "EEXIST")) throw error;
    }
  });
  if (fileFailure) throw fileFailure;
  let symlinks = 0;
  for (const item of plan.links) {
    try {
      await replicateLink(fs, item);
      symlinks += 1;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
  return { files, dirs: plan.dirs.length, symlinks };
}

interface TreePlan {
  /** 要创建的目录（相对 target，`""` 为根）。 */
  dirs: string[];
  files: { src: string; dest: string }[];
  links: { src: string; dest: string; dir: boolean }[];
}

/** 先完整遍历再动手：遍历失败时目标树还是空的，回退成本最低。 */
async function collectTree(
  fs: DependencyPresetFs,
  source: string,
  target: string,
): Promise<TreePlan> {
  const plan: TreePlan = { dirs: [""], files: [], links: [] };
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() ?? "";
    const dir = rel === "" ? source : path.join(source, rel);
    for (const entry of await fs.readdir(dir)) {
      const childRel = rel === "" ? entry.name : path.join(rel, entry.name);
      const src = path.join(dir, entry.name);
      const dest = path.join(target, childRel);
      let isLink = entry.isSymbolicLink();
      let isDirectory = entry.isDirectory() && !isLink;
      // 目录要 lstat 复核：Windows 上普通目录与 junction 都可能被 dirent
      // 报成目录，跟进去就会把链接目标的内容硬链接进树里（越界）。普通文件
      // 不需要（它是 reparse point 时 dirent 会标成链接），省掉三万多次 lstat。
      if (isDirectory) {
        const info = await fs.lstat(src);
        if (info.isSymbolicLink()) {
          isLink = true;
          isDirectory = false;
        }
      }
      if (isLink) {
        plan.links.push({ src, dest, dir: await isDirectoryLink(fs, src) });
      } else if (isDirectory) {
        plan.dirs.push(childRel);
        stack.push(childRel);
      } else {
        plan.files.push({ src, dest });
      }
    }
  }
  return plan;
}

/** 链接目标是否为目录（跟随失败时按文件处理，不阻塞）。 */
async function isDirectoryLink(fs: DependencyPresetFs, src: string): Promise<boolean> {
  try {
    return (await fs.stat(src)).isDirectory();
  } catch {
    return false;
  }
}

/** 复刻一个符号链接（不跟随其目标）。 */
async function replicateLink(
  fs: DependencyPresetFs,
  item: { src: string; dest: string; dir: boolean },
): Promise<void> {
  let linkTarget = await fs.readlink(item.src);
  if (process.platform !== "win32") {
    await fs.symlink(linkTarget, item.dest, item.dir ? "dir" : "file");
    return;
  }
  if (!item.dir) {
    await fs.symlink(linkTarget, item.dest, "file");
    return;
  }
  // Windows：目录用 junction（无需管理员权限）。junction 要求绝对路径，且
  // Node 对 junction 的 readlink 会带 `\\?\` 前缀 —— 建链接前去掉。
  if (linkTarget.startsWith("\\\\?\\")) linkTarget = linkTarget.slice(4);
  if (!path.isAbsolute(linkTarget)) {
    linkTarget = path.resolve(path.dirname(item.src), linkTarget);
  }
  await fs.symlink(linkTarget, item.dest, "junction");
}

/**
 * 给 worktree 预置一份自己的 `node_modules`（硬链接树）。
 *
 * 三道安全闸，任一不满足就**静默跳过**（不报错、不阻塞 spawn）：
 *  1. 主仓根的 `node_modules` 不存在 / 不是真实目录；
 *  2. `node_modules` 没有被 git 忽略（否则子会话 `git add -A` 会把它提交进
 *     分支）—— 用 `git check-ignore` 在 worktree 里判定；
 *  3. 中途任何链接失败（跨卷 `EXDEV`、权限、路径过长）：删除已建的整棵树，
 *     如实记原因，**绝不退化成拷贝**。
 */
export async function presetWorktreeDependencies(options: {
  repoRoot: string;
  worktreePath: string;
  /** 单测注入（模拟 EXDEV 等）；生产代码不传。 */
  fs?: Partial<DependencyPresetFs>;
}): Promise<DependencyPresetResult> {
  const startedAt = Date.now();
  const fs = { ...defaultDependencyFs, ...options.fs };
  const skipped = { ok: false, files: 0, dirs: 0, symlinks: 0 } as const;
  const finish = (
    extra: Omit<DependencyPresetResult, "durationMs">,
  ): DependencyPresetResult => ({ ...extra, durationMs: Date.now() - startedAt });

  const source = path.join(options.repoRoot, DEPENDENCIES_DIR);
  const target = path.join(options.worktreePath, DEPENDENCIES_DIR);

  // 闸 1：主仓有真实（非链接）的 node_modules 才有东西可预置。
  let sourceInfo: Stats;
  try {
    sourceInfo = await fs.lstat(source);
  } catch {
    return finish({ ...skipped, skip: "no-source" });
  }
  if (!sourceInfo.isDirectory()) return finish({ ...skipped, skip: "no-source" });
  if (await pathExists(fs, target)) return finish({ ...skipped, skip: "already-present" });

  // 闸 2：必须被 git 忽略。尾斜杠不能省 —— git 把 `node_modules`（无斜杠）
  // 当文件判定，匹配不上 `.gitignore` 里的 `node_modules/`（实测如此）。
  const ignore = await gitRaw(options.worktreePath, [
    "check-ignore",
    "-q",
    `${DEPENDENCIES_DIR}/`,
  ]);
  if (ignore.code !== 0) return finish({ ...skipped, skip: "not-ignored" });

  // 闸 3：失败整体回退。目标树里只有本次建的链接与目录，`rm` 不跟随链接
  // （unlink 语义），删掉的只是链接名，主仓文件仍被源目录那一侧引用。
  try {
    return finish({ ok: true, ...(await linkDependencyTree(source, target, fs)) });
  } catch (error) {
    await fs.rm(target).catch(() => undefined);
    return finish({ ...skipped, error: errorMessage(error) });
  }
}

async function pathExists(fs: DependencyPresetFs, p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** 并发跑一组任务；任一项失败即停止派发并返回该错误（其余在飞任务先收尾）。 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<unknown | null> {
  let cursor = 0;
  let failure: unknown = null;
  const run = async (): Promise<void> => {
    while (failure === null) {
      const item = items[cursor++];
      if (item === undefined) return;
      try {
        await worker(item);
      } catch (error) {
        if (failure === null) failure = error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return failure;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

export interface WorktreeCreateResult {
  path: string;
  branch: string;
  baseRef: string;
  /** worktree 内依赖预置的结果（最好努力；跳过 / 失败都不影响 worktree 可用）。 */
  dependencies?: DependencyPresetResult;
}

/**
 * 建一个 worktree：`<repoRoot>` 的 `baseRef` 上拉一条新分支并 checkout 到
 * `targetPath`。
 *
 * `targetPath` 必须**不存在**（git 的硬要求），因此调用方只建父目录。
 *
 * 建完立刻预置独立的 `node_modules`（硬链接树），并在**返回前** await 完成
 * —— 调用方拿到 worktree 就会 spawn 子会话，晚于这一步就来不及了。预置是
 * 最好努力：跳过或失败都照常返回可用的 worktree（结果记在 `dependencies`）。
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
  const dependencies = await presetWorktreeDependencies({
    repoRoot: options.repoRoot,
    worktreePath: options.targetPath,
  });
  return {
    path: options.targetPath,
    branch: options.branch,
    baseRef: options.baseRef,
    dependencies,
  };
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

/**
 * 分支是否已经完全并进当前 HEAD（`git merge-base --is-ancestor`）。
 *
 * 给「让智能体合并」收尾用：智能体在会话里跑完 git 之后，宿主用它确认分支
 * 真的落了地，再补记集成结果。分支不可达 / git 不可用时返回 false —— 宁可
 * 让看板继续显示未合并，也不谎报成功。
 */
export async function isBranchMerged(options: {
  repoRoot: string;
  branch: string;
}): Promise<boolean> {
  const probe = await gitRaw(options.repoRoot, [
    "merge-base",
    "--is-ancestor",
    options.branch,
    "HEAD",
  ]);
  return probe.code === 0;
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

/**
 * 一个 worktree 目录的当前状态。
 *
 * 关键在 `kind`：**目录存在不等于它是 worktree 根**。worktree 被半删
 * （`.git` 没了、其余文件还在）时，git 会向上找到父仓库，把**主仓的状态**
 * 当成这个目录的状态 —— 于是「子会话工作目录有未提交改动」这种结论可能
 * 完全是主仓的脏文件造成的，清理流程据此做出的判断也就全错了。
 */
export interface WorktreeState {
  kind: "worktree" | "not-a-worktree" | "missing";
  /** 仅 kind === "worktree" 时有意义：该 worktree 自身是否干净。 */
  clean: boolean;
  /** 该 worktree 当前签出的分支（detached 或读不到时为 null）。 */
  branch: string | null;
}

/**
 * 路径归一化（只用于比较）：分隔符统一为 /、大小写不敏感、去掉尾部 /。
 *
 * Windows 上 git 的 `--show-toplevel` 用正斜杠并保留盘符原样大小写，而
 * `path.resolve` 给的是反斜杠 —— 不归一化就会把同一个目录判成两个。
 */
function normalizePathKey(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, "/");
  const trimmed = resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
  return trimmed.toLowerCase();
}

/** 真实路径（失败时退回词法形式）。去掉 Windows 的 `\\?\` 前缀。 */
async function realPathOrLexical(p: string): Promise<string> {
  try {
    const real = await realpath(p);
    return real.startsWith("\\\\?\\") ? real.slice(4) : real;
  } catch {
    return path.resolve(p);
  }
}

/** 路径是否存在（用 lstat：不跟随链接，链接本身存在就算存在）。 */
async function pathExistsOnDisk(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查一个路径的 worktree 状态。
 *
 * 判定顺序：
 *  - 目录不存在 → `missing`；
 *  - 目录存在，但 `git rev-parse --show-toplevel` 的输出**不是它自己**
 *    （不是 worktree 根 / `.git` 已丢 / git 报错）→ `not-a-worktree`，此时
 *    `clean` 恒为 false —— **证明不了干净就不是干净**；
 *  - 是 worktree 根 → `clean` 来自**它自己**的 `git status --porcelain`，
 *    `branch` 来自 `rev-parse --abbrev-ref HEAD`（detached 时为 null）。
 */
export async function inspectWorktreeState(worktreePath: string): Promise<WorktreeState> {
  if (!(await pathExistsOnDisk(worktreePath))) {
    return { kind: "missing", clean: false, branch: null };
  }
  const top = await gitRaw(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    return { kind: "not-a-worktree", clean: false, branch: null };
  }
  const topLevel = top.stdout.trim();
  const self = normalizePathKey(await realPathOrLexical(worktreePath));
  if (!topLevel || normalizePathKey(topLevel) !== self) {
    // 路径落在某个仓库里，但不是那个仓库的工作树根 —— 典型是半删残留：
    // `.git` 没了，git 向上找到主仓。不比对就会把主仓状态当成本目录状态。
    return { kind: "not-a-worktree", clean: false, branch: null };
  }
  const status = await gitRaw(worktreePath, ["status", "--porcelain"]);
  const branch = await currentBranch(worktreePath);
  if (status.code !== 0) {
    // 是 worktree，但状态读不到（索引损坏等）—— 不能证明干净。
    return { kind: "worktree", clean: false, branch };
  }
  const clean = !status.stdout.split(/\r?\n/).some((line) => line.trim().length > 0);
  return { kind: "worktree", clean, branch };
}

/**
 * worktree 里是否还有未提交的改动。
 *
 * 自动清理只在「合并成功」之后发生，但合并成功不代表 worktree 干净 —— 子会话
 * 代提交之后它可能又写了文件，用户也可能在里面手动改过。删目录是不可逆的，
 * 因此这里**只回答「能不能确定它是干净的」**：
 *  - 拿不到状态（目录不存在 / 不是 worktree 根 / git 报错）→ 一律 true，
 *    宁可留下一个目录让用户自己删，也不静默丢掉未提交的工作；
 *  - 是 worktree → 只看**它自己**的 status，绝不把父仓库的状态算进来
 *    （半删残留目录里 git 会向上找到主仓，那是主仓的脏，不是这个目录的）。
 */
export async function worktreeHasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const state = await inspectWorktreeState(worktreePath);
  if (state.kind !== "worktree") return true;
  return !state.clean;
}

// ---------------------------------------------------------------------------
// 删除：重试 + 复核
// ---------------------------------------------------------------------------

/**
 * 删除失败时的退避序列（毫秒）。
 *
 * Windows 上 `fs.rm` 失败多半是**瞬时**占用：子进程刚退出、句柄还没释放、
 * 杀软在扫、文件索引器在读。这类失败稍后重试往往就成功了。但删除发生在
 * 扩展宿主里，总预算必须小 —— 宁可如实报「没删掉」，也不能把面板卡住。
 */
const REMOVE_RETRY_DELAYS_MS = [50, 150, 400, 800, 1200];

/** 删除重试的总时间预算（毫秒）。 */
const REMOVE_RETRY_BUDGET_MS = 5_000;

/** 值得重试的瞬时错误码（其余错误重试也没有意义）。 */
const TRANSIENT_REMOVE_CODES = new Set([
  "EBUSY",
  "EPERM",
  "ENOTEMPTY",
  "EMFILE",
  "ENFILE",
]);

/**
 * 默认的删除动作：Node 的递归删除。
 *
 * 必须由 Node 递归删除，**不能**交给 `git worktree remove --force`：
 * Windows 上 git 会把 junction 当目录递归进去，删掉链接目标。预置的依赖树
 * 里复刻了源中的 junction（指向主仓 packages/ 等位置），实测（2026-11-11，
 * test/worktree-dependencies.test.ts 的清理用例）git 的删除会把主仓那一侧的
 * 文件一起删掉。`fs.rm` 按 lstat 判定，链接只 unlink、不跟随目标；硬链接
 * 文件也只是摘掉本目录里的名字。
 */
const defaultRemoveDir = async (targetPath: string): Promise<void> => {
  await rm(targetPath, { recursive: true, force: true, maxRetries: 3 });
};

function isTransientRemoveError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && TRANSIENT_REMOVE_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface RemovalOutcome {
  removed: boolean;
  /** 失败原因（removed 为 false 时有值）：残留目录 / 错误信息。 */
  error?: string;
}

/**
 * 删目录：**重试 + 复核**。
 *
 * 「`fs.rm` 没抛错」不等于「目录已删」—— Windows 上部分删除（删掉一部分
 * 内容就失败）非常常见，旧实现只看不抛错，于是把没删净的目录当成删掉了
 * （现场：worktree 残留目录还在，归档里却写着 released=true）。
 *
 * 因此每次删除动作之后都用 lstat 复核路径真的没了；还在就继续重试（瞬时
 * 错误按退避、部分删除直接再删一次），最终仍未删净则如实报失败。
 */
async function removeDirectoryWithRetry(
  targetPath: string,
  removeDir: (p: string) => Promise<void>,
  retryDelaysMs: number[],
): Promise<RemovalOutcome> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await removeDir(targetPath);
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    // 复核：不管删除动作报没报错，路径还在就是没删掉。
    if (!(await pathExistsOnDisk(targetPath))) return { removed: true };
    const delay = retryDelaysMs[attempt];
    if (delay === undefined) break;
    // 非瞬时错误（权限被永久拒绝之类）重试没有意义。
    if (lastError !== null && !isTransientRemoveError(lastError)) break;
    if (Date.now() - startedAt + delay >= REMOVE_RETRY_BUDGET_MS) break;
    await sleep(delay);
  }
  return {
    removed: false,
    error: lastError === null ? "残留目录" : errorMessage(lastError),
  };
}

export interface WorktreeRemoveOptions {
  repoRoot: string;
  targetPath: string;
  branch?: string;
  baseRef?: string;
  keepBranch?: boolean;
  /**
   * 删除目录的动作（单测注入）。默认是 `fs.rm` 递归删除（不跟随链接）。
   */
  removeDir?: (targetPath: string) => Promise<void>;
  /** 重试退避序列（单测注入更短的序列）。 */
  retryDelaysMs?: number[];
}

export interface WorktreeRemoveResult {
  /** worktree 目录是否已被**真正**删除（复核过路径不存在）。 */
  removed: boolean;
  /**
   * 分支是否被保留。
   *
   * 目录没删净、有未合并提交、用户显式要求或分支删除失败时都必须保留。
   */
  branchKept: boolean;
  /** 原因（branchKept 为 true 或 removed 为 false 时有值）。 */
  reason?: string;
}

/**
 * 移除 worktree。
 *
 * 删除走「重试 + 复核」：目录没真的删掉就算失败（`removed=false`），并给出
 * 可读原因；此时**显式保留分支** —— 旧实现是「碰巧」因为 `git branch -D`
 * 对仍被签出的分支失败才保住分支，那是偶然行为，不是保证。
 *
 * `keepBranch` 为 false、目录已删净、且分支上没有未合并提交时才删分支；
 * 否则保留分支并说明原因（Orca 的 “Review N Branches”：不静默吞掉用户
 * 可能需要的提交）。
 */
export async function removeWorktree(
  options: WorktreeRemoveOptions,
): Promise<WorktreeRemoveResult> {
  const outcome = await removeDirectoryWithRetry(
    options.targetPath,
    options.removeDir ?? defaultRemoveDir,
    options.retryDelaysMs ?? REMOVE_RETRY_DELAYS_MS,
  );
  const removed = outcome.removed;
  // 目录删净与否都要清掉 git 的 worktree 元数据（对已不存在的记账幂等）；
  // 目录未被删净时如实返回 removed=false，交由调用方保留记录并上报。
  await git(options.repoRoot, ["worktree", "prune"]).catch(() => undefined);

  const branch = options.branch;
  if (!removed) {
    // 目录还在 —— 分支仍被这个 worktree 签出（git 也会拒绝删它），但不能
    // 依赖那个偶然行为：显式保留，并把删除失败的原因如实带上。
    const detail = outcome.error ?? "未知原因";
    return {
      removed,
      branchKept: Boolean(branch),
      reason: `目录未删净（${detail}）${branch ? "，分支已保留" : ""}`,
    };
  }
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
 * **只撤销我们自己的合并。** `git merge --abort` 撤销的是「当前仓库里进行中
 * 的那次合并」—— 如果用户此刻正在他自己的终端里合并，我们这次合并失败后
 * 无条件 abort 就会把**用户的那次合并**一起撤销掉：用户解决到一半的冲突、
 * 已暂存的改动、暂存区的状态，全没了。那是替用户毁掉工作。
 *
 * 所以这里有两道闸：
 *  1. 合并**之前**先探测中间态：仓库已经停在 merge / rebase / cherry-pick
 *     里（那是用户的操作）就根本**不启动**合并，直接如实报错；
 *  2. 合并**失败之后**只有当「我们启动前没有 MERGE_HEAD、现在有」时才
 *     abort —— 那说明这个中间态确实是本次合并留下的，撤销它才是清理我们的
 *     烂摊子，而不是动用户的东西。
 *
 * 预演冲突的路径压根不会走到这里（`previewMerge` 发现冲突时连 merge 都不
 * 启动），仓库从头到尾没被碰过。
 */
export async function mergeBranch(options: {
  repoRoot: string;
  branch: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // 闸 1：用户正在合并/变基/拣选 → 绝不叠加第二次合并，更不碰他的中间态。
  const before = await detectInProgress(options.repoRoot);
  if (before) {
    return {
      ok: false,
      error: `the repository is already in the middle of a ${before}; the merge was not started`,
    };
  }
  try {
    await git(options.repoRoot, ["merge", "--no-ff", "--no-edit", options.branch]);
    return { ok: true };
  } catch (error) {
    // 闸 2：只有当 MERGE_HEAD 是本次合并留下的才撤销它。
    const after = await detectInProgress(options.repoRoot);
    if (after === "merge") {
      await git(options.repoRoot, ["merge", "--abort"]).catch(() => undefined);
    }
    return { ok: false, error: errorMessage(error) };
  }
}

export interface MergePreview {
  /** 能否预演（git 太旧 / 多个 merge base / 分支不可达时为 false → 调用方必须保守）。 */
  available: boolean;
  /** HEAD 与分支能否无冲突自动合并（available 为 false 时无意义）。 */
  clean: boolean;
  /**
   * 这次合并可能写入 / 删除的路径：两侧相对 merge-base 的改动并集（保守超集，
   * 正斜杠、相对仓库根）。调用方拿它与本地未提交的**已跟踪**改动求交。
   */
  paths: string[];
}

/**
 * 非破坏性合并预演。
 *
 * `git merge-tree --write-tree` 只操作对象库：写出的 tree 对象留在 loose
 * objects 里（无害、可 GC），**索引与工作区一律不动**，也不会留下 MERGE_HEAD。
 * 因此「会不会冲突」可以在真正 merge 之前问清楚 —— 冲突时连 `merge --abort`
 * 都不需要，仓库从头到尾没被碰过。
 *
 * 旧版 git（< 2.38，不认 `--write-tree`）与多个 merge base 的场景返回
 * `available: false`，调用方退回「要求工作区干净」的保守策略。
 */
export async function previewMerge(options: { repoRoot: string; branch: string }): Promise<MergePreview> {
  const unavailable: MergePreview = { available: false, clean: false, paths: [] };
  let base: string;
  let childPaths: string[];
  let mainPaths: string[];
  try {
    base = (await git(options.repoRoot, ["merge-base", "HEAD", options.branch])).stdout.trim();
    if (!base) return unavailable;
    childPaths = await changedPaths(options.repoRoot, base, options.branch);
    mainPaths = await changedPaths(options.repoRoot, base, "HEAD");
  } catch {
    return unavailable;
  }
  const paths = [...new Set([...childPaths, ...mainPaths])];
  const probe = await gitRaw(options.repoRoot, ["merge-tree", "--write-tree", "HEAD", options.branch]);
  if (probe.code === 0) return { available: true, clean: true, paths };
  // exit code 1 = 合并有冲突；>1 或进程级失败 = 命令不可用（旧版 git 等）。
  if (probe.code === 1) return { available: true, clean: false, paths };
  return unavailable;
}

/** 两个提交之间改动过的路径（`--no-renames`：重命名拆成删除 + 新增）。 */
async function changedPaths(repoRoot: string, from: string, to: string): Promise<string[]> {
  const { stdout } = await git(repoRoot, ["diff", "--no-renames", "--name-only", "-z", from, to]);
  return splitNul(stdout);
}

/** `-z` 输出的 NUL 分隔列表（路径里可能含空格 / 换行，不能按行拆）。 */
function splitNul(text: string): string[] {
  return text.split("\0").filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// 集成：把子会话的改动带回主工作区（自动合并 / PR）
// ---------------------------------------------------------------------------

/**
 * 主工作区的状态。
 *
 * `clean === false` 本身**不是**拒绝合并的理由：git 能安全地把未提交改动带着
 * 一起合并，只要这次合并不碰那些文件。真正必须让路的只有两种情况 ——
 * 仓库停在 merge / rebase / cherry-pick 中间态（不能再叠一次合并），以及
 * 合并会改动的路径与「已跟踪文件的未提交改动」有交集（`trackedPaths`，调用方
 * 与 `previewMerge().paths` 求交后判断）。未跟踪文件单独计（`untrackedCount`）：
 * git 只在合并要创建同名文件时才拒绝，而且拒绝发生在动手之前、工作区不变。
 */
export interface WorkingTreeState {
  /** 状态是否真的读到了（false = git 不可用 / 仓库损坏，调用方必须保守处理）。 */
  available: boolean;
  clean: boolean;
  /** 未提交的条目数（已跟踪改动路径数 + 未跟踪文件数）。 */
  dirtyCount: number;
  /** 仓库是否停在 merge / rebase / cherry-pick 中间态。 */
  inProgress: "merge" | "rebase" | "cherry-pick" | null;
  /** 已跟踪文件的未提交改动路径（含删除与重命名两侧；相对仓库根、正斜杠）。 */
  trackedPaths: string[];
  /** 未跟踪文件数。 */
  untrackedCount: number;
}

/**
 * 仓库是否停在 merge / rebase / cherry-pick 中间态（只读探测）。
 *
 * 判据是 git 自己的中间态标记文件：MERGE_HEAD / REBASE_HEAD /
 * CHERRY_PICK_HEAD 存在，就说明**有人**（用户或我们）正在这个仓库里做一次
 * 合并 / 变基 / 拣选。
 *
 * 单独抽出来的原因：自动合并必须能区分「这个中间态是我们自己这次合并留下的」
 * 与「这是用户先前就在做的」。前者可以撤销，后者绝不能碰 —— 撤销用户的
 * 合并等于替用户毁掉工作。
 */
export async function detectInProgress(
  repoRoot: string,
): Promise<WorkingTreeState["inProgress"]> {
  const has = async (ref: string): Promise<boolean> => {
    try {
      await git(repoRoot, ["rev-parse", "-q", "--verify", ref]);
      return true;
    } catch {
      return false;
    }
  };
  if (await has("MERGE_HEAD")) return "merge";
  if (await has("REBASE_HEAD")) return "rebase";
  if (await has("CHERRY_PICK_HEAD")) return "cherry-pick";
  return null;
}

export async function inspectWorkingTree(repoRoot: string): Promise<WorkingTreeState> {
  // `git diff HEAD` 覆盖已暂存 + 未暂存的已跟踪改动（不含未跟踪文件）；
  // `--no-renames` 让重命名拆成删除 + 新增两侧，两边路径都进集合（保守）。
  // `-z` 用 NUL 分隔，路径里即便有空格 / 换行也不会被转义或拆错。
  let trackedPaths: string[];
  let untrackedCount: number;
  try {
    const tracked = await git(repoRoot, ["diff", "--no-renames", "--name-only", "-z", "HEAD"]);
    trackedPaths = splitNul(tracked.stdout);
    const untracked = await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
    untrackedCount = splitNul(untracked.stdout).length;
  } catch {
    // 连状态都拿不到 —— 保守当作不可合并。
    return {
      available: false,
      clean: false,
      dirtyCount: 0,
      inProgress: null,
      trackedPaths: [],
      untrackedCount: 0,
    };
  }
  const inProgress = await detectInProgress(repoRoot);
  const dirtyCount = trackedPaths.length + untrackedCount;
  return {
    available: true,
    clean: dirtyCount === 0 && inProgress === null,
    dirtyCount,
    inProgress,
    trackedPaths,
    untrackedCount,
  };
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

/**
 * 与 `git()` 同源，但把子进程退出码原样返回而不是抛错。
 *
 * `git merge-tree --write-tree` 用退出码表达语义（0 = 干净、1 = 冲突、
 * >1 = 命令失败），三个结果必须分开处理：把冲突当成「命令不可用」会让调用方
 * 退到保守策略多绕一圈，反过来把不可用当成冲突则会误报。
 */
async function gitRaw(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
    });
    return { code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof failure.code === "number" ? failure.code : -1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
    };
  }
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
