import { describe, it, expect, afterAll, vi } from "vitest";

// 本文件跑真实 git（建仓 / 中间态 / merge / junction 写穿透），在 CI runner
// 与全量并发下单个用例可能跑十几秒。按文件放宽超时，不动全局 testTimeout。
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorktree,
  detectInProgress,
  ensureSuperIsolationIgnored,
  mergeBranch,
  previewMerge,
  probeGitRepo,
  superBranchName,
  type WorktreeGitRunner,
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

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-merge-safety-"));
  roots.push(dir);
  git(dir, "init");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

function targetPath(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-merge-target-"));
  roots.push(dir);
  return path.join(dir, name);
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("SA-D · 修复一：合并中间态检测齐全", () => {
  it("所有 git 中间态标记都被检查（revert / sequencer / rebase-* 不再遗漏）", async () => {
    const seen: string[] = [];
    const deps = {
      marker: async (_repo: string, name: string): Promise<boolean> => {
        seen.push(name);
        return name === "REVERT_HEAD";
      },
    };
    expect(await detectInProgress("/fake", deps)).toBe("revert");
    for (const name of [
      "MERGE_HEAD",
      "REBASE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
    ]) {
      expect(seen).toContain(name);
    }

    const seq = await detectInProgress("/fake", {
      marker: async (_r: string, n: string) => n === "sequencer",
    });
    expect(seq).toBe("sequencer");
    expect(await detectInProgress("/fake", { marker: async () => false })).toBeNull();
  });

  it("真实仓库：REVERT_HEAD / sequencer 存在时识别为中间态", async () => {
    const repo = makeRepo();
    expect(await detectInProgress(repo)).toBeNull();
    const gitDir = path.resolve(repo, git(repo, "rev-parse", "--git-dir").trim());
    const revertHead = path.join(gitDir, "REVERT_HEAD");
    writeFileSync(revertHead, `${git(repo, "rev-parse", "HEAD").trim()}\n`, "utf8");
    expect(await detectInProgress(repo)).toBe("revert");
    rmSync(revertHead);
    mkdirSync(path.join(gitDir, "sequencer"), { recursive: true });
    expect(await detectInProgress(repo)).toBe("sequencer");
  });

  it("revert 中间态存在时 mergeBranch 不启动合并", async () => {
    const repo = makeRepo();
    const gitDir = path.resolve(repo, git(repo, "rev-parse", "--git-dir").trim());
    mkdirSync(path.join(gitDir, "sequencer"), { recursive: true });
    const result = await mergeBranch({ repoRoot: repo, branch: "iflow/super/nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("sequencer");
  });
});

describe("SA-D · 修复二：abort 的 TOCTOU 竞态", () => {
  it("MERGE_HEAD 不属于本分支时不 abort（那是用户自己的合并）", async () => {
    const calls: string[] = [];
    let mergeFailed = false;
    const runner: WorktreeGitRunner = async (_cwd, args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "rev-parse HEAD") return { stdout: "base-head\n", stderr: "" };
      if (key === "rev-parse --verify iflow/super/child") {
        return { stdout: "child-tip\n", stderr: "" };
      }
      // 两次探测之间用户启动了自己的 merge：MERGE_HEAD 指向他的 tip。
      if (key === "rev-parse -q --verify MERGE_HEAD") {
        return mergeFailed
          ? { stdout: "user-merge-tip\n", stderr: "" }
          : { stdout: "", stderr: "" };
      }
      if (args[0] === "merge" && args.includes("--no-ff")) {
        mergeFailed = true;
        throw new Error("conflict");
      }
      return { stdout: "", stderr: "" };
    };
    const result = await mergeBranch({
      repoRoot: "/fake",
      branch: "iflow/super/child",
      deps: { run: runner, marker: async () => false },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("refusing to abort it");
    expect(calls).not.toContain("merge --abort");
  });

  it("MERGE_HEAD 指向本分支 tip、HEAD 未变时照常 abort 我们自己的合并", async () => {
    const calls: string[] = [];
    let mergeFailed = false;
    const runner: WorktreeGitRunner = async (_cwd, args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "rev-parse HEAD") return { stdout: "base-head\n", stderr: "" };
      if (key === "rev-parse --verify iflow/super/child") {
        return { stdout: "child-tip\n", stderr: "" };
      }
      if (key === "rev-parse -q --verify MERGE_HEAD") {
        return mergeFailed
          ? { stdout: "child-tip\n", stderr: "" }
          : { stdout: "", stderr: "" };
      }
      if (args[0] === "merge" && args.includes("--no-ff")) {
        mergeFailed = true;
        throw new Error("conflict");
      }
      return { stdout: "", stderr: "" };
    };
    const result = await mergeBranch({
      repoRoot: "/fake",
      branch: "iflow/super/child",
      deps: { run: runner, marker: async () => false },
    });
    expect(result.ok).toBe(false);
    expect(calls).toContain("merge --abort");
  });
});

describe("SA-D · 修复三：多 merge-base 保守回退", () => {
  it("多个 merge base 时预览返回不可用", async () => {
    let mergeTreeCalled = false;
    const runner: WorktreeGitRunner = async (_cwd, args) => {
      if (args[0] === "merge-base") return { stdout: "aaa\nbbb\n", stderr: "" };
      if (args[0] === "diff") return { stdout: "a.txt\0", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const preview = await previewMerge({
      repoRoot: "/fake",
      branch: "iflow/super/child",
      deps: {
        run: runner,
        runRaw: async () => {
          mergeTreeCalled = true;
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    expect(preview.available).toBe(false);
    expect(mergeTreeCalled).toBe(false);
  });

  it("单个 merge base 时照常预演，且确实使用 --all", async () => {
    const calls: string[] = [];
    const runner: WorktreeGitRunner = async (_cwd, args) => {
      calls.push(args.join(" "));
      if (args[0] === "merge-base") return { stdout: "aaa\n", stderr: "" };
      if (args[0] === "diff") return { stdout: "a.txt\0", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const preview = await previewMerge({
      repoRoot: "/fake",
      branch: "iflow/super/child",
      deps: {
        run: runner,
        runRaw: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    });
    expect(calls.some((call) => call.startsWith("merge-base --all"))).toBe(true);
    expect(preview.available).toBe(true);
    expect(preview.clean).toBe(true);
    expect(preview.paths).toEqual(["a.txt"]);
  });
});

describe("SA-D · 修复四：外部目录 junction 写穿透", () => {
  function makeNodeModules(repoRoot: string): void {
    const nm = path.join(repoRoot, "node_modules");
    mkdirSync(path.join(nm, "pkg-a"), { recursive: true });
    writeFileSync(path.join(nm, "pkg-a", "index.js"), "module.exports = 1;\n", "utf8");
    const linked = path.join(repoRoot, "packages", "linked-pkg");
    mkdirSync(linked, { recursive: true });
    writeFileSync(path.join(linked, "package.json"), '{"name":"linked-pkg"}\n', "utf8");
    symlinkSync(
      linked,
      path.join(nm, "linked-pkg"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  it("指向 node_modules 之外的目录链接改建真实空目录，写入不穿透回主仓", async () => {
    const repo = makeRepo();
    makeNodeModules(repo);
    const target = targetPath("wt-external-link");
    const probe = await probeGitRepo(repo);
    const created = await createWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("external-link"),
      baseRef: probe.head!,
    });
    expect(created.dependencies?.ok).toBe(true);
    const inside = path.join(target, "node_modules", "linked-pkg");
    expect(lstatSync(inside).isSymbolicLink()).toBe(false);
    expect(statSync(inside).isDirectory()).toBe(true);
    writeFileSync(path.join(inside, "scratch.txt"), "child\n", "utf8");
    // 主仓那一侧完全没有被写到 —— 写穿透通道已切断。
    expect(existsSync(path.join(repo, "packages", "linked-pkg", "scratch.txt"))).toBe(false);
    // symlinks 只统计真正按链接复刻的项；这个外部目录链接被替换掉了。
    expect(created.dependencies?.symlinks).toBe(0);
  });
});

describe("SA-D · 修复七：exclude 并发幂等", () => {
  it("并发 prepare 时隔离目录只写一行 exclude", async () => {
    const repo = makeRepo();
    await Promise.all(
      Array.from({ length: 8 }, () => ensureSuperIsolationIgnored(repo)),
    );
    const exclude = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(
      exclude.split(/\r?\n/).filter((line) => line.trim() === ".iflow/super/"),
    ).toHaveLength(1);
  });
});