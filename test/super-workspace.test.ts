/**
 * 默认工作区回退（`iflow.superAgent.defaultWorkspace`）的纯决策 + 端到端降级。
 *
 * 背景：没有打开任何文件夹时派发超流体是被正确拒绝的（确实没有工作区）。
 * 现在允许配置一个默认工作区作为回退 —— 判定必须只有一个来源，且每种失败
 * 都要给出真实原因，不能用一句「没有打开的工作区」盖住「路径不存在 / 不是
 * 目录 / 写的是相对路径」。
 *
 * 前四组是 `shared/super-workspace.ts` 的纯逻辑（零 VSCode、零 I/O）；
 * 最后一组用真实临时目录验证非 git 默认工作区沿用既有「仅目录隔离」降级，
 * 并在看板字段上如实标注。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  isAbsoluteWorkspacePath,
  planSuperWorkspaceRoot,
  resolveSuperWorkspaceRoot,
  type SuperWorkspaceProbe,
} from "../shared/super-workspace.js";
import { SuperAgentManager } from "../src/panel/super-agent.js";
import {
  SuperAgentHost,
  type SuperAgentHostCallbacks,
} from "../src/panel/super-agent-host.js";
import type { AcpClient } from "../src/acp/client.js";
import { DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS, type SuperSessionUi } from "../shared/super-agent.js";
import { setConfigOverrides } from "./vscode-stub.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** 只认「已登记为目录」的路径，其余一律 missing —— 不碰磁盘。 */
function fakeProbe(directories: readonly string[]): SuperWorkspaceProbe {
  const set = new Set(directories);
  return async (candidate) => (set.has(candidate) ? "directory" : "missing");
}

describe("isAbsoluteWorkspacePath", () => {
  it("接受盘符 / UNC / POSIX 绝对路径", () => {
    expect(isAbsoluteWorkspacePath("C:\\work\\app")).toBe(true);
    expect(isAbsoluteWorkspacePath("c:/work/app")).toBe(true);
    expect(isAbsoluteWorkspacePath("\\\\server\\share\\app")).toBe(true);
    expect(isAbsoluteWorkspacePath("/home/me/app")).toBe(true);
  });

  it("拒绝相对路径、~ 与裸目录名", () => {
    expect(isAbsoluteWorkspacePath("work/app")).toBe(false);
    expect(isAbsoluteWorkspacePath("./work")).toBe(false);
    expect(isAbsoluteWorkspacePath("~/work")).toBe(false);
    expect(isAbsoluteWorkspacePath("")).toBe(false);
  });
});

describe("planSuperWorkspaceRoot（纯决策）", () => {
  it("有工作区根就用它，忽略默认工作区设置", () => {
    expect(planSuperWorkspaceRoot(["/ws"], "/default")).toEqual({ kind: "workspace", root: "/ws" });
  });

  it("空白的工作区根被跳过（多根工作区里被删掉的那个）", () => {
    expect(planSuperWorkspaceRoot(["   ", "/ws2"], null)).toEqual({ kind: "workspace", root: "/ws2" });
  });

  it("没有工作区 + 合法默认工作区 → 待探测", () => {
    expect(planSuperWorkspaceRoot([], "/default")).toEqual({ kind: "default", path: "/default" });
  });

  it("没有工作区 + 设置为空 / 只有空白 → not-configured", () => {
    expect(planSuperWorkspaceRoot([], "")).toEqual({ kind: "reject", reason: "not-configured" });
    expect(planSuperWorkspaceRoot([], "   ")).toEqual({ kind: "reject", reason: "not-configured" });
    expect(planSuperWorkspaceRoot([], undefined)).toEqual({ kind: "reject", reason: "not-configured" });
  });

  it("没有工作区 + 非绝对路径 → not-absolute（带原始值回显）", () => {
    expect(planSuperWorkspaceRoot([], "relative/dir")).toEqual({
      kind: "reject",
      reason: "not-absolute",
      configured: "relative/dir",
    });
  });
});

describe("resolveSuperWorkspaceRoot（纯决策 + 注入探测）", () => {
  it("有工作区时不调用探测（既有行为零 I/O）", async () => {
    let probed = 0;
    const probe: SuperWorkspaceProbe = async () => {
      probed += 1;
      return "directory";
    };
    const resolution = await resolveSuperWorkspaceRoot(["/ws"], "/default", probe);
    expect(resolution).toEqual({ ok: true, root: "/ws", source: "workspace" });
    expect(probed).toBe(0);
  });

  it("无工作区 + 合法目录 → 用默认工作区", async () => {
    const resolution = await resolveSuperWorkspaceRoot([], "/default", fakeProbe(["/default"]));
    expect(resolution).toEqual({ ok: true, root: "/default", source: "default-workspace" });
  });

  it("无工作区 + 设置为空 → 拒绝，原因是 not-configured", async () => {
    const resolution = await resolveSuperWorkspaceRoot([], "", fakeProbe([]));
    expect(resolution).toEqual({ ok: false, reason: "not-configured" });
  });

  it("非绝对路径 / 不存在 / 是文件 → 各自真实原因", async () => {
    expect(await resolveSuperWorkspaceRoot([], "rel/dir", fakeProbe([]))).toEqual({
      ok: false,
      reason: "not-absolute",
      configured: "rel/dir",
    });
    expect(await resolveSuperWorkspaceRoot([], "/gone", fakeProbe([]))).toEqual({
      ok: false,
      reason: "not-found",
      configured: "/gone",
    });
    const probe: SuperWorkspaceProbe = async () => "file";
    expect(await resolveSuperWorkspaceRoot([], "/a/file.txt", probe)).toEqual({
      ok: false,
      reason: "not-a-directory",
      configured: "/a/file.txt",
    });
  });
});

describe("默认工作区是非 git 目录 → 沿用既有目录隔离降级并如实标注", () => {
  it("子会话隔离为 directory、note 说明非 git 仓库，且 cwd 落在默认工作区内", async () => {
    const dir = tempDir("iflow-default-ws-");
    const sessions: SuperSessionUi[] = [];
    let childCwd = "";
    const manager = new SuperAgentManager({
      repoRoot: dir,
      createClient: async (params) => {
        childCwd = params.cwd;
        return {
          mcpStatus: async () => ({ available: false, servers: {} }),
          newSession: async () => ({ sessionId: "s-1" }),
          setMode: async () => ({}),
          setModel: async () => ({}),
          prompt: async () => ({ stopReason: "end_turn" }),
          dispose: async () => undefined,
        } as unknown as AcpClient;
      },
      onSessionsChanged: (next) => {
        sessions.length = 0;
        sessions.push(...next);
      },
      onReport: () => {},
      onTranscript: () => {},
      currentModel: () => null,
      currentMainSessionId: () => "main-1",
      integrationMode: () => "manual",
      maxConcurrentSessions: () => DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    manager.spawn({ title: "默认工作区任务", task: "干活" });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && sessions[0]?.status !== "completed") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const session = sessions[0];
    expect(session?.status).toBe("completed");
    expect(session?.isolation.kind).toBe("directory");
    expect(session?.isolation.note).toContain("仅目录隔离");
    expect(session?.isolation.path.startsWith(dir)).toBe(true);
    // 子会话 cwd 就是降级目录（不是默认工作区根本身，但确实在其内）。
    expect(childCwd.startsWith(dir)).toBe(true);
    expect(session?.integration).toBeUndefined();
    await manager.dispose();
  }, 30_000);

  it("默认工作区是 git 仓库时仍走 worktree 隔离（分支独立）", async () => {
    const repo = tempDir("iflow-default-git-");
    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    };
    git("init");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    git("config", "core.autocrlf", "false");
    writeFileSync(path.join(repo, "a.txt"), "one\n", "utf8");
    git("add", "-A");
    git("commit", "-m", "init");

    const sessions: SuperSessionUi[] = [];
    const manager = new SuperAgentManager({
      repoRoot: repo,
      createClient: async () =>
        ({
          mcpStatus: async () => ({ available: false, servers: {} }),
          newSession: async () => ({ sessionId: "s-2" }),
          setMode: async () => ({}),
          setModel: async () => ({}),
          prompt: async () => ({ stopReason: "end_turn" }),
          dispose: async () => undefined,
        }) as unknown as AcpClient,
      onSessionsChanged: (next) => {
        sessions.length = 0;
        sessions.push(...next);
      },
      onReport: () => {},
      onTranscript: () => {},
      currentModel: () => null,
      currentMainSessionId: () => "main-1",
      integrationMode: () => "manual",
      maxConcurrentSessions: () => DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    manager.spawn({ title: "git 默认工作区", task: "干活" });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && sessions[0]?.status !== "completed") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(sessions[0]?.isolation.kind).toBe("git_worktree");
    expect(sessions[0]?.isolation.branch).toContain("iflow/super/");
    await manager.dispose();
  }, 40_000);
});

describe("宿主接线：默认工作区是唯一的派发判空点", () => {
  type Toast = { level: string; message: string };

  interface HostHarness {
    host: SuperAgentHost;
    spawn: ReturnType<typeof vi.fn>;
    toasts: Toast[];
    setManager(value: { spawn: ReturnType<typeof vi.fn> } | null): void;
  }

  function makeHost(): HostHarness {
    const toasts: Toast[] = [];
    const spawn = vi.fn(() => ({ id: "child-1" }));
    let manager: { spawn: ReturnType<typeof vi.fn> } | null = { spawn };
    let host!: SuperAgentHost;
    const deps = {
      log: { info: () => {}, warn: () => {}, error: () => {} },
      getContext: () => ({}) as never,
      // 关键：没有任何打开的工作区（services.workspaceRoot 为空、
      // vscode.workspace.workspaceFolders 在 stub 里也是 undefined）。
      getServices: () => ({}) as { workspaceRoot?: string },
      getStore: () =>
        ({
          getState: () => ({ sessionId: "main-1" }),
          sendToast: (level: string, message: string) => {
            toasts.push({ level, message });
            return 1;
          },
          setSuperSessions: () => {},
        }) as never,
      isDisposed: () => false,
      getQqHost: () => ({ qqInjectedTaskId: undefined }) as never,
      currentMainSessionId: () => "main-1",
      // 只按「宿主当前解析出的根」返回管理器：根为 null 就是「没有工作区」。
      getSuperAgent: () => (host.superRepoRoot() !== null ? manager : null),
      chunkText: () => "",
      postToWebview: () => {},
      refreshSuperWaitHeartbeat: () => {},
    } as unknown as SuperAgentHostCallbacks;
    host = new SuperAgentHost(deps);
    return {
      host,
      spawn,
      toasts,
      setManager: (value) => {
        manager = value;
      },
    };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("condition not met in time");
  }

  afterEach(() => setConfigOverrides({}));

  it("无工作区 + 合法默认目录 → 同步返回 deferred，随后真正派发并采用该目录", async () => {
    const dir = tempDir("iflow-host-default-");
    setConfigOverrides({ "superAgent.defaultWorkspace": dir });
    const harness = makeHost();

    const result = harness.host.dispatchSuperTasks([[{ title: "默认工作区任务", task: "干活" }]]);
    // 同步那一刻还没有管理器：如实返回「本次未派发」，而不是谎报成功。
    expect(result.deferred).toBe(true);
    expect(result.managerAvailable).toBe(false);

    await waitFor(() => harness.spawn.mock.calls.length === 1);
    expect(harness.host.superRepoRoot()).toBe(dir);
    expect(harness.spawn.mock.calls[0]?.[0]).toMatchObject({ title: "默认工作区任务" });
    // 成功路径不应弹拒绝 toast。
    expect(harness.toasts.some((t) => t.message.includes("无法派发"))).toBe(false);
  });

  it("无工作区 + 设置为空 → 拒绝，toast 指引去设置该键，零 spawn", async () => {
    setConfigOverrides({ "superAgent.defaultWorkspace": "" });
    const harness = makeHost();

    const result = harness.host.dispatchSuperTasks([[{ title: "x", task: "y" }]]);
    expect(result.deferred).toBe(true);
    await waitFor(() => harness.toasts.length > 0);

    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.host.superRepoRoot()).toBeNull();
    const message = harness.toasts.at(-1)?.message ?? "";
    expect(message).toContain("没有打开的工作区");
    expect(message).toContain("iflow.superAgent.defaultWorkspace");
  });

  it("相对路径 / 不存在 / 是文件 → toast 带各自真实原因", async () => {
    // 相对路径
    setConfigOverrides({ "superAgent.defaultWorkspace": "relative/dir" });
    const relative = makeHost();
    relative.host.dispatchSuperTasks([[{ title: "x", task: "y" }]]);
    await waitFor(() => relative.toasts.length > 0);
    expect(relative.toasts.at(-1)?.message).toContain("不是绝对路径");
    expect(relative.spawn).not.toHaveBeenCalled();

    // 不存在
    const missingPath = path.join(tempDir("iflow-missing-"), "nope");
    setConfigOverrides({ "superAgent.defaultWorkspace": missingPath });
    const missing = makeHost();
    missing.host.dispatchSuperTasks([[{ title: "x", task: "y" }]]);
    await waitFor(() => missing.toasts.length > 0);
    expect(missing.toasts.at(-1)?.message).toContain("不存在");
    expect(missing.spawn).not.toHaveBeenCalled();

    // 是文件不是目录
    const fileDir = tempDir("iflow-file-ws-");
    const filePath = path.join(fileDir, "file.txt");
    writeFileSync(filePath, "x", "utf8");
    setConfigOverrides({ "superAgent.defaultWorkspace": filePath });
    const file = makeHost();
    file.host.dispatchSuperTasks([[{ title: "x", task: "y" }]]);
    await waitFor(() => file.toasts.length > 0);
    expect(file.toasts.at(-1)?.message).toContain("不是目录");
    expect(file.spawn).not.toHaveBeenCalled();
  });
});
