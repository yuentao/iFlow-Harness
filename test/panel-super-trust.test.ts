import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// 本文件会拉起真实 git 进程（建仓 / worktree），在 CI runner 与全量并发下
// 单个用例可能跑十几秒。按文件放宽超时，不动 vitest.config.ts 的全局值。
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import type { AcpClient, AcpClientCallbacks } from "../src/acp/client.js";
import { SuperAgentManager, buildTaskPrompt } from "../src/panel/super-agent.js";
import { superIsolationLabel, type SuperSessionUi } from "../shared/super-agent.js";
import { classifyChildShellCommand } from "../shared/super-agent-guard.js";
import {
  buildChildSessionSettingsForTrust,
  effectiveMcpServerNamesForTrust,
} from "../shared/super-tool-policy.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-fulltrust-"));
  roots.push(dir);
  git(dir, "init");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const fullTrustIsolation: SuperSessionUi["isolation"] = {
  kind: "repo",
  path: "/work",
  fullTrust: true,
  note: "完全信任（主仓工作区）",
};

const fullTrustBrief = (): string => buildTaskPrompt("改登录", "干活", fullTrustIsolation);

/** Minimal AcpClient stand-in; the manager only touches this surface. */
function makeFakeClient(
  callbacks: AcpClientCallbacks,
  spawnInfo: { cwd: string; allowedRoots: string[]; includeDirectories: string[] },
  clients: Array<typeof spawnInfo>,
): AcpClient {
  clients.push(spawnInfo);
  return {
    callbacks,
    async newSession() {
      return { sessionId: "sub" };
    },
    async setMode() {
      return {};
    },
    async setModel() {
      return {};
    },
    async prompt() {
      return { stopReason: "end_turn" };
    },
    async cancel() {},
    async dispose() {
      callbacks.onExit?.(0, null);
    },
  } as unknown as AcpClient;
}

describe("super agent · fullTrust 纯逻辑（工具 / MCP 白名单）", () => {
  it("默认 false 时逐字保持既有白名单行为", () => {
    expect(buildChildSessionSettingsForTrust(false, [], [])).toBeUndefined();
    expect(buildChildSessionSettingsForTrust(false, ["read_file"], [])).toEqual({
      allowed_tools: ["read_file"],
    });
    expect(effectiveMcpServerNamesForTrust(false, [], ["a", "b"])).toEqual(["a", "b"]);
    expect(effectiveMcpServerNamesForTrust(false, ["a", "x"], ["a", "b"])).toEqual(["a"]);
    // 配了白名单但一个都不存在 → [] → buildAcpCommand 翻成哨兵（既有语义）。
    expect(effectiveMcpServerNamesForTrust(false, ["x"], ["a", "b"])).toEqual([]);
  });

  it("完全信任时忽略工具白名单：settings 为 undefined", () => {
    expect(buildChildSessionSettingsForTrust(true, ["read_file"], ["a"])).toBeUndefined();
    expect(buildChildSessionSettingsForTrust(true, [], [])).toBeUndefined();
  });

  it("完全信任时 MCP 用 broker 全量，且 broker 为空时不产生哨兵", () => {
    expect(effectiveMcpServerNamesForTrust(true, ["a"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(effectiveMcpServerNamesForTrust(true, [], ["a", "b"])).toEqual(["a", "b"]);
    expect(effectiveMcpServerNamesForTrust(true, ["a"], [])).toBeUndefined();
    expect(effectiveMcpServerNamesForTrust(true, [], undefined)).toBeUndefined();
  });
});

describe("super agent · fullTrust 任务书契约", () => {
  it("看板标签标注「完全信任（主仓工作区）」，普通 repo 档文案不变", () => {
    expect(superIsolationLabel(fullTrustIsolation)).toBe("完全信任（主仓工作区）");
    expect(superIsolationLabel({ kind: "repo", path: "/work" })).toBe("直接在主工作区（无隔离）");
  });

  it("完全信任任务书放开 push / PR / 合并，但仍只提交本任务文件并禁 force push / --no-verify", () => {
    const brief = fullTrustBrief();
    expect(brief).toContain("Working directory: /work");
    expect(brief).toContain("FULL TRUST mode");
    expect(brief).toContain(
      "you may read and write repository files, run arbitrary commands, push, open pull requests and merge here",
    );
    expect(brief).toContain("you may push, open pull requests, merge, and switch/create/delete branches");
    expect(brief).toContain("ONLY the files that belong to this task");
    expect(brief).toContain("never `git add -A`");
    expect(brief).toContain("never force push");
    expect(brief).toContain("`--force-with-lease`");
    expect(brief).toContain("`--no-verify`");
    // 合并子会话的三条否定契约不得串味。
    expect(brief).not.toContain("Do not switch, rename or delete branches, and do not push");
    expect(brief).not.toContain("do not create commits of your own");
  });

  it("默认 repo 档任务书逐字保留「不许 push / 不许自己提交」契约", () => {
    const brief = buildTaskPrompt("合并", "干活", { kind: "repo", path: "/work" });
    expect(brief).toContain("do not create commits of your own");
    expect(brief).toContain("never push, rebase, delete or switch branches");
    expect(brief).not.toContain("FULL TRUST mode");
  });
});

describe("super agent · fullTrust 派发（cwd / allowedRoots / 无 worktree）", () => {
  it("fullTrust=true 时直接在主仓根运行，不建 worktree 与分支，看板标注完全信任", async () => {
    const repoRoot = makeRepo();
    type SpawnInfo = { cwd: string; allowedRoots: string[]; includeDirectories: string[] };
    const clients: SpawnInfo[] = [];
    let sessions: SuperSessionUi[] = [];
    const manager = new SuperAgentManager({
      repoRoot,
      fullTrust: () => true,
      createClient: async (params) =>
        makeFakeClient(
          params.callbacks,
          {
            cwd: params.cwd,
            allowedRoots: params.allowedRoots,
            includeDirectories: params.includeDirectories,
          },
          clients,
        ),
      onSessionsChanged: (next) => {
        sessions = next;
      },
      onReport: () => {},
      currentModel: () => null,
      currentMainSessionId: () => "main-1",
      integrationMode: () => "merge",
      maxConcurrentSessions: () => 5,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    try {
      const spawned = manager.spawn({ title: "信任任务", task: "干活" });
      // 派发瞬间即标注完全信任（无需等 worktree 准备）。
      expect(spawned.isolation.kind).toBe("repo");
      expect(spawned.isolation.fullTrust).toBe(true);
      expect(spawned.isolation.note).toBe("完全信任（主仓工作区）");

      await waitFor(() => clients.length > 0);
      expect(clients[0]!.cwd).toBe(repoRoot);
      expect(clients[0]!.allowedRoots[0]).toBe(repoRoot);
      expect(clients[0]!.includeDirectories).toContain(repoRoot);

      const session = sessions.find((s) => s.id === spawned.id);
      expect(session?.isolation.kind).toBe("repo");
      expect(session?.isolation.fullTrust).toBe(true);
      expect(session?.isolation.branch).toBeUndefined();
      expect(superIsolationLabel(session!.isolation)).toBe("完全信任（主仓工作区）");
    } finally {
      await manager.dispose();
    }
  }, 8000);

  it("默认 fullTrust=false 时仍建 worktree（默认零变化）", async () => {
    const repoRoot = makeRepo();
    type SpawnInfo = { cwd: string; allowedRoots: string[]; includeDirectories: string[] };
    const clients: SpawnInfo[] = [];
    const manager = new SuperAgentManager({
      repoRoot,
      createClient: async (params) =>
        makeFakeClient(
          params.callbacks,
          {
            cwd: params.cwd,
            allowedRoots: params.allowedRoots,
            includeDirectories: params.includeDirectories,
          },
          clients,
        ),
      onSessionsChanged: () => {},
      onReport: () => {},
      currentModel: () => null,
      currentMainSessionId: () => "main-1",
      integrationMode: () => "merge",
      maxConcurrentSessions: () => 5,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    try {
      const spawned = manager.spawn({ title: "普通任务", task: "干活" });
      expect(spawned.isolation.fullTrust).toBeUndefined();
      await waitFor(() => clients.length > 0);
      expect(clients[0]!.cwd).not.toBe(repoRoot);
      expect(clients[0]!.allowedRoots).toEqual([clients[0]!.cwd]);
    } finally {
      await manager.dispose();
    }
  }, 8000);
});

describe("super agent · 完全信任子会话不被当作合并子会话（回归）", () => {
  it("护栏：同一 repo 档里只有 mergeChild 受合并边界约束", () => {
    const trustCtx = { cwd: "/work", repoRoot: "/work", repoWorkspace: true };
    // 完全信任任务书允许 push / 合并：这些不能再被当成「越过合并边界」。
    for (const command of ["git push origin main", "git rebase origin/main", "git stash"]) {
      const verdict = classifyChildShellCommand(command, trustCtx);
      expect(verdict.decision).toBe("allow");
    }
    // 破坏性 git 依旧拦（丢的是用户未提交改动），文案不得谎称合并子会话。
    for (const command of ["git reset --hard", "git clean -fd", "git restore ."]) {
      const verdict = classifyChildShellCommand(command, trustCtx);
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toContain("MAIN repository workspace");
      expect(verdict.reason).not.toContain("merge child session");
      expect(verdict.reason).not.toContain("Finish the merge");
    }
    // 真合并子会话仍受硬边界约束。
    const mergeCtx = { ...trustCtx, mergeChild: true };
    for (const command of ["git push origin main", "git rebase origin/main", "git stash"]) {
      const verdict = classifyChildShellCommand(command, mergeCtx);
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toContain("merge-only boundary");
    }
    // 只读命令在两档都放行。
    for (const command of ["git status", "git diff", "git log --oneline -2", "git show HEAD"]) {
      expect(classifyChildShellCommand(command, trustCtx).decision).toBe("allow");
      expect(classifyChildShellCommand(command, mergeCtx).decision).toBe("allow");
    }
  });

  it("完全信任子会话在跑时仍能派发真合并子会话；第二个合并仍被拒", async () => {
    const repoRoot = makeRepo();
    let clientSpawned = false;
    let trustCallbacks: AcpClientCallbacks | null = null;
    const manager = new SuperAgentManager({
      repoRoot,
      fullTrust: () => true,
      createClient: async (params) => {
        clientSpawned = true;
        // 只记第一个（完全信任子会话）的回调：合并子会话的帧不在本用例范围。
        trustCallbacks ??= params.callbacks;
        return {
          callbacks: params.callbacks,
          async newSession() {
            return { sessionId: "sub" };
          },
          async setMode() {
            return {};
          },
          async setModel() {
            return {};
          },
          // 停在运行中：完全信任子会话始终是非终态，模拟它在跑。
          prompt() {
            return new Promise(() => {});
          },
          async cancel() {},
          async dispose() {
            params.callbacks.onExit?.(0, null);
          },
        } as unknown as AcpClient;
      },
      onSessionsChanged: () => {},
      onReport: () => {},
      currentModel: () => null,
      currentMainSessionId: () => "main-1",
      integrationMode: () => "manual",
      maxConcurrentSessions: () => 5,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      const trust = manager.spawn({ title: "信任任务", task: "干活" });
      expect(trust.isolation.kind).toBe("repo");
      expect(trust.isolation.fullTrust).toBe(true);
      await waitFor(() => clientSpawned);
      // 完全信任子会话在跑，但它不是合并子会话。
      expect(manager.hasRunningMergeChild()).toBe(false);

      // 核心回归：完全信任子会话执行 `git push` 不能被当成「越过合并边界」
      // 终止整个会话（旧的 repo 档判定会在这里把它打成 failed）。
      trustCallbacks!.onSessionUpdate?.({
        sessionId: "sub",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          toolName: "run_shell_command",
          kind: "execute",
          status: "in_progress",
          title: "git push origin main",
          args: { command: "git push origin main" },
        },
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const trustLive = manager.get(trust.id);
      expect(trustLive?.status).not.toBe("failed");
      expect(trustLive?.error).toBeUndefined();

      const source: SuperSessionUi = {
        id: "src-1",
        title: "改登录",
        task: "干活",
        status: "completed",
        isolation: {
          kind: "git_worktree",
          path: "/tmp/wt",
          branch: "iflow/super/fix-login-abcd1234",
          baseRef: "abc",
        },
        createdAt: 1,
        updatedAt: 2,
        reports: [],
      };
      const merge = await manager.spawnMerge({
        source,
        task: "合并任务",
        title: "合并分支 iflow/super/fix-login-abcd1234",
      });
      // 旧口径（任何 repo 档都算合并子会话）会在这里返回 null。
      expect(merge).not.toBeNull();
      expect(merge!.isolation.kind).toBe("repo");
      expect(merge!.isolation.fullTrust).toBeUndefined();
      expect(manager.hasRunningMergeChild()).toBe(true);

      // 真合并子会话在跑 → 同一工作区不能再派第二个。
      const second = await manager.spawnMerge({
        source,
        task: "合并任务",
        title: "合并分支 iflow/super/fix-login-abcd1234",
      });
      expect(second).toBeNull();
    } finally {
      await manager.dispose();
    }
  }, 15000);
});