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
import { existsSync } from "node:fs";
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

/** 单条 git 命令的默认超时（只读探测、提交、合并等，都是秒级操作）。 */
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * `git worktree add` 单独的超时。
 *
 * 它是唯一会把整棵工作树写进磁盘的命令：大仓库 + 并发 checkout + 杀软扫描，
 * 30s 是**能跑完**的常见耗时而不是天花板，共用 30s 会把「慢」误判成「坏」。
 * 更长的超时只影响卡死场景的报错延迟，不影响正常路径。
 */
export const WORKTREE_CREATE_TIMEOUT_MS = 120_000;

/**
 * worktree 创建失败后的重试退避（毫秒），共 3 次尝试 = 首次 + 2 次重试。
 *
 * 首次失败多半是瞬时冲突（并发 checkout / 杀软刚锁住刚建的目录 / 索引写
 * 竞争），隔一点时间再试通常就过去了。
 */
const WORKTREE_CREATE_RETRY_DELAYS_MS = [300, 1_000];

/** worktree 创建的最大尝试次数（首次 + 两次重试）。 */
const WORKTREE_CREATE_MAX_ATTEMPTS = 3;

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
    // git 给的是 **realpath** 形式（macOS 的 `/var` → `/private/var`、Windows
    // 目录联接会被解析成目标路径），而 repoRoot 可能还是链接形式。两侧都先
    // 归一，否则 path.relative 会返回一条以 `..` 开头的「逃出仓库根」的路径，
    // 下面的守卫直接 return —— exclude 一个字都没写，主工作区被弄脏。
    const topLevelReal = await realPathOrLexical(topLevel);
    const isolationReal = await realPathOrLexical(path.join(repoRoot, SUPER_ISOLATION_ROOT));
    const relativeRoot = path.relative(topLevelReal, isolationReal);
    if (
      !relativeRoot ||
      relativeRoot.startsWith("..") ||
      path.isAbsolute(relativeRoot)
    ) {
      return;
    }
    pattern = `${relativeRoot.replace(/\\/g, "/")}/`;
  } catch {
    return;
  }
  const key = `${excludePath}\n${pattern}`;
  const previous = pendingSuperIgnore.get(key) ?? Promise.resolve();
  const next = previous.then(() => appendSuperIgnoreOnce(excludePath, pattern, key));
  pendingSuperIgnore.set(key, next.then(() => undefined, () => undefined));
  await next;
}

/** 一次幂等的 exclude 追加；同一目标在进程内只做一次读 / 写。 */
async function appendSuperIgnoreOnce(excludePath: string, pattern: string, key: string): Promise<void> {
  if (superIgnoreWritten.has(key)) return;
  try {
    const current = await readFile(excludePath, "utf8").catch(() => "");
    const lines = current.split(/\r?\n/).map((line) => line.trim());
    if (lines.includes(pattern)) {
      superIgnoreWritten.add(key);
      return;
    }
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await mkdir(path.dirname(excludePath), { recursive: true });
    await appendFile(excludePath, `${separator}${pattern}\n`, "utf8");
    superIgnoreWritten.add(key);
  } catch {
    // 只读仓库 / 权限问题不阻断委派：工作区变脏只会让自动合并跳过。
  }
}

/** 已经确认写入过 exclude 行的目标（键 = 绝对路径 + pattern）。 */
const superIgnoreWritten = new Set<string>();

/** 同一目标的 exclude 追加串行链（并发 prepare 时不重复读 / 写）。 */
const pendingSuperIgnore = new Map<string, Promise<void>>();

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
    if (item.dir && item.external) {
      // 指向 source 之外的目录链接（典型是 junction 指回主仓 packages/ 等）：
      // 绝不建 junction —— 子代理经它的写操作会穿透回主仓。改成 worktree 内的
      // 真实空目录，读写都落在这个子会话自己的副本里，主仓不受影响。
      try {
        await fs.mkdir(item.dest);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      continue;
    }
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
  /**
   * 要按链接复刻的项。`external` = 解析后的目标在 source（node_modules）之外 ——
   * 这类目录链接若照建 junction，子代理经它的写操作会穿透回主仓，必须在
   * worktree 内改成真实空目录（见 `linkDependencyTree`）。
   */
  links: { src: string; dest: string; dir: boolean; target: string; external: boolean }[];
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
        const target = await fs.readlink(src);
        plan.links.push({
          src,
          dest,
          dir: await isDirectoryLink(fs, src),
          target,
          external: linksOutside(source, src, target),
        });
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

/**
 * 链接目标解析后是否落在 source（node_modules）之外。
 *
 * 指向树外的目录链接若照建 junction，子代理经它的写操作会穿透回主仓 ——
 * 这类链接必须在 worktree 内改成真实空目录（见 `linkDependencyTree`）。
 * Windows junction 的 readlink 带扩展长度前缀且为绝对路径，POSIX 相对链接
 * 以 src 所在目录为基准解析。失败时保守当作「在树内」，避免误伤包内链接。
 */
function linksOutside(source: string, src: string, target: string): boolean {
  try {
    const winPrefix = String.fromCharCode(92, 92, 63, 92); // Windows 扩展长度前缀
    const stripped = target.startsWith(winPrefix) ? target.slice(4) : target;
    const resolved = path.isAbsolute(stripped)
      ? stripped
      : path.resolve(path.dirname(src), stripped);
    const rel = path.relative(path.resolve(source), path.resolve(resolved));
    return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** 复刻一个符号链接（不跟随其目标）。 */
async function replicateLink(
  fs: DependencyPresetFs,
  item: { src: string; dest: string; dir: boolean; target: string },
): Promise<void> {
  let linkTarget = item.target;
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
  /** 建出 worktree 用掉的尝试次数（1 = 一次成功；重试成功时 > 1）。 */
  attempts: number;
  /** worktree 内依赖预置的结果（最好努力；跳过 / 失败都不影响 worktree 可用）。 */
  dependencies?: DependencyPresetResult;
}

/** 跑一条 git 命令（单测注入用；生产代码走真实 git）。 */
export type WorktreeGitRunner = (
  cwd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

const defaultGitRunner: WorktreeGitRunner = (cwd, args, timeoutMs) =>
  git(cwd, args, { timeoutMs });

/**
 * 合并 / 预演的可注入 git 接缝（仅供单测；生产代码一律不传）。
 *
 * 中间态判定、abort 归属判定、merge base 计数都依赖精确的 git 调用时序 ——
 * 真实仓库里「两次探测之间用户启动了自己的 merge」无法稳定复现，注入让测试
 * 能精确制造这个竞态，而不必起真实 CLI / 网络。
 */
export interface WorktreeMergeDeps {
  /** 抛错式 git（默认真实 git）。 */
  run?: WorktreeGitRunner;
  /** 退出码式 git（默认真实 git）。 */
  runRaw?: (
    cwd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** 某个中间态标记是否存在（默认查 git 目录里的标记文件）。 */
  marker?: (repoRoot: string, name: string) => Promise<boolean>;
}

function mergeDeps(deps?: WorktreeMergeDeps): Required<WorktreeMergeDeps> {
  const run = deps?.run ?? defaultGitRunner;
  return {
    run,
    runRaw: deps?.runRaw ?? gitRaw,
    marker: deps?.marker ?? ((repoRoot, name) => gitMarkerExists(run, repoRoot, name)),
  };
}

/** git 目录里的中间态标记（文件 / 目录）是否存在。 */
async function gitMarkerExists(
  run: WorktreeGitRunner,
  repoRoot: string,
  name: string,
): Promise<boolean> {
  try {
    const { stdout } = await run(repoRoot, ["rev-parse", "--git-path", name], GIT_TIMEOUT_MS);
    const marker = stdout.trim();
    if (!marker) return false;
    await lstat(path.resolve(repoRoot, marker));
    return true;
  } catch {
    return false;
  }
}

/** merge 失败后读当前 MERGE_HEAD（不存在返回 null）。 */
async function currentMergeHead(
  run: WorktreeGitRunner,
  repoRoot: string,
): Promise<string | null> {
  try {
    const { stdout } = await run(
      repoRoot,
      ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
      GIT_TIMEOUT_MS,
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * `createWorktree` 的可注入依赖（**仅供单测**；生产代码一律不传）。
 *
 * 抽成注入而不是 mock 整个模块：重试、清理、串行化都是**本模块内部**的行为，
 * 注入让测试能精确制造「第一次 git 失败」这种真实世界里偶发、但没法稳定
 * 复现的场景。
 */
export interface WorktreeCreateDeps {
  gitRunner?: WorktreeGitRunner;
  /** 删除目录（默认 `fs.rm` 递归，不跟随链接）。 */
  removeDir?: (targetPath: string) => Promise<void>;
  /** 平台判定（默认 `process.platform`）：决定是否带 `-c core.longpaths=true`。 */
  platform?: NodeJS.Platform;
  /** 重试退避序列（默认 300ms / 1000ms；测试注入空数组免等待）。 */
  retryDelaysMs?: number[];
}

/**
 * 创建串行化的模块级 promise 链。
 *
 * 多个子会话同时 prepare 时会并发走到这里：并发 `git worktree add` 会在同一个
 * 仓库里争 index / 锁目录（实测同一瞬间三个任务失败，unique 后缀只差几毫秒），
 * 紧随其后的依赖预置还会并发建三万级硬链接。串起来以后每个 worktree 都是
 * 「建目录 → checkout → 预置依赖」完整跑完，下一个才开始。
 *
 * 链在失败后必须继续可用：`createLock` 接的是**吞掉错误**的 promise，某次
 * 创建失败不会让后续调用永久挂起（调用方拿到的 `run` 仍然如实 reject）。
 * 只读探测（`probeGitRepo` 等）不进这条链 —— 它们不写仓库，没有争用。
 */
let createLock: Promise<unknown> = Promise.resolve();

function withCreateLock<T>(task: () => Promise<T>): Promise<T> {
  const run = createLock.then(task, task);
  createLock = run.catch(() => undefined);
  return run;
}

/**
 * `git worktree add` 的参数。
 *
 * `-c core.longpaths=true` 是**全局**选项，必须排在 `worktree` 子命令之前；
 * 只在 Windows 上加 —— 深层路径（node_modules 里的链接树之类）很容易超过
 * 260 字符，git 默认按短路径处理，checkout 中途就会失败。
 */
function worktreeAddArgs(
  options: { targetPath: string; branch: string; baseRef: string },
  platform: NodeJS.Platform,
): string[] {
  const args: string[] = [];
  if (platform === "win32") args.push("-c", "core.longpaths=true");
  args.push(
    "worktree",
    "add",
    "-b",
    options.branch,
    gitPath(options.targetPath),
    options.baseRef,
  );
  return args;
}

/**
 * `git worktree add <path> <branch>` 的参数（挂已有分支，不建新分支）。
 *
 * 与 {@link worktreeAddArgs} 同一条 Windows 长路径纪律；区别只是没有 `-b`。
 */
function worktreeAttachArgs(
  options: { targetPath: string; branch: string },
  platform: NodeJS.Platform,
): string[] {
  const args: string[] = [];
  if (platform === "win32") args.push("-c", "core.longpaths=true");
  args.push("worktree", "add", gitPath(options.targetPath), options.branch);
  return args;
}

/**
 * 清掉一次失败尝试的现场：残留目录、worktree 元数据、以及**空**分支。
 *
 * `git worktree add` 失败时可能已经建了一半目录，也可能已经建出分支却没能
 * 登记 worktree —— 不清理的话下一次尝试会撞上「目录已存在」，或者留下一个
 * 指向 baseRef 的空分支占着名字。
 *
 * 分支只在**它的 sha 与 baseRef 完全相同**时才删：那说明它是本次失败尝试刚
 * 建出来的空分支；一旦有独有提交（子会话的工作）就绝不删。
 */
async function cleanupFailedWorktree(options: {
  repoRoot: string;
  targetPath: string;
  branch: string;
  baseRef: string;
  runGit: WorktreeGitRunner;
  removeDir: (targetPath: string) => Promise<void>;
}): Promise<void> {
  await options.removeDir(options.targetPath).catch(() => undefined);
  await options
    .runGit(options.repoRoot, ["worktree", "prune"], GIT_TIMEOUT_MS)
    .catch(() => undefined);
  try {
    const branchSha = (
      await options.runGit(
        options.repoRoot,
        ["rev-parse", "--verify", `refs/heads/${options.branch}`],
        GIT_TIMEOUT_MS,
      )
    ).stdout.trim();
    if (!branchSha) return;
    const baseSha = (
      await options.runGit(
        options.repoRoot,
        ["rev-parse", "--verify", options.baseRef],
        GIT_TIMEOUT_MS,
      )
    ).stdout.trim();
    // 分支上有独有提交 → 那是工作，不是残留，绝不删。
    if (!baseSha || branchSha !== baseSha) return;
    await options.runGit(
      options.repoRoot,
      ["branch", "-D", options.branch],
      GIT_TIMEOUT_MS,
    );
  } catch {
    // 分支不存在（首次尝试就没建出来）/ 删除失败：下一次尝试自己会处理。
  }
}

/**
 * 丢弃一个建失败的 worktree 现场（目录 + 元数据 + 空分支）。
 *
 * 给 `createWorktree` 的内部重试与 `super-agent` 的降级兜底共用：即使
 * `createWorktree` 已经清理过，降级前再确认一次也是幂等的（目录不存在时
 * `rm -f` 直接返回，`prune` 对干净仓库是空操作）。
 */
export async function discardFailedWorktree(options: {
  repoRoot: string;
  targetPath: string;
  branch?: string;
  baseRef?: string;
  /** 单测注入。 */
  removeDir?: (targetPath: string) => Promise<void>;
}): Promise<void> {
  const removeDir = options.removeDir ?? defaultRemoveDir;
  if (!options.branch) {
    await removeDir(options.targetPath).catch(() => undefined);
    await defaultGitRunner(options.repoRoot, ["worktree", "prune"], GIT_TIMEOUT_MS).catch(
      () => undefined,
    );
    return;
  }
  await cleanupFailedWorktree({
    repoRoot: options.repoRoot,
    targetPath: options.targetPath,
    branch: options.branch,
    baseRef: options.baseRef ?? "HEAD",
    runGit: defaultGitRunner,
    removeDir,
  });
}

/**
 * 建一个 worktree：`<repoRoot>` 的 `baseRef` 上拉一条新分支并 checkout 到
 * `targetPath`。
 *
 * `targetPath` 必须**不存在**（git 的硬要求），因此调用方只建父目录。
 *
 * 三段纪律（都来自 2026-11 的实测事故：同一瞬间并发派发的三个子会话全部
 * 建 worktree 失败，只能重派任务）：
 *  1. **串行**：整段（mkdir + `worktree add` + 依赖预置）过模块级互斥链，
 *     并发派发变成排队，不再并发 checkout / 并发建硬链接树；
 *  2. **重试**：首次 + 2 次重试（300ms / 1000ms），每次失败先清现场（残留
 *     目录、worktree 元数据、空分支）再重来；
 *  3. **专用超时**：`worktree add` 用 120s，其余 git 命令仍是 30s。
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
  /** 单测注入（生产代码不传）。 */
  deps?: WorktreeCreateDeps;
}): Promise<WorktreeCreateResult> {
  const runGit = options.deps?.gitRunner ?? defaultGitRunner;
  const removeDir = options.deps?.removeDir ?? defaultRemoveDir;
  const platform = options.deps?.platform ?? process.platform;
  const retryDelays = options.deps?.retryDelaysMs ?? WORKTREE_CREATE_RETRY_DELAYS_MS;
  const args = worktreeAddArgs(options, platform);

  return withCreateLock(async () => {
    await mkdir(path.dirname(options.targetPath), { recursive: true });
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= WORKTREE_CREATE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await runGit(options.repoRoot, args, WORKTREE_CREATE_TIMEOUT_MS);
        const dependencies = await presetWorktreeDependencies({
          repoRoot: options.repoRoot,
          worktreePath: options.targetPath,
        });
        return {
          path: options.targetPath,
          branch: options.branch,
          baseRef: options.baseRef,
          attempts: attempt,
          dependencies,
        };
      } catch (error) {
        lastError = error;
        await cleanupFailedWorktree({
          repoRoot: options.repoRoot,
          targetPath: options.targetPath,
          branch: options.branch,
          baseRef: options.baseRef,
          runGit,
          removeDir,
        });
        const delay = retryDelays[attempt - 1];
        if (delay !== undefined) await sleep(delay);
      }
    }
    throw new Error(
      `worktree creation failed after ${WORKTREE_CREATE_MAX_ATTEMPTS} attempts: ${errorMessage(lastError)}`,
    );
  });
}

/**
 * 把一条**已存在的分支**挂到一个新的工作目录上（`git worktree add <path> <branch>`）。
 *
 * 与 {@link createWorktree} 的区别只有一处：**不建分支**，直接 checkout 已有
 * 分支 —— 分支上的提交（子会话中断前的工作）原样保留。恢复分类为 `lost`
 * （分支还在、工作目录被删了）的子会话重试时走这条路径；新建一条空分支等于
 * 把那些工作藏起来，本函数刻意不提供那个退化。
 *
 * 纪律：
 *  - 目标路径必须**不存在**（git 的硬要求）。这里显式检查并抛错，绝不为了
 *    让命令跑通而递归删掉一个可能还装着未提交改动的目录；
 *  - 与 `createWorktree` 共用模块级串行锁（同一个仓库里并发 `worktree add`
 *    会争 index / 锁目录）；
 *  - 失败只清目标目录与 worktree 元数据，**绝不删分支**（分支是这次重建的
 *    唯一依据，删掉就真丢了）。
 */
export async function createWorktreeFromBranch(options: {
  repoRoot: string;
  targetPath: string;
  branch: string;
  /** 单测注入（生产代码不传）。 */
  deps?: WorktreeCreateDeps;
}): Promise<WorktreeCreateResult> {
  const runGit = options.deps?.gitRunner ?? defaultGitRunner;
  const removeDir = options.deps?.removeDir ?? defaultRemoveDir;
  const platform = options.deps?.platform ?? process.platform;
  const args = worktreeAttachArgs(options, platform);

  return withCreateLock(async () => {
    if (existsSync(options.targetPath)) {
      throw new Error(
        `the worktree target already exists: ${options.targetPath}（不会自动删除它，请先确认里面没有未提交的工作）`,
      );
    }
    await mkdir(path.dirname(options.targetPath), { recursive: true });
    try {
      await runGit(options.repoRoot, args, WORKTREE_CREATE_TIMEOUT_MS);
      const dependencies = await presetWorktreeDependencies({
        repoRoot: options.repoRoot,
        worktreePath: options.targetPath,
      });
      return {
        path: options.targetPath,
        branch: options.branch,
        // 已有分支就是这次重建的起点：隔离记录用它判断「分支上有没有独有
        // 提交」时，baseRef..branch 为空（分支自己到自己是 0 条）——与
        // `reusableIsolation` 复用现场时的语义一致。
        baseRef: options.branch,
        attempts: 1,
        dependencies,
      };
    } catch (error) {
      // 只清目录与 worktree 元数据；分支必须保留。
      await removeDir(options.targetPath).catch(() => undefined);
      await runGit(options.repoRoot, ["worktree", "prune"], GIT_TIMEOUT_MS).catch(
        () => undefined,
      );
      throw new Error(
        `attaching the worktree to the existing branch ${options.branch} failed: ${errorMessage(error)}`,
      );
    }
  });
}

/**
 * 本地分支是否存在（只读 `git show-ref --verify refs/heads/<branch>`）。
 *
 * 恢复分类与 lost 重试共用：**只读**，不写仓库、不改工作区。任何失败（不是
 * git 仓库 / 分支不存在 / git 不可用）都按 false 保守处理 —— 宁可让用户看到
 * 「分支不存在」，也不要谎称分支还在。
 */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  if (!branch) return false;
  const probe = await gitRaw(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
  return probe.code === 0;
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

/**
 * realpath 归一（不存在时退回**最近已存在祖先**的 realpath + 余下片段）。
 *
 * 为什么要一路走到祖先：`.iflow/super` 在第一次委派时还不存在，若直接对整条
 * 路径 realpath，失败就退回词法形式 —— 调用方手里的 `/var/...` 与 git 给的
 * `/private/var/...` 依旧是两种写法（2026-11-16 macOS CI 的失败形态）。先解析
 * 已存在的那一段、剩下的按词法拼回去，两种写法才会归到一起。
 *
 * 去掉 Windows 的 `\\?\` 前缀；任何异常都不抛出。
 */
async function realPathOrLexical(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    return stripWindowsPrefix(await realpath(resolved));
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    try {
      return path.join(
        stripWindowsPrefix(await realPathOrLexical(parent)),
        path.basename(resolved),
      );
    } catch {
      return resolved;
    }
  }
}

/** 去掉 Windows 扩展长度前缀（`\\?\C:\…` → `C:\…`）。 */
function stripWindowsPrefix(p: string): string {
  return p.startsWith("\\\\?\\") ? p.slice(4) : p;
}

/**
 * 路径比较键（异步：realpath 归一之后再比较）。
 *
 * git 的 `rev-parse --show-toplevel` 与 `worktree list --porcelain` 输出的是
 * **realpath** 形式 —— macOS 上 `os.tmpdir()` 的 `/var/folders/...` 会变成
 * `/private/var/folders/...`，Windows 上目录联接（junction）会被解析成目标
 * 路径。而调用方手里的 repoRoot / 目录枚举结果常常还是链接形式：直接比较会
 * 把同一个目录判成两个（2026-11-16 macOS CI 实测：exclude 一个字没写、残留
 * 清扫恒 0 回收）。
 */
export async function comparisonPathKey(p: string): Promise<string> {
  return normalizePathKey(await realPathOrLexical(p));
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
   * 调用方**已自行核验**过这条分支可以删除（已并入 HEAD / 没有任何独有提交）。
   *
   * 缺 `baseRef` 时删分支需要这个显式授权：合并之后分支起点已不是 HEAD 的
   * 祖先，`baseRef..branch` 的计数不再适用，调用方因此在合并/空分支路径上
   * 刻意不传 `baseRef` —— 但它必须给出「我核过了」的信号，而不是让
   * `removeWorktree` 把「不知道」当成「安全」。
   */
  branchDeletionVerified?: boolean;
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
 * 删分支需要**证据**，三条路各一份：用户显式要求（`keepBranch` 反过来由
 * 调用点决定）、`baseRef` 上确认没有独有提交，或调用方自行核验后给出的
 * `branchDeletionVerified`。缺 `baseRef` 又没有核验信号时一律保留分支 ——
 * 旧实现此时会直接 `git branch -D`，等于把「不知道」当成「安全」，删掉
 * 未合并分支就是丢提交。
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
  if (!options.branchDeletionVerified) {
    if (!options.baseRef) {
      // 没有基准点就无从判断分支上有没有未合并的提交 —— 保守保留。
      return {
        removed,
        branchKept: true,
        reason: "缺少基准分支（baseRef），无法确认分支已合并，已保留分支",
      };
    }
    if (
      await branchHasUnmergedCommits({
        repoRoot: options.repoRoot,
        branch,
        baseRef: options.baseRef,
      })
    ) {
      return { removed, branchKept: true, reason: "分支上还有未合并的提交，已保留待你审阅" };
    }
  }
  try {
    await git(options.repoRoot, ["branch", "-D", branch]);
    return { removed, branchKept: false };
  } catch {
    return { removed, branchKept: true, reason: "分支删除失败，已保留" };
  }
}

/**
 * 列出本地所有 `iflow/super/` 命名空间下的分支（含未合并的）。
 *
 * 供「清空并新建」的全量清空使用：用户已明确授权连未合并 worktree 一并清掉，
 * 因此不能只依赖 `git worktree list` —— 目录被手工删掉、worktree 元数据已
 * prune、但分支还留着的孤儿也要清。只读操作，失败时返回空数组。
 */
export async function listSuperBranches(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await git(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${SUPER_BRANCH_PREFIX}`,
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(SUPER_BRANCH_PREFIX));
  } catch {
    return [];
  }
}

/**
 * 强制删除一条本地分支（`-D`，不要求已合并）。返回是否删掉。
 */
export async function deleteSuperBranch(repoRoot: string, branch: string): Promise<boolean> {
  if (!branch.startsWith(SUPER_BRANCH_PREFIX)) return false;
  try {
    await git(repoRoot, ["branch", "-D", branch]);
    return true;
  } catch {
    return false;
  }
}

/** `git worktree prune`：让 worktree 记账与磁盘现状一致（全量清空收尾用）。 */
export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await git(repoRoot, ["worktree", "prune"]).catch(() => undefined);
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
  /** 单测注入（生产代码不传）。 */
  deps?: WorktreeMergeDeps;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = mergeDeps(options.deps);
  // 闸 1：用户正在合并/变基/拣选/还原/序列操作 → 绝不叠加第二次合并，更不碰他的中间态。
  const before = await detectInProgress(options.repoRoot, d);
  if (before) {
    return {
      ok: false,
      error: `the repository is already in the middle of a ${before}; the merge was not started`,
    };
  }
  // 记录本次合并前的 HEAD / MERGE_HEAD 与分支 tip：失败后据此判断中间态归属，
  // 杜绝两次探测之间用户启动自己的 merge 时被我们误 abort（TOCTOU）。
  const beforeHead = await d
    .run(options.repoRoot, ["rev-parse", "HEAD"], GIT_TIMEOUT_MS)
    .then((r) => r.stdout.trim())
    .catch(() => "");
  const beforeMergeHead = await currentMergeHead(d.run, options.repoRoot);
  const branchTip = await d
    .run(options.repoRoot, ["rev-parse", "--verify", options.branch], GIT_TIMEOUT_MS)
    .then((r) => r.stdout.trim())
    .catch(() => "");
  try {
    await d.run(
      options.repoRoot,
      ["merge", "--no-ff", "--no-edit", options.branch],
      GIT_TIMEOUT_MS,
    );
    return { ok: true };
  } catch (error) {
    const afterMergeHead = await currentMergeHead(d.run, options.repoRoot);
    const afterHead = await d
      .run(options.repoRoot, ["rev-parse", "HEAD"], GIT_TIMEOUT_MS)
      .then((r) => r.stdout.trim())
      .catch(() => beforeHead);
    // 闸 2：只有 MERGE_HEAD 确实是本次合并留下的（此前没有、现在指向本分支 tip、
    // HEAD 未变）才 abort。否则那是用户自己的中间态，绝不碰 —— 如实报错让他处理。
    const ours =
      beforeMergeHead === null && afterMergeHead === branchTip && afterHead === beforeHead;
    if (ours) {
      await d.run(options.repoRoot, ["merge", "--abort"], GIT_TIMEOUT_MS).catch(() => undefined);
      return { ok: false, error: errorMessage(error) };
    }
    return {
      ok: false,
      error: `${errorMessage(error)}; a merge is in progress but was not started by this operation, refusing to abort it`,
    };
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
export async function previewMerge(options: {
  repoRoot: string;
  branch: string;
  /** 单测注入（生产代码不传）。 */
  deps?: WorktreeMergeDeps;
}): Promise<MergePreview> {
  const d = mergeDeps(options.deps);
  const unavailable: MergePreview = { available: false, clean: false, paths: [] };
  let base: string;
  let childPaths: string[];
  let mainPaths: string[];
  try {
    // criss-cross 历史下不带 --all 的 merge-base 只返回一个 base 且不报错，
    // 基于它的冲突预演结论不可信 —— 多于一个 base 就退回保守策略。
    const bases = (
      await d.run(
        options.repoRoot,
        ["merge-base", "--all", "HEAD", options.branch],
        GIT_TIMEOUT_MS,
      )
    ).stdout
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    if (bases.length !== 1) return unavailable;
    base = bases[0]!;
    childPaths = await changedPaths(d.run, options.repoRoot, base, options.branch);
    mainPaths = await changedPaths(d.run, options.repoRoot, base, "HEAD");
  } catch {
    return unavailable;
  }
  const paths = [...new Set([...childPaths, ...mainPaths])];
  const probe = await d.runRaw(options.repoRoot, [
    "merge-tree",
    "--write-tree",
    "HEAD",
    options.branch,
  ]);
  if (probe.code === 0) return { available: true, clean: true, paths };
  // exit code 1 = 合并有冲突；>1 或进程级失败 = 命令不可用（旧版 git 等）。
  if (probe.code === 1) return { available: true, clean: false, paths };
  return unavailable;
}

/** 两个提交之间改动过的路径（`--no-renames`：重命名拆成删除 + 新增）。 */
async function changedPaths(
  run: WorktreeGitRunner,
  repoRoot: string,
  from: string,
  to: string,
): Promise<string[]> {
  const { stdout } = await run(
    repoRoot,
    ["diff", "--no-renames", "--name-only", "-z", from, to],
    GIT_TIMEOUT_MS,
  );
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
/** 仓库可能停住的所有 git 操作中间态。 */
export type MergeInProgress = "merge" | "rebase" | "cherry-pick" | "revert" | "sequencer";

export interface WorkingTreeState {
  /** 状态是否真的读到了（false = git 不可用 / 仓库损坏，调用方必须保守处理）。 */
  available: boolean;
  clean: boolean;
  /** 未提交的条目数（已跟踪改动路径数 + 未跟踪文件数）。 */
  dirtyCount: number;
  /** 仓库是否停在任何 git 操作中间态（含 revert / sequencer）。 */
  inProgress: MergeInProgress | null;
  /** 已跟踪文件的未提交改动路径（含删除与重命名两侧；相对仓库根、正斜杠）。 */
  trackedPaths: string[];
  /** 未跟踪文件数。 */
  untrackedCount: number;
}

/**
 * 仓库是否停在任何 git 操作中间态（只读探测）。
 *
 * 判据是 git 自己的中间态标记文件 / 目录：MERGE_HEAD / REBASE_HEAD /
 * CHERRY_PICK_HEAD / REVERT_HEAD 以及 rebase-merge、rebase-apply、sequencer
 * 目录。任一存在就说明有人（用户或我们）正在这个仓库里做一次 git 操作 ——
 * 自动合并必须让路，abort 也必须区分「我们这次留下的」与「用户先前就在做的」。
 * 撤销用户的中间态等于替用户毁掉工作。
 */
export async function detectInProgress(
  repoRoot: string,
  deps?: WorktreeMergeDeps,
): Promise<MergeInProgress | null> {
  const d = mergeDeps(deps);
  const has = (name: string): Promise<boolean> => d.marker(repoRoot, name);
  if (await has("MERGE_HEAD")) return "merge";
  if (await has("REBASE_HEAD")) return "rebase";
  if (await has("rebase-merge")) return "rebase";
  if (await has("rebase-apply")) return "rebase";
  if (await has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (await has("REVERT_HEAD")) return "revert";
  if (await has("sequencer")) return "sequencer";
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

/** worktree 列表（porcelain 输出；路径已做 realpath 归一）。 */
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
    // git 打印的是 realpath 形式，而调用方手里的路径常常还是链接形式
    // （macOS `/var` → `/private/var`、Windows 目录联接）。统一归一到真实
    // 路径，残留清扫才能把它与自己的目录枚举结果对上。
    return await Promise.all(
      result.map(async (item) => ({
        ...item,
        path: await realPathOrLexical(
          path.isAbsolute(item.path) ? item.path : path.resolve(repoRoot, item.path),
        ),
      })),
    );
  } catch {
    return [];
  }
}

async function git(
  cwd: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    timeout: options?.timeoutMs ?? GIT_TIMEOUT_MS,
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
