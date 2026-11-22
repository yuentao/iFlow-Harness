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