import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  branchHasUnmergedCommits,
  commitWorktree,
  createWorktree,
  currentBranch,
  ensureSuperIsolationIgnored,
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
