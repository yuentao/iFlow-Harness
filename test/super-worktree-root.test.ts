import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  externalSuperWorktreeRoot,
  isSuperWorktreeRootSafe,
  resolveSuperWorktreeRoot,
  sanitizeWorktreeName,
  superIsolationDir,
  type SuperWorktreeRootProbe,
} from "../src/panel/worktree.js";

/** 用「命中路径集合」构造可注入的 fs 探测（纯函数，不碰真实磁盘）。 */
const probeWith = (bad: string[]): SuperWorktreeRootProbe => {
  const set = new Set(bad.map((p) => path.resolve(p)));
  return { exists: (candidate) => set.has(path.resolve(candidate)) };
};

describe("super worktree root · 移出主仓目录树", () => {
  it("新根作为主仓的兄弟目录，不在 repoRoot 之内", () => {
    const repoRoot = path.join(os.tmpdir(), "iflow-root-test", "iflow-harness");
    const root = externalSuperWorktreeRoot(repoRoot);
    expect(root).toBe(path.join(path.dirname(repoRoot), "iflow-harness-super-worktrees"));
    // ① 默认路径不在 repoRoot 之内
    expect(root.startsWith(repoRoot)).toBe(false);
    expect(root.startsWith(path.dirname(repoRoot) + path.sep)).toBe(true);
  });

  it("② 祖先链上的 AGENTS.md / IFLOW.md / .git 均判定为不安全", () => {
    const repoRoot = path.join(os.tmpdir(), "iflow-safety", "repo");
    const parent = path.dirname(repoRoot); // 新根的父目录 = 检查起点
    const grandParent = path.dirname(parent);
    for (const marker of ["AGENTS.md", "IFLOW.md", ".git"]) {
      // 父目录层命中
      expect(isSuperWorktreeRootSafe(repoRoot, probeWith([path.join(parent, marker)]))).toBe(false);
      // 更上层祖先命中
      expect(isSuperWorktreeRootSafe(repoRoot, probeWith([path.join(grandParent, marker)]))).toBe(false);
    }
    // 干净祖先链 → 安全
    expect(isSuperWorktreeRootSafe(repoRoot, probeWith([]))).toBe(true);
  });

  it("③ slug 仍截断到 24 字符（Windows 路径长度限制）", () => {
    expect(sanitizeWorktreeName("a".repeat(100)).length).toBe(24);
    expect(sanitizeWorktreeName("这是一个非常非常非常非常非常长的中文标题用于测试截断abcdefghijk").length).toBe(24);
    // 短标题不变、空标题回退 task
    expect(sanitizeWorktreeName("Fix Login")).toBe("fix-login");
    expect(sanitizeWorktreeName("")).toBe("task");
  });

  it("④ 安全检查通过选新位置，不通过回退到主仓内旧位置", () => {
    const repoRoot = path.join(os.tmpdir(), "iflow-resolve", "repo");
    const parent = path.dirname(repoRoot);

    const safe = resolveSuperWorktreeRoot(repoRoot, probeWith([]));
    expect(safe.external).toBe(true);
    expect(safe.root).toBe(externalSuperWorktreeRoot(repoRoot));

    const unsafe = resolveSuperWorktreeRoot(repoRoot, probeWith([path.join(parent, "AGENTS.md")]));
    expect(unsafe.external).toBe(false);
    expect(unsafe.root).toBe(superIsolationDir(repoRoot, "worktrees"));
    expect(unsafe.root.startsWith(repoRoot)).toBe(true);
  });
});
