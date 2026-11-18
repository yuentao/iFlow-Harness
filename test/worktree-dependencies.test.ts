import { describe, it, expect, afterAll } from "vitest";
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
  presetWorktreeDependencies,
  probeGitRepo,
  removeWorktree,
  superBranchName,
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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** 一个真实 git 仓库（一个提交），`.gitignore` 按需忽略 node_modules。 */
function makeRepo(options: { ignoreNodeModules?: boolean } = {}): string {
  const dir = tempDir("iflow-deps-");
  git(dir, "init");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  if (options.ignoreNodeModules !== false) {
    writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

/**
 * 在主仓根造一棵假的依赖树：
 *   node_modules/{pkg-a/index.js,pkg-a/package.json,.bin/shime}
 *   node_modules/linked-pkg → <repo>/packages/linked-pkg（junction）
 */
function makeNodeModules(repoRoot: string): void {
  const nm = path.join(repoRoot, "node_modules");
  mkdirSync(path.join(nm, "pkg-a"), { recursive: true });
  mkdirSync(path.join(nm, ".bin"), { recursive: true });
  writeFileSync(path.join(nm, "pkg-a", "package.json"), '{"name":"pkg-a"}\n', "utf8");
  writeFileSync(path.join(nm, "pkg-a", "index.js"), "module.exports = 1;\n", "utf8");
  writeFileSync(path.join(nm, ".bin", "shime"), "#!/bin/sh\n", "utf8");

  const linked = path.join(repoRoot, "packages", "linked-pkg");
  mkdirSync(linked, { recursive: true });
  writeFileSync(path.join(linked, "package.json"), '{"name":"linked-pkg"}\n', "utf8");
  // junction 在 Windows 上不需要管理员权限；POSIX 上就是普通目录链接。
  symlinkSync(linked, path.join(nm, "linked-pkg"), "junction");
}

/** 建一个真实 worktree（走生产路径：建完即预置依赖）。 */
async function makeWorktree(repoRoot: string, name: string) {
  const probe = await probeGitRepo(repoRoot);
  const target = path.join(repoRoot, ".iflow", "super", "worktrees", name);
  const created = await createWorktree({
    repoRoot,
    targetPath: target,
    branch: superBranchName(name),
    baseRef: probe.head!,
  });
  return { created, target };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("worktree · 依赖预置（硬链接）", () => {
  it("建出真实目录，抽样文件与源 inode 一致（确为硬链接，不是符号链接）", async () => {
    const repo = makeRepo();
    makeNodeModules(repo);
    const { created } = await makeWorktree(repo, "deps-ok");

    expect(created.dependencies?.ok).toBe(true);
    expect(created.dependencies?.files).toBe(3);
    expect(created.dependencies?.dirs).toBeGreaterThanOrEqual(3);
    // 指向 node_modules 之外的目录链接改建真实空目录（防写穿透），
    // 不计入 symlinks；包内链接仍按链接复刻。
    expect(created.dependencies?.symlinks).toBe(0);

    const source = path.join(repo, "node_modules");
    const target = path.join(created.path, "node_modules");
    for (const rel of ["pkg-a/index.js", "pkg-a/package.json", ".bin/shime"]) {
      const srcStat = statSync(path.join(source, rel), { bigint: true });
      const dstStat = statSync(path.join(target, rel), { bigint: true });
      // 同一 inode → 硬链接；nlink 至少 2（源 + 目标）。
      expect(dstStat.ino).toBe(srcStat.ino);
      expect(Number(dstStat.nlink)).toBeGreaterThanOrEqual(2);
      expect(lstatSync(path.join(target, rel)).isSymbolicLink()).toBe(false);
    }
    // 外部目录链接不再复刻 junction：它是 worktree 内的真实空目录，
    // 子代理写到这里的任何内容都不会穿透回主仓。
    expect(lstatSync(path.join(target, "linked-pkg")).isSymbolicLink()).toBe(false);
    expect(statSync(path.join(target, "linked-pkg")).isDirectory()).toBe(true);
  }, 30000);

  it("幂等：目标已存在时整棵预置跳过，不报错也不改动", async () => {
    const repo = makeRepo();
    makeNodeModules(repo);
    const { target } = await makeWorktree(repo, "deps-idempotent");
    const marker = path.join(target, "node_modules", "pkg-a", "index.js");
    const before = statSync(marker, { bigint: true });

    const again = await presetWorktreeDependencies({
      repoRoot: repo,
      worktreePath: target,
    });
    expect(again.ok).toBe(false);
    expect(again.skip).toBe("already-present");
    const after = statSync(marker, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }, 30000);

  it("闸 1：主仓没有 node_modules 时静默跳过", async () => {
    const repo = makeRepo();
    const dir = tempDir("iflow-deps-empty-");
    const result = await presetWorktreeDependencies({ repoRoot: repo, worktreePath: dir });
    expect(result.ok).toBe(false);
    expect(result.skip).toBe("no-source");
    expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
  }, 30000);

  it("闸 1：主仓 node_modules 是链接（junction/symlink）时跳过，不跟随目标", async () => {
    const repo = makeRepo();
    const outside = tempDir("iflow-deps-outside-");
    mkdirSync(path.join(outside, "node_modules", "pkg-x"), { recursive: true });
    writeFileSync(path.join(outside, "node_modules", "pkg-x", "index.js"), "module.exports = 1;\n");
    symlinkSync(
      path.join(outside, "node_modules"),
      path.join(repo, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const wt = tempDir("iflow-deps-linked-");

    const result = await presetWorktreeDependencies({ repoRoot: repo, worktreePath: wt });
    expect(result.ok).toBe(false);
    expect(result.skip).toBe("no-source");
    expect(existsSync(path.join(wt, "node_modules"))).toBe(false);
  }, 30000);

  it("闸 2：node_modules 未被 git 忽略时跳过（避免 git add -A 把它提交进分支）", async () => {
    const repo = makeRepo({ ignoreNodeModules: false });
    makeNodeModules(repo);
    const wt = path.join(repo, "wt");
    mkdirSync(wt, { recursive: true });

    const result = await presetWorktreeDependencies({ repoRoot: repo, worktreePath: wt });
    expect(result.ok).toBe(false);
    expect(result.skip).toBe("not-ignored");
    expect(existsSync(path.join(wt, "node_modules"))).toBe(false);
  }, 30000);

  it("闸 3：link 抛 EXDEV 时整体回退，不留半成品，worktree 仍可用", async () => {
    const repo = makeRepo();
    makeNodeModules(repo);
    const { target } = await makeWorktree(repo, "deps-exdev");
    // 先删掉成功预置的树，模拟「第一次预置就跨卷失败」。
    rmSync(path.join(target, "node_modules"), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    const result = await presetWorktreeDependencies({
      repoRoot: repo,
      worktreePath: target,
      fs: {
        link: async () => {
          throw Object.assign(new Error("EXDEV: cross-device link not permitted"), {
            code: "EXDEV",
          });
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("EXDEV");
    // 已建的目录被清干净，没有半成品。
    expect(existsSync(path.join(target, "node_modules"))).toBe(false);
    // 调用方拿到的 worktree 完好。
    expect(readFileSync(path.join(target, "a.txt"), "utf8")).toBe("one\n");
  }, 30000);

  it("清理安全：删掉 worktree 后主仓 node_modules 完整存在（不顺着链接删）", async () => {
    const repo = makeRepo();
    makeNodeModules(repo);
    const { target } = await makeWorktree(repo, "deps-cleanup");
    const sourceFile = path.join(repo, "node_modules", "pkg-a", "index.js");
    const beforeIno = statSync(sourceFile, { bigint: true }).ino;

    const removed = await removeWorktree({
      repoRoot: repo,
      targetPath: target,
      branch: superBranchName("deps-cleanup"),
      baseRef: (await probeGitRepo(repo)).head!,
    });
    expect(removed.removed).toBe(true);
    expect(existsSync(target)).toBe(false);
    // 源文件还在，inode 未变 —— 删掉的只是 worktree 里那个链接名。
    expect(existsSync(sourceFile)).toBe(true);
    expect(statSync(sourceFile, { bigint: true }).ino).toBe(beforeIno);
    expect(readFileSync(sourceFile, "utf8")).toContain("module.exports");
    // 指向主仓 packages 的目录链接已改建为 worktree 内空目录：主仓文件更不该被碰到。
    const junctionTarget = path.join(repo, "packages", "linked-pkg", "package.json");
    expect(existsSync(junctionTarget)).toBe(true);
    expect(readFileSync(junctionTarget, "utf8")).toContain("linked-pkg");
  }, 30000);
});
