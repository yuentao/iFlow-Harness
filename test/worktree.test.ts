import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  branchHasUnmergedCommits,
  commitWorktree,
  createWorktree,
  currentBranch,
  detectInProgress,
  ensureSuperIsolationIgnored,
  inspectWorktreeState,
  inspectWorkingTree,
  isBranchMerged,
  listWorktrees,
  mergeBranch,
  previewMerge,
  probeGitRepo,
  remoteOriginUrl,
  removeWorktree,
  sanitizeWorktreeName,
  superBranchName,
  worktreeHasUncommittedChanges,
  worktreePathFor,
} from "../src/panel/worktree.js";

const roots: string[] = [];
/** 装着 symlink/junction 的临时父目录（清理时先拆链接，再删目录）。 */
const linkParents: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A real git repo with one commit — worktrees need actual git. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-wt-"));
  roots.push(dir);
  git(dir, "init");
  git(dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "config", "user.name", "test");
  git(dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "config", "user.email", "test@example.com");
  // No CRLF translation: the assertions compare file CONTENT, and Windows'
  // default core.autocrlf would rewrite "\n" as "\r\n" on checkout.
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init");
  return dir;
}

/** A fresh, never-existing worktree target path (git requires it to be absent). */
function targetPath(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-wt-target-"));
  roots.push(dir);
  return path.join(dir, name);
}

/**
 * 造一个「链接形态的仓库根」：真实仓库在 `repo`，另一个路径通过 symlink /
 * junction 指向它。
 *
 * 这是在复刻 macOS CI 的真实形态：`os.tmpdir()` 给的是 `/var/folders/...`，
 * 而 git 的 `rev-parse --show-toplevel` / `worktree list` 输出的是 realpath
 * 形式 `/private/var/folders/...`。Windows 上的目录联接（junction）同样会被
 * git 解析成目标路径，因此这个坑在 Windows 上也能 1:1 复现（不需要管理员
 * 权限），macOS / Linux 用普通目录符号链接。
 *
 * 建立失败时返回真实仓库路径 —— 调用方据此 `ctx.skip()`，绝不静默假装跑过。
 */
function makeLinkedRepo(repo: string): string {
  const parent = mkdtempSync(path.join(tmpdir(), "iflow-wt-link-"));
  const link = path.join(parent, "link");
  try {
    symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return repo;
  }
  linkParents.push(parent);
  return link;
}

/** 拆掉 makeLinkedRepo 建的链接（Windows junction 要用 rmdir，POSIX 用 unlink）。 */
function removeLinkedRoot(parent: string): void {
  const link = path.join(parent, "link");
  try {
    unlinkSync(link);
  } catch {
    try {
      rmdirSync(link);
    } catch {
      // 已经不在 / 不是链接：下面的递归删除会兜底。
    }
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Read a file with CRLF normalized (checkout may translate line endings). */
function readText(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

afterAll(() => {
  for (const parent of linkParents) removeLinkedRoot(parent);
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("worktree · 命名（纯函数）", () => {
  it("中文标题折叠成安全的 slug", () => {
    expect(sanitizeWorktreeName("修复登录跳转")).toBe("修复登录跳转");
    expect(sanitizeWorktreeName("Fix Login")).toBe("fix-login");
    expect(sanitizeWorktreeName("fix  the__login")).toBe("fix-the-login");
    expect(sanitizeWorktreeName("")).toBe("task");
    expect(sanitizeWorktreeName("!!!")).toBe("task");
  });

  it("slug 不含路径分隔符", () => {
    const slug = sanitizeWorktreeName("../../etc/passwd");
    expect(slug).not.toContain("/");
    expect(slug).not.toContain("\\");
    expect(slug).not.toContain("..");
  });

  it("分支名落在专属命名空间下", () => {
    expect(superBranchName("fix-login")).toBe("iflow/super/fix-login");
  });

  it("worktree 路径落在项目内的隔离子树里", () => {
    const repo = path.join("C:", "work", "api");
    const p = worktreePathFor(repo, "fix-login", "abc");
    expect(p).toBe(path.join(repo, ".iflow", "super", "worktrees", "fix-login-abc"));
  });
});

describe("worktree · 真实 git 仓库", () => {
  it("识别 git 仓库并取 HEAD", async () => {
    const repo = makeRepo();
    const probe = await probeGitRepo(repo);
    expect(probe.isRepo).toBe(true);
    expect(probe.head).toMatch(/^[0-9a-f]{7,40}$/);
  }, 30000);

  it("非 git 目录被如实识别", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "iflow-nogit-"));
    roots.push(dir);
    const probe = await probeGitRepo(dir);
    expect(probe.isRepo).toBe(false);
    expect(probe.head).toBeNull();
  }, 30000);

  it("创建 worktree：独立目录 + 独立分支 + 同一份内容", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-child");
    const probe = await probeGitRepo(repo);
    const created = await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("child"),
      baseRef: probe.head!,
    });
    expect(created.branch).toBe("iflow/super/child");
    expect(existsSync(path.join(target, "a.txt"))).toBe(true);
    expect(readText(path.join(target, "a.txt"))).toBe("one\n");
    expect(git(target, "branch", "--show-current").trim()).toBe("iflow/super/child");

    const list = await listWorktrees(repo);
    expect(list.some((w) => w.branch === "iflow/super/child")).toBe(true);
  }, 30000);

  it("worktree 建在项目内，且被本地 exclude 排除（主工作区保持干净）", async () => {
    const repo = makeRepo();
    await ensureSuperIsolationIgnored(repo);
    const probe = await probeGitRepo(repo);
    const target = worktreePathFor(repo, "in-repo", "abc");
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("in-repo-abc"),
      baseRef: probe.head!,
    });
    expect(target.startsWith(repo)).toBe(true);
    expect(readText(path.join(target, "a.txt"))).toBe("one\n");
    // 关键：隔离子树不出现在主仓库的 status 里 —— 否则自动合并会永远被
    // inspectWorkingTree 判成「工作区不干净」。
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    // 幂等：重复调用不会重复写 exclude。
    await ensureSuperIsolationIgnored(repo);
    const exclude = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(
      exclude.split(/\r?\n/).filter((line) => line.trim() === ".iflow/super/"),
    ).toHaveLength(1);
  }, 30000);

  it("工作区是仓库子目录时，exclude 按仓库根写相对路径", async () => {
    const repo = makeRepo();
    const sub = path.join(repo, "pkg");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "b.txt"), "x\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "sub");

    await ensureSuperIsolationIgnored(sub);
    const exclude = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("pkg/.iflow/super/");

    const probe = await probeGitRepo(sub);
    await createWorktree({
      repoRoot: sub,
      targetPath: worktreePathFor(sub, "sub", "x"),
      branch: superBranchName("sub-x"),
      baseRef: probe.head!,
    });
    expect(git(sub, "status", "--porcelain").trim()).toBe("");
  }, 30000);

  /**
   * macOS CI 回归（2026-11-16）：`os.tmpdir()` 在 macOS 上是
   * `/var/folders/...`，而 git 的 `rev-parse --show-toplevel` 输出 realpath
   * 形式 `/private/var/folders/...`。旧实现直接拿两者做 `path.relative`，
   * 相对路径「逃出」仓库根（以 `..` 开头）就静默 return —— exclude 一个字
   * 都没写，主工作区于是被 `.iflow/` 弄脏（CI 实测）。
   *
   * Windows 的目录联接（junction）会被 git 同样解析成目标路径，因此同一
   * 形态在 Windows 上也能真实复现，不需要管理员权限。
   */
  it("链接形态的仓库根（macOS /var → /private/var）：exclude 仍按仓库根写入", async (ctx) => {
    const realRepo = makeRepo();
    const repo = makeLinkedRepo(realRepo);
    if (repo === realRepo) ctx.skip();

    const sub = path.join(repo, "pkg");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "b.txt"), "x\n", "utf8");
    git(realRepo, "add", "-A");
    git(realRepo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "sub");

    // 先证明夹具真的构造出了「同一目录两种写法」：git 给的是链接目标。
    // 个别平台/文件系统上 git 可能原样返回链接路径 —— 那样就没有回归场景，
    // 明确跳过而不是制造一条假失败。
    const toplevel = path.resolve(git(repo, "rev-parse", "--show-toplevel").trim());
    if (toplevel.toLowerCase() === path.resolve(repo).toLowerCase()) ctx.skip();

    await ensureSuperIsolationIgnored(sub);
    const excludeFile = path.join(realRepo, ".git", "info", "exclude");
    const exclude = readFileSync(excludeFile, "utf8");
    expect(exclude).toContain("pkg/.iflow/super/");

    // 幂等：重复调用不会重复写。
    await ensureSuperIsolationIgnored(sub);
    expect(
      readFileSync(excludeFile, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim() === "pkg/.iflow/super/"),
    ).toHaveLength(1);

    const probe = await probeGitRepo(sub);
    const target = worktreePathFor(sub, "linked", "x");
    await createWorktree({
      repoRoot: sub,
      targetPath: target,
      branch: superBranchName("linked-x"),
      baseRef: probe.head!,
    });
    expect(readText(path.join(target, "a.txt"))).toBe("one\n");
    // 关键：隔离子树在两种路径写法下都不出现在 status 里。
    expect(git(sub, "status", "--porcelain").trim()).toBe("");
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  }, 30000);

  it("worktree 里改文件不影响主工作区", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-isolated");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("isolated"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "a.txt"), "two\n", "utf8");
    expect(readText(path.join(repo, "a.txt"))).toBe("one\n");
    expect(readText(path.join(target, "a.txt"))).toBe("two\n");
  }, 30000);

  it("worktreeHasUncommittedChanges：干净的 worktree 返回 false", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-clean-check");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("clean-check"),
      baseRef: probe.head!,
    });
    expect(await worktreeHasUncommittedChanges(target)).toBe(false);
  }, 30000);

  it("worktreeHasUncommittedChanges：有未提交改动 / 目录不可读都按有改动处理", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-dirty-check");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("dirty-check"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "scratch.txt"), "not committed\n", "utf8");
    expect(await worktreeHasUncommittedChanges(target)).toBe(true);
    // 连 status 都拿不到时绝不能报「干净」—— 那会让自动清理删掉未知内容。
    expect(await worktreeHasUncommittedChanges(path.join(target, "does-not-exist"))).toBe(true);
  }, 30000);

  it("有未合并提交时保留分支（不静默吞掉工作）", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-dirty");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("dirty"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "b.txt"), "work\n", "utf8");
    git(target, "add", "-A");
    git(target, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child work");

    expect(await branchHasUnmergedCommits({ repoRoot: repo, branch: "iflow/super/dirty", baseRef: probe.head! })).toBe(true);

    const result = await removeWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: "iflow/super/dirty",
      baseRef: probe.head!,
    });
    expect(result.removed).toBe(true);
    expect(result.branchKept).toBe(true);
    expect(result.reason).toContain("未合并");
    // 分支还在，工作没丢。
    expect(git(repo, "branch", "--list", "iflow/super/dirty")).toContain("iflow/super/dirty");
  }, 30000);

  it("没有未合并提交时删分支", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-clean");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("clean"),
      baseRef: probe.head!,
    });
    const result = await removeWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: "iflow/super/clean",
      baseRef: probe.head!,
    });
    expect(result.removed).toBe(true);
    expect(result.branchKept).toBe(false);
    expect(git(repo, "branch", "--list", "iflow/super/clean")).not.toContain("iflow/super/clean");
  }, 30000);

  it("合并子会话分支回主分支", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-merge");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("merge"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "c.txt"), "merged\n", "utf8");
    git(target, "add", "-A");
    git(target, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child commit");

    const result = await mergeBranch({ repoRoot: repo, branch: "iflow/super/merge" });
    expect(result.ok).toBe(true);
    expect(readText(path.join(repo, "c.txt"))).toBe("merged\n");
  }, 30000);

  it("合并冲突 → 失败并撤销，不把仓库留在冲突状态", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-conflict");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("conflict"),
      baseRef: probe.head!,
    });
    // 两边改同一行 → 必然冲突。
    writeFileSync(path.join(target, "a.txt"), "child\n", "utf8");
    git(target, "add", "-A");
    git(target, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child side");
    writeFileSync(path.join(repo, "a.txt"), "main\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "main side");

    const result = await mergeBranch({ repoRoot: repo, branch: "iflow/super/conflict" });
    expect(result.ok).toBe(false);
    // 仓库没有被留在 MERGING 状态。
    expect(git(repo, "status", "--porcelain")).not.toContain("UU");
    expect(existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, 30000);
});

describe("worktree · 只撤销自己的合并", () => {
  /**
   * 造一个「用户正在合并、且合并冲突了」的现场：MERGE_HEAD 在，冲突标记在
   * 文件里 —— 这正是用户在终端里 `git merge` 之后的状态。
   */
  function makeUserMergeInProgress(repo: string): void {
    writeFileSync(path.join(repo, "a.txt"), "main\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "main side");
    try {
      git(repo, "merge", "--no-ff", "--no-edit", "iflow/super/user-merge");
    } catch {
      // 冲突是预期的。
    }
  }

  it("用户自己的合并进行中：本次合并失败也绝不 abort 掉用户的合并", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-user-merge");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("user-merge"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "a.txt"), "child\n", "utf8");
    git(target, "add", "-A");
    git(target, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child side");

    // 用户在自己的终端里合并，并且卡在冲突上。
    makeUserMergeInProgress(repo);
    expect(existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);
    const conflictedBefore = readText(path.join(repo, "a.txt"));

    // 宿主这时也要合并同一个分支 → 必须让路，绝不能把用户的合并撤掉。
    const result = await mergeBranch({ repoRoot: repo, branch: "iflow/super/user-merge" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("merge");

    // 用户的合并**原封不动**：MERGE_HEAD 还在，冲突内容还在。
    expect(existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);
    expect(readText(path.join(repo, "a.txt"))).toBe(conflictedBefore);
    expect(git(repo, "status", "--porcelain")).toContain("UU");
  }, 30000);

  it("用户自己的拣选进行中：本次合并失败不碰他的中间态", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-user-cherry-pick");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("user-cherry-pick"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "a.txt"), "child\n", "utf8");
    git(target, "add", "-A");
    git(target, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child side");
    writeFileSync(path.join(repo, "a.txt"), "main\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "main side");

    // 用户正在拣选（且卡在冲突上）→ CHERRY_PICK_HEAD 存在。
    try {
      git(repo, "cherry-pick", "iflow/super/user-cherry-pick");
    } catch {
      // 冲突是预期的。
    }
    expect(await detectInProgress(repo)).toBe("cherry-pick");

    const result = await mergeBranch({ repoRoot: repo, branch: "iflow/super/user-cherry-pick" });
    expect(result.ok).toBe(false);
    // 拣选中间态还在：我们既没启动合并，也没有 abort 任何东西。
    expect(await detectInProgress(repo)).toBe("cherry-pick");
    git(repo, "cherry-pick", "--abort");
  }, 30000);
});

describe("worktree · 自动合并的前置检查", () => {
  it("干净的已提交仓库判定为可合并", async () => {
    const repo = makeRepo();
    const state = await inspectWorkingTree(repo);
    expect(state.clean).toBe(true);
    expect(state.dirtyCount).toBe(0);
    expect(state.inProgress).toBeNull();
    expect(await currentBranch(repo)).toBeTruthy();
  }, 30000);

  it("未跟踪文件只单独计数，不算「会被合并覆盖」的已跟踪改动", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "untracked.txt"), "x\n", "utf8");
    const state = await inspectWorkingTree(repo);
    expect(state.available).toBe(true);
    expect(state.clean).toBe(false);
    expect(state.dirtyCount).toBe(1);
    expect(state.dirtyCount).toBe(state.untrackedCount);
    // 未跟踪文件不在 trackedPaths 里：合并不会因为它们而必须让路。
    expect(state.trackedPaths).toEqual([]);
  }, 30000);

  it("已跟踪改动按路径列出（供与合并路径求交）", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "a.txt"), "edited\n", "utf8");
    writeFileSync(path.join(repo, "staged-new.txt"), "n\n", "utf8");
    git(repo, "add", "staged-new.txt");
    writeFileSync(path.join(repo, "loose-untracked.txt"), "u\n", "utf8");

    const state = await inspectWorkingTree(repo);
    expect(state.trackedPaths).toContain("a.txt");
    // 已暂存的新增文件同样算「已跟踪改动」——合并若碰它就会覆盖索引内容。
    expect(state.trackedPaths).toContain("staged-new.txt");
    expect(state.trackedPaths).not.toContain("loose-untracked.txt");
    expect(state.untrackedCount).toBe(1);
  }, 30000);

  it("合并预演：干净的合并给出会改动的路径", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-preview-clean");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("preview-clean"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "c.txt"), "merged\n", "utf8");
    git(target, "add", "-A");
    git(target, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child");

    const preview = await previewMerge({ repoRoot: repo, branch: "iflow/super/preview-clean" });
    expect(preview.available).toBe(true);
    expect(preview.clean).toBe(true);
    expect(preview.paths).toContain("c.txt");
  }, 30000);

  it("合并预演：冲突在动手之前就被识别，工作区与仓库状态都不变", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-preview-conflict");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("preview-conflict"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "a.txt"), "child\n", "utf8");
    git(target, "add", "-A");
    git(target, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child");
    writeFileSync(path.join(repo, "a.txt"), "main\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "main");

    const preview = await previewMerge({ repoRoot: repo, branch: "iflow/super/preview-conflict" });
    expect(preview.available).toBe(true);
    expect(preview.clean).toBe(false);
    // 两侧都改过 a.txt，它必然在「合并会改动」的路径集合里。
    expect(preview.paths).toContain("a.txt");

    // 关键：预演只写对象库，索引 / 工作区 / 中间态一概没动。
    expect(readText(path.join(repo, "a.txt"))).toBe("main\n");
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    expect(existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, 30000);

  it("合并预演：分支不可达时如实返回不可用（调用方退回保守策略）", async () => {
    const repo = makeRepo();
    const preview = await previewMerge({ repoRoot: repo, branch: "iflow/super/does-not-exist" });
    expect(preview.available).toBe(false);
  }, 30000);

  it("isBranchMerged：合并前后如实反映分支是否已并入 HEAD", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-merged-check");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("merged-check"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "m.txt"), "merged\n", "utf8");
    git(target, "add", "-A");
    git(target, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child");

    expect(await isBranchMerged({ repoRoot: repo, branch: "iflow/super/merged-check" })).toBe(
      false,
    );
    const merged = await mergeBranch({ repoRoot: repo, branch: "iflow/super/merged-check" });
    expect(merged.ok).toBe(true);
    expect(await isBranchMerged({ repoRoot: repo, branch: "iflow/super/merged-check" })).toBe(
      true,
    );
    // 分支不存在时如实返回 false —— 绝不谎报成功。
    expect(await isBranchMerged({ repoRoot: repo, branch: "iflow/super/nope" })).toBe(false);
  }, 30000);

  it("进行中的合并被识别出来（不叠加第二次合并）", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-merge-state");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("state"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "a.txt"), "child\n", "utf8");
    git(target, "add", "-A");
    git(target, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child");
    writeFileSync(path.join(repo, "a.txt"), "main\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "main");

    // 制造一个停在冲突里的合并（模拟用户终端里的中间态）。
    try {
      git(repo, "merge", "--no-ff", "--no-edit", "iflow/super/state");
    } catch {
      // 冲突是预期的。
    }
    const state = await inspectWorkingTree(repo);
    expect(state.inProgress).toBe("merge");
    expect(state.clean).toBe(false);
    git(repo, "merge", "--abort");
  }, 30000);

  it("没有 origin 时返回 null，配置后返回 URL", async () => {
    const repo = makeRepo();
    expect(await remoteOriginUrl(repo)).toBeNull();
    git(repo, "remote", "add", "origin", "https://example.com/a.git");
    expect(await remoteOriginUrl(repo)).toBe("https://example.com/a.git");
  }, 30000);
});

describe("worktree · 宿主代子会话提交", () => {
  it("把已跟踪改动与未跟踪文件一起提交，提交后工作区干净", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-commit");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("commit"),
      baseRef: probe.head!,
    });
    writeFileSync(path.join(target, "a.txt"), "changed\n", "utf8");
    writeFileSync(path.join(target, "new.txt"), "new\n", "utf8");

    const before = git(target, "rev-list", "--count", "HEAD").trim();
    const result = await commitWorktree({
      repoRoot: repo,
      worktreePath: target,
      message: "super-agent: commit test",
    });

    expect(result.error).toBeUndefined();
    expect(result.committed).toBe(true);
    expect(result.files).toBe(2);
    // 分支上多了一个提交，提交信息来自宿主，且工作区不再有未提交改动。
    const after = git(target, "rev-list", "--count", "HEAD").trim();
    expect(Number(after)).toBe(Number(before) + 1);
    expect(git(target, "log", "-1", "--format=%s")).toContain("super-agent: commit test");
    expect(git(target, "status", "--porcelain").trim()).toBe("");
    // 提交身份由宿主显式提供，不依赖用户全局配置。
    expect(git(target, "log", "-1", "--format=%an")).toContain("iFlow Harness");
  }, 30000);

  it("工作区本来就干净时不产生空提交", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-commit-clean");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("commit-clean"),
      baseRef: probe.head!,
    });

    const before = git(target, "rev-list", "--count", "HEAD").trim();
    const result = await commitWorktree({
      repoRoot: repo,
      worktreePath: target,
      message: "super-agent: nothing to do",
    });

    expect(result.committed).toBe(false);
    expect(result.files).toBe(0);
    expect(git(target, "rev-list", "--count", "HEAD").trim()).toBe(before);
  }, 30000);
});

describe("worktree · 删除可靠性与状态判定", () => {
  it("删除失败（注入 fs 接缝）时如实报 removed=false 并保留分支", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-remove-fail");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("remove-fail"),
      baseRef: probe.head!,
    });

    let calls = 0;
    const result = await removeWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: "iflow/super/remove-fail",
      baseRef: probe.head!,
      removeDir: async () => {
        calls += 1;
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      },
      retryDelaysMs: [1, 1],
    });

    // 删不掉就是删不掉 —— 绝不能因为「fs.rm 没抛错」就报成功。
    expect(result.removed).toBe(false);
    // 目录没删净 → 分支必须保留（不能靠 git branch -D 恰好失败来兜底）。
    expect(result.branchKept).toBe(true);
    expect(result.reason).toContain("EBUSY");
    expect(git(repo, "branch", "--list", "iflow/super/remove-fail")).toContain(
      "iflow/super/remove-fail",
    );
    // 目录确实还在。
    expect(existsSync(target)).toBe(true);
    // 瞬时错误值得重试（EBUSY）。
    expect(calls).toBeGreaterThan(1);
  }, 30000);

  it("部分删除（目录残留）判定为失败并保留分支", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-remove-partial");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("remove-partial"),
      baseRef: probe.head!,
    });

    // 模拟 Windows 上的部分删除：删掉一部分内容就失败，目录仍在。
    const result = await removeWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: "iflow/super/remove-partial",
      baseRef: probe.head!,
      removeDir: async (p) => {
        rmSync(path.join(p, "a.txt"), { force: true });
      },
      retryDelaysMs: [1, 1],
    });

    expect(result.removed).toBe(false);
    expect(result.branchKept).toBe(true);
    expect(result.reason).toContain("残留目录");
    expect(existsSync(target)).toBe(true);
    expect(git(repo, "branch", "--list", "iflow/super/remove-partial")).toContain(
      "iflow/super/remove-partial",
    );
  }, 30000);

  it("目录删净后照常删分支（回归：重试逻辑不误伤正常路径）", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-remove-ok");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("remove-ok"),
      baseRef: probe.head!,
    });

    const result = await removeWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: "iflow/super/remove-ok",
      baseRef: probe.head!,
    });

    expect(result.removed).toBe(true);
    expect(result.branchKept).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(git(repo, "branch", "--list", "iflow/super/remove-ok")).not.toContain(
      "iflow/super/remove-ok",
    );
  }, 30000);

  it("inspectWorktreeState：正常 worktree 报告自身状态与分支", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-state");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("state"),
      baseRef: probe.head!,
    });

    const clean = await inspectWorktreeState(target);
    expect(clean.kind).toBe("worktree");
    expect(clean.clean).toBe(true);
    expect(clean.branch).toBe("iflow/super/state");

    writeFileSync(path.join(target, "scratch.txt"), "x\n", "utf8");
    const dirty = await inspectWorktreeState(target);
    expect(dirty.kind).toBe("worktree");
    expect(dirty.clean).toBe(false);
    expect(dirty.branch).toBe("iflow/super/state");
  }, 30000);

  it("inspectWorktreeState：半删残留（.git 没了）判为 not-a-worktree", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-half-deleted");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("half-deleted"),
      baseRef: probe.head!,
    });

    // 半删现场：.git 被删、其余文件还在。
    rmSync(path.join(target, ".git"), { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
    expect(existsSync(target)).toBe(true);

    const state = await inspectWorktreeState(target);
    expect(state.kind).toBe("not-a-worktree");
    // 证明不了干净 → 不能报干净。
    expect(state.clean).toBe(false);
    expect(state.branch).toBeNull();
  }, 30000);

  it("inspectWorktreeState：目录不存在判为 missing", async () => {
    const state = await inspectWorktreeState(
      path.join(tmpdir(), "iflow-wt-missing-does-not-exist"),
    );
    expect(state.kind).toBe("missing");
    expect(state.clean).toBe(false);
    expect(state.branch).toBeNull();
  }, 30000);

  it("worktreeHasUncommittedChanges：普通子目录不继承父仓库的「干净」结论", async () => {
    const repo = makeRepo();
    // 主仓是干净的 —— 旧实现在这里会报 false（当成干净，可以删），
    // 新实现必须报 true（拿不到状态 ≠ 干净）。
    expect(git(repo, "status", "--porcelain").trim()).toBe("");

    const plain = path.join(repo, "plain-dir");
    mkdirSync(plain, { recursive: true });
    expect(await worktreeHasUncommittedChanges(plain)).toBe(true);

    const state = await inspectWorktreeState(plain);
    expect(state.kind).toBe("not-a-worktree");
    expect(state.clean).toBe(false);
  }, 30000);

  it("worktreeHasUncommittedChanges：半删残留目录不返回主仓的状态", async () => {
    const repo = makeRepo();
    const probe = await probeGitRepo(repo);
    const target = targetPath("wt-residual-in-repo");
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("residual-in-repo"),
      baseRef: probe.head!,
    });
    // 残留目录搬进主仓内部（真实现场就是这样：worktree 树在仓库里）。
    const residual = path.join(repo, "residual");
    mkdirSync(residual, { recursive: true });
    writeFileSync(path.join(residual, "leftover.txt"), "x\n", "utf8");
    // 主仓此刻是脏的 —— 旧实现会把主仓的脏算到这个目录头上。
    writeFileSync(path.join(repo, "a.txt"), "dirty in main\n", "utf8");
    expect(git(repo, "status", "--porcelain")).toContain("a.txt");

    expect(await worktreeHasUncommittedChanges(residual)).toBe(true);
    const state = await inspectWorktreeState(residual);
    expect(state.kind).toBe("not-a-worktree");
    expect(state.clean).toBe(false);
  }, 30000);

  it("worktreeHasUncommittedChanges：worktree 自身的状态不受父仓库影响", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-independent");
    const probe = await probeGitRepo(repo);
    await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("independent"),
      baseRef: probe.head!,
    });
    // 主仓脏，worktree 干净 —— 两者必须各看各的。
    writeFileSync(path.join(repo, "a.txt"), "dirty in main\n", "utf8");

    expect(await worktreeHasUncommittedChanges(target)).toBe(false);
    const state = await inspectWorktreeState(target);
    expect(state.kind).toBe("worktree");
    expect(state.clean).toBe(true);
  }, 30000);
});

describe("worktree · 创建可靠性（重试 / 串行 / 超时 / 清理）", () => {
  /** 注入用的 runner：转发到真实 git，让目标目录真的被建出来。 */
  function realGitRunner(cwd: string, args: string[]) {
    const stdout = execFileSync("git", args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return Promise.resolve({ stdout, stderr: "" });
  }

  const isWorktreeAdd = (args: string[]): boolean =>
    args.includes("worktree") && args.includes("add");

  it("首次 git 调用失败、第二次成功 → attempts=2，目标目录真的建出来", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-retry-once");
    const probe = await probeGitRepo(repo);
    let addCalls = 0;
    const runner = async (cwd: string, args: string[], timeoutMs: number) => {
      if (isWorktreeAdd(args)) {
        addCalls += 1;
        if (addCalls === 1) {
          throw new Error("Command failed: git worktree add\nfatal: simulated transient failure");
        }
      }
      return realGitRunner(cwd, args);
    };

    const created = await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("retry-once"),
      baseRef: probe.head!,
      deps: { gitRunner: runner, retryDelaysMs: [] },
    });

    expect(created.attempts).toBe(2);
    expect(addCalls).toBe(2);
    expect(existsSync(path.join(target, "a.txt"))).toBe(true);
    expect(readText(path.join(target, "a.txt"))).toBe("one\n");
    expect(git(target, "branch", "--show-current").trim()).toBe("iflow/super/retry-once");
  }, 30000);

  it("目标目录预先存在导致首次失败 → 重试前被清掉，第二次成功", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-preexisting");
    const probe = await probeGitRepo(repo);
    // 非空目录：git worktree add 会直接 fatal（空目录反而是允许的）。
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "stale.txt"), "leftover\n", "utf8");

    const created = await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("preexisting"),
      baseRef: probe.head!,
      deps: { retryDelaysMs: [] },
    });

    expect(created.attempts).toBe(2);
    // 残留文件被清掉，换来的是真正的 checkout 结果。
    expect(existsSync(path.join(target, "stale.txt"))).toBe(false);
    expect(readText(path.join(target, "a.txt"))).toBe("one\n");
  }, 30000);

  it("并发创建被串行化：任意时刻最多一个创建在跑", async () => {
    const repo = makeRepo();
    const probe = await probeGitRepo(repo);
    let active = 0;
    let maxActive = 0;
    const runner = async (cwd: string, args: string[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        // 放大窗口：并发时这里会看到 active > 1。
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await realGitRunner(cwd, args);
      } finally {
        active -= 1;
      }
    };

    const [first, second] = await Promise.all([
      createWorktree({
        repoRoot: repo,
        targetPath: targetPath("wt-serial-a"),
        branch: superBranchName("serial-a"),
        baseRef: probe.head!,
        deps: { gitRunner: runner, retryDelaysMs: [] },
      }),
      createWorktree({
        repoRoot: repo,
        targetPath: targetPath("wt-serial-b"),
        branch: superBranchName("serial-b"),
        baseRef: probe.head!,
        deps: { gitRunner: runner, retryDelaysMs: [] },
      }),
    ]);

    expect(first.attempts).toBe(1);
    expect(second.attempts).toBe(1);
    expect(maxActive).toBe(1);
    expect(existsSync(path.join(first.path, "a.txt"))).toBe(true);
    expect(existsSync(path.join(second.path, "a.txt"))).toBe(true);
  }, 30000);

  it("win32 的 worktree add 带 -c core.longpaths=true，非 win32 不带", async () => {
    const repo = makeRepo();
    const probe = await probeGitRepo(repo);
    const seen: string[][] = [];
    const runner = async (cwd: string, args: string[]) => {
      if (isWorktreeAdd(args)) seen.push(args);
      return realGitRunner(cwd, args);
    };

    await createWorktree({
      repoRoot: repo,
      targetPath: targetPath("wt-longpaths-win"),
      branch: superBranchName("longpaths-win"),
      baseRef: probe.head!,
      deps: { gitRunner: runner, platform: "win32" },
    });
    await createWorktree({
      repoRoot: repo,
      targetPath: targetPath("wt-longpaths-linux"),
      branch: superBranchName("longpaths-linux"),
      baseRef: probe.head!,
      deps: { gitRunner: runner, platform: "linux" },
    });

    expect(seen).toHaveLength(2);
    const winArgs = seen[0]!;
    // 全局选项必须在子命令之前，否则 git 会当成 worktree 的参数拒绝。
    expect(winArgs.slice(0, 2)).toEqual(["-c", "core.longpaths=true"]);
    expect(winArgs.indexOf("-c")).toBeLessThan(winArgs.indexOf("worktree"));
    expect(seen[1]).not.toContain("core.longpaths=true");
  }, 30000);

  it("三次全失败 → 抛出的错误包含最后一次的真实 stderr", async () => {
    const repo = makeRepo();
    const target = targetPath("wt-always-fails");
    const probe = await probeGitRepo(repo);
    let calls = 0;
    const runner = async (_cwd: string, args: string[]) => {
      // 清理步骤（prune / rev-parse）也会走这个 runner —— 只数真正的 add。
      if (isWorktreeAdd(args)) {
        calls += 1;
        throw new Error(
          `Command failed: git worktree add\nfatal: could not create work tree dir (attempt ${calls})`,
        );
      }
      throw new Error("Command failed: git\nfatal: cleanup probe failed");
    };

    await expect(
      createWorktree({
        repoRoot: repo,
        targetPath: target,
        branch: superBranchName("always-fails"),
        baseRef: probe.head!,
        deps: { gitRunner: runner, retryDelaysMs: [] },
      }),
    ).rejects.toThrow(/fatal: could not create work tree dir \(attempt 3\)/);

    expect(calls).toBe(3);
    expect(existsSync(target)).toBe(false);
    // 一次都没真正建出分支 —— 不该留下占着名字的空分支。
    expect(() => git(repo, "rev-parse", "--verify", "refs/heads/iflow/super/always-fails")).toThrow();
  }, 30000);
});
