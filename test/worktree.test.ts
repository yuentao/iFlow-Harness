import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  branchHasUnmergedCommits,
  createWorktree,
  currentBranch,
  inspectWorkingTree,
  listWorktrees,
  mergeBranch,
  probeGitRepo,
  remoteOriginUrl,
  removeWorktree,
  repoSlug,
  sanitizeWorktreeName,
  superBranchName,
  worktreePathFor,
} from "../src/panel/worktree.js";

const roots: string[] = [];

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

/** Read a file with CRLF normalized (checkout may translate line endings). */
function readText(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
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

  it("同名目录按绝对路径区分", () => {
    const a = repoSlug(path.join("C:", "work", "api"));
    const b = repoSlug(path.join("D:", "other", "api"));
    expect(a).not.toBe(b);
    expect(repoSlug(path.join("C:", "work", "api"))).toBe(a);
  });

  it("worktree 路径落在 storage 之下，不在仓库里", () => {
    const p = worktreePathFor("C:/storage", "C:/work/api", "fix-login", "abc");
    expect(p.startsWith(path.join("C:/storage", "super-worktrees"))).toBe(true);
    expect(p).toContain("abc");
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

describe("worktree · 自动合并的前置检查", () => {
  it("干净的已提交仓库判定为可合并", async () => {
    const repo = makeRepo();
    const state = await inspectWorkingTree(repo);
    expect(state.clean).toBe(true);
    expect(state.dirtyCount).toBe(0);
    expect(state.inProgress).toBeNull();
    expect(await currentBranch(repo)).toBeTruthy();
  }, 30000);

  it("未跟踪文件也算脏 —— 自动合并必须让路", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "untracked.txt"), "x\n", "utf8");
    const state = await inspectWorkingTree(repo);
    expect(state.clean).toBe(false);
    expect(state.dirtyCount).toBeGreaterThan(0);
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
