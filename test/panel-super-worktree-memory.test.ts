import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import {
  externalSuperWorktreeRoot,
  homeSuperWorktreeRoot,
  isSuperWorktreeRootSafeAt,
  probeGitRepo,
  resolveSuperWorktreeRoot,
  sanitizeWorktreeName,
  superIsolationDir,
  superRepoKey,
  superWorktreeRoots,
  worktreePathFor,
  type SuperWorktreeRootProbe,
} from "../src/panel/worktree.js";

/** 固定的路径布局（纯路径计算，不落盘）。 */
function layout() {
  const base = path.join(os.tmpdir(), "iflow-wt-mem");
  const repoRoot = path.join(base, "repo");
  const globalDir = path.join(base, "global", ".iflow");
  return { base, repoRoot, globalDir };
}

describe("super worktree · 回退落点不再双份注入 AGENTS.md", () => {
  it("外部兄弟目录祖先链干净时优先外部落点", () => {
    const { repoRoot, globalDir } = layout();
    const resolved = resolveSuperWorktreeRoot(repoRoot, { exists: () => false }, { globalDir });
    expect(resolved).toEqual({ root: externalSuperWorktreeRoot(repoRoot), external: true });
  });

  it("外部被判不安全时回退到全局目录 per-repo 子树，且不在主仓内", () => {
    const { base, repoRoot, globalDir } = layout();
    const probe: SuperWorktreeRootProbe = {
      exists: (candidate) => candidate === path.join(base, "AGENTS.md"),
    };
    const resolved = resolveSuperWorktreeRoot(repoRoot, probe, { globalDir });
    expect(resolved.external).toBe(true);
    expect(resolved.root).toBe(homeSuperWorktreeRoot(repoRoot, globalDir));
    expect(resolved.root.startsWith(repoRoot)).toBe(false);
    expect(path.relative(repoRoot, resolved.root).startsWith("..")).toBe(true);
  });

  it("回退落点的祖先链在 CLI 遍历范围内不含任何 AGENTS.md / IFLOW.md（核心）", () => {
    const { base, repoRoot, globalDir } = layout();
    // 外部祖先链与「全局目录的父目录」各放一份记忆文件。后者正是 CLI 遍历
    // 到全局目录就终止、读不到的那份；若安全检查只跳过停止点那层而不终止，
    // 它会被误判为不安全 → 回退主仓内 → 双份注入 bug 复现。
    const badExternal = path.join(base, "AGENTS.md");
    const aboveGlobal = path.join(base, "global", "IFLOW.md");
    const probe: SuperWorktreeRootProbe = {
      exists: (candidate) => candidate === badExternal || candidate === aboveGlobal,
    };
    const resolved = resolveSuperWorktreeRoot(repoRoot, probe, { globalDir });
    expect(resolved.external).toBe(true);
    expect(resolved.root).toBe(homeSuperWorktreeRoot(repoRoot, globalDir));

    // 逐级向上：模拟 CLI 的遍历（root 父目录 → 全局目录，到达即终止），
    // 区间内不得命中任何记忆文件。
    let dir = path.dirname(resolved.root);
    const drive = path.parse(dir).root;
    let memoryCheckActive = true;
    let levels = 0;
    for (;;) {
      if (memoryCheckActive) {
        expect(probe.exists(path.join(dir, "AGENTS.md")), dir).toBe(false);
        expect(probe.exists(path.join(dir, "IFLOW.md")), dir).toBe(false);
      }
      levels += 1;
      if (dir === drive) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      if (path.resolve(dir) === path.resolve(globalDir)) memoryCheckActive = false;
    }
    expect(levels).toBeGreaterThan(2);

    // 反证：不带停止点（旧语义）会撞上 aboveGlobal / badExternal 判为不安全；
    // 带停止点则到达全局目录即终止，安全。
    expect(isSuperWorktreeRootSafeAt(resolved.root, probe, {})).toBe(false);
    expect(
      isSuperWorktreeRootSafeAt(resolved.root, probe, { memoryStopAt: globalDir }),
    ).toBe(true);
  });

  it("既有约束：slug 截断、路径不越界、root 在候选落点内、per-repo key 隔离", () => {
    const { repoRoot, globalDir } = layout();
    const longSlug = sanitizeWorktreeName("a".repeat(100));
    expect(longSlug).toHaveLength(24);
    expect(sanitizeWorktreeName("")).toBe("task");

    const home = homeSuperWorktreeRoot(repoRoot, globalDir);
    expect(home.startsWith(globalDir + path.sep)).toBe(true);
    expect(path.relative(globalDir, home).startsWith("..")).toBe(false);

    // worktreePathFor 的目录名带 24 字符 slug；根必须是候选落点之一（默认
    // probe 依赖真实磁盘，不断言具体是哪一个）。
    const wt = worktreePathFor(repoRoot, longSlug, "unique1");
    expect(path.basename(wt)).toBe(`${longSlug}-unique1`);
    expect(
      new Set([
        externalSuperWorktreeRoot(repoRoot),
        homeSuperWorktreeRoot(repoRoot),
        superIsolationDir(repoRoot, "worktrees"),
      ]).has(path.dirname(wt)),
    ).toBe(true);

    // per-repo key 稳定，且同名不同路径不撞（残留清扫不误伤别的仓库）。
    expect(superRepoKey(repoRoot)).toBe(superRepoKey(repoRoot));
    expect(superRepoKey(repoRoot)).not.toBe(
      superRepoKey(path.join(path.dirname(repoRoot), "other-repo")),
    );

    // 清扫 / 归档覆盖所有落点（新增的全局目录落点不能被漏掉）。
    const roots = superWorktreeRoots(repoRoot);
    expect(roots).toContain(externalSuperWorktreeRoot(repoRoot));
    expect(roots).toContain(homeSuperWorktreeRoot(repoRoot));
    expect(roots).toContain(superIsolationDir(repoRoot, "worktrees"));
  });

  it("非 git 仓库降级行为不变：识别为非仓库，降级目录仍为 .iflow/super/dirs", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "iflow-nogit-wt-"));
    try {
      const probe = await probeGitRepo(dir);
      expect(probe.isRepo).toBe(false);
      expect(probe.head).toBeNull();
      expect(superIsolationDir(dir, "dirs")).toBe(path.join(dir, ".iflow", "super", "dirs"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
