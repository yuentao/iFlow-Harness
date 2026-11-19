import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SuperSessionUi } from "../shared/super-agent.js";

/**
 * 准备期取消的回归测试需要把 cancel 精确卡在「worktree 已建好、isolation 还没
 * 写回记录」的窗口里。真实 git 调用太快，无法稳定命中，所以只 mock worktree
 * 层让建 worktree 挂在一个门闩上，其余工具保持真实实现。
 */
const state = vi.hoisted(() => ({
  gates: [] as Array<() => void>,
}));

vi.mock("../src/panel/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/panel/worktree.js")>();
  return {
    ...actual,
    probeGitRepo: async () => ({ isRepo: true, head: "HEAD" }),
    ensureSuperIsolationIgnored: async () => undefined,
    createWorktree: async () => {
      await new Promise<void>((resolve) => {
        state.gates.push(resolve);
      });
    },
  };
});

import { SuperAgentManager } from "../src/panel/super-agent.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("super agent · 准备期取消不留孤儿隔离", () => {
  it("worktree 建到一半被取消：isolation 在终态守卫之前写回记录", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "iflow-super-prepcancel-"));
    roots.push(root);
    const sessions: SuperSessionUi[] = [];
    const manager = new SuperAgentManager({
      repoRoot: root,
      createClient: async () => {
        throw new Error("prepare should have aborted before creating a client");
      },
      onSessionsChanged: (next) => {
        sessions.length = 0;
        sessions.push(...next);
      },
      onReport: () => {},
      currentModel: () => "test-model",
      currentMainSessionId: () => "main-1",
      integrationMode: () => "manual",
      maxConcurrentSessions: () => 5,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    try {
      const child = manager.spawn({ title: "改登录", task: "干活" });

      // 等 createWorktree 进入门闩（worktree 已准备创建，但 isolation 尚未写回）。
      const deadline = Date.now() + 5000;
      while (state.gates.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(state.gates.length).toBe(1);

      // 此刻中断：apply(cancelled) 落在终态守卫之前。
      await manager.cancel(child.id);
      expect(manager.get(child.id)?.status).toBe("cancelled");

      // 放行 createWorktree：prepareInner 继续走到那道终态早退守卫。
      state.gates.shift()!();

      const deadline2 = Date.now() + 5000;
      while (
        manager.get(child.id)?.isolation.kind !== "git_worktree" &&
        Date.now() < deadline2
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const isolation = manager.get(child.id)?.isolation;
      // 修复前：守卫直接 return，记录里仍是占位的 directory/path=""，磁盘上的
      // worktree 与分支成为无人认领的孤儿。修复后：isolation 已在守卫前写回。
      expect(isolation?.kind).toBe("git_worktree");
      if (isolation?.kind === "git_worktree") {
        expect(isolation.path).toBeTruthy();
        expect(isolation.branch).toContain("iflow/super/");
      }
    } finally {
      await manager.dispose();
    }
  }, 30000);
});
