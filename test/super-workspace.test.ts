/**
 * 默认工作区回退（`iflow.superAgent.defaultWorkspace`）的纯决策 + 端到端降级。
 *
 * 目标语义：没有打开任何文件夹时**永远**有可用目录。优先级是
 *   打开的 workspaceFolder → 设置值 → 内置默认目录 `~/.iflow/workspace` → 拒绝。
 * 空值直接用内置默认；非法值（相对路径 / `~` / 普通文件）非阻断回退 + 警告；
 * 只有 mkdir / stat 真失败才拒绝，且 toast 带真实 errno / message。
 *
 * 前两组是 `shared/super-workspace.ts` 的纯逻辑（零 VSCode、零 I/O，内置默认
 * 目录由参数注入）；第三组用真实临时目录验证非 git 默认工作区仍走「仅目录隔离」；
 * 第四组验证宿主接线只有一个判空点、且各档返回与 toast 符合上述语义。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  isAbsoluteWorkspacePath,
  planSuperWorkspaceRoot,
  resolveSuperWorkspaceRoot,
  type SuperWorkspaceEnsure,
} from "../shared/super-workspace.js";
import { SuperAgentManager } from "../src/panel/super-agent.js";
import {
  SuperAgentHost,
  type SuperAgentHostCallbacks,
} from "../src/panel/super-agent-host.js";
import type { AcpClient } from "../src/acp/client.js";
import { DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS, type SuperSessionUi } from "../shared/super-agent.js";
import { setConfigOverrides } from "./vscode-stub.js";

// 只把 mkdir 做成可控的 vi.fn，默认透传真实实现。第 ⑥ 组用它注入一次真实的
// EACCES 错误，验证「只有真失败才拒绝」且 toast 带真实 errno/message；其余用例
// 全部走真实 fs，不被 mock 干扰。stat 保持真实实现（不存在的路径返回 ENOENT）。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (name: string) =>
    vi.fn((...args: unknown[]) => {
      const fn = actual[name] as (...a: unknown[]) => unknown;
      return fn(...args);
    });
  return { ...actual, mkdir: passthrough("mkdir") };
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** 纯决策用的内置默认目录占位符（不碰磁盘；真实创建在宿主接线组验证）。 */
const BUILTIN = "/builtin";

type EnsureOutcome = Parameters<SuperWorkspaceEnsure>[0] extends string
  ? Awaited<ReturnType<SuperWorkspaceEnsure>>
  : never;

/** 按路径返回预设结局；未登记的路径如实报「意外探测」（让漏探测变成失败）。 */
function fakeEnsure(map: Record<string, EnsureOutcome>): SuperWorkspaceEnsure {
  return async (candidate) =>
    map[candidate] ?? { kind: "error", error: new Error(`unexpected ensure(${candidate})`) };
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
  it("① 有 workspaceFolder → 用它，忽略设置值与内置默认目录", () => {
    expect(planSuperWorkspaceRoot(["/ws"], "relative/dir", BUILTIN)).toEqual({
      kind: "workspace",
      root: "/ws",
    });
  });

  it("空白工作区根被跳过（多根工作区里被删掉的那个）", () => {
    expect(planSuperWorkspaceRoot(["   ", "/ws2"], "/default", BUILTIN)).toEqual({
      kind: "workspace",
      root: "/ws2",
    });
  });

  it("② 无工作区 + 设置为空 / 纯空白 → 内置默认目录候选（无回退原因）", () => {
    for (const configured of ["", "   ", undefined]) {
      expect(planSuperWorkspaceRoot([], configured, BUILTIN)).toEqual({
        kind: "candidates",
        candidates: [{ path: BUILTIN, origin: "builtin" }],
      });
    }
  });

  it("④ 无工作区 + 相对路径 → 内置默认候选带 not-absolute 回退原因", () => {
    expect(planSuperWorkspaceRoot([], "relative/dir", BUILTIN)).toEqual({
      kind: "candidates",
      candidates: [
        {
          path: BUILTIN,
          origin: "builtin",
          fallback: { reason: "not-absolute", configured: "relative/dir" },
        },
      ],
    });
  });

  it("合法绝对路径 → 设置值优先，内置默认兜底", () => {
    expect(planSuperWorkspaceRoot([], "/configured", BUILTIN)).toEqual({
      kind: "candidates",
      candidates: [
        { path: "/configured", origin: "configured" },
        { path: BUILTIN, origin: "builtin" },
      ],
    });
  });
});

describe("resolveSuperWorkspaceRoot（纯决策 + 注入的异步 ensure）", () => {
  it("有工作区时零 I/O（既有行为逐字节不变）", async () => {
    let probed = 0;
    const ensure: SuperWorkspaceEnsure = async () => {
      probed += 1;
      return { kind: "directory" };
    };
    expect(await resolveSuperWorkspaceRoot(["/ws"], "/configured", BUILTIN, ensure)).toEqual({
      ok: true,
      root: "/ws",
      source: "workspace",
    });
    expect(probed).toBe(0);
  });

  it("② 无工作区 + 设置为空 → 用内置默认目录并成功", async () => {
    expect(
      await resolveSuperWorkspaceRoot([], "", BUILTIN, fakeEnsure({ [BUILTIN]: { kind: "directory" } })),
    ).toEqual({ ok: true, root: BUILTIN, source: "default-workspace" });
  });

  it("③ 合法但不存在的目录 → ensure 创建后使用（真实 mkdir 在宿主组验证）", async () => {
    expect(
      await resolveSuperWorkspaceRoot(
        [],
        "/configured",
        BUILTIN,
        fakeEnsure({ "/configured": { kind: "directory" } }),
      ),
    ).toEqual({ ok: true, root: "/configured", source: "default-workspace" });
  });

  it("④ 相对路径 → 非阻断回退内置默认 + not-absolute 回退原因", async () => {
    expect(
      await resolveSuperWorkspaceRoot([], "rel/dir", BUILTIN, fakeEnsure({ [BUILTIN]: { kind: "directory" } })),
    ).toEqual({
      ok: true,
      root: BUILTIN,
      source: "default-workspace",
      fallback: { reason: "not-absolute", configured: "rel/dir" },
    });
  });

  it("⑤ 普通文件 → 非阻断回退内置默认 + not-a-directory 回退原因", async () => {
    expect(
      await resolveSuperWorkspaceRoot(
        [],
        "/a/file.txt",
        BUILTIN,
        fakeEnsure({ "/a/file.txt": { kind: "file" }, [BUILTIN]: { kind: "directory" } }),
      ),
    ).toEqual({
      ok: true,
      root: BUILTIN,
      source: "default-workspace",
      fallback: { reason: "not-a-directory", configured: "/a/file.txt" },
    });
  });

  it("⑥ 设置值 mkdir 真失败但内置默认可用 → 仍非阻断回退（附底层错误）", async () => {
    const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    expect(
      await resolveSuperWorkspaceRoot(
        [],
        "/configured",
        BUILTIN,
        fakeEnsure({ "/configured": { kind: "error", error }, [BUILTIN]: { kind: "directory" } }),
      ),
    ).toEqual({
      ok: true,
      root: BUILTIN,
      source: "default-workspace",
      fallback: { reason: "unavailable", configured: "/configured", cause: error },
    });
  });

  it("⑥ 所有候选都真失败 → 才拒绝，并原样带回底层错误", async () => {
    const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    expect(
      await resolveSuperWorkspaceRoot([], "", BUILTIN, fakeEnsure({ [BUILTIN]: { kind: "error", error } })),
    ).toEqual({
      ok: false,
      reason: "directory-unavailable",
      path: BUILTIN,
      error,
    });
  });
});

describe("⑦ 默认工作区是非 git 目录 → 沿用既有目录隔离降级并如实标注", () => {
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
    logs: string[];
  }

  function makeHost(opts: { workspaceRoot?: string; logs?: string[] } = {}): HostHarness {
    const toasts: Toast[] = [];
    const logs = opts.logs ?? [];
    const spawn = vi.fn(() => ({ id: "child-1" }));
    const manager: { spawn: ReturnType<typeof vi.fn> } | null = { spawn };
    let host!: SuperAgentHost;
    const deps = {
      log: {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
      },
      getContext: () => ({}) as never,
      // 默认没有任何打开的工作区（services.workspaceRoot 缺省）。① 通过 opts 注入。
      getServices: () => ({ workspaceRoot: opts.workspaceRoot }) as { workspaceRoot?: string },
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
    return { host, spawn, toasts, logs };
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

  it("① 有工作区 → 立即同步派发，忽略设置与内置默认，无回退警告", () => {
    const ws = tempDir("iflow-ws-");
    setConfigOverrides({ "superAgent.defaultWorkspace": "relative/dir" });
    const h = makeHost({ workspaceRoot: ws });
    h.host.builtinDefaultWorkspace = path.join(tempDir("iflow-builtin-ignored-"), "never");

    const result = h.host.dispatchSuperTasks([[{ title: "有工作区", task: "干活" }]]);
    expect(result.managerAvailable).toBe(true);
    expect(result.deferred).toBeUndefined();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.host.superRepoRoot()).toBe(ws);
    expect(h.host.defaultWorkspaceRoot).toBeNull();
    expect(h.toasts.some((t) => t.message.includes("默认工作区设置无效"))).toBe(false);
  });

  it("② 无工作区 + 设置为空 → 用内置默认目录并成功派发，无拒绝 toast", async () => {
    const builtin = path.join(tempDir("iflow-builtin-empty-"), "workspace");
    setConfigOverrides({ "superAgent.defaultWorkspace": "" });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = builtin;

    const result = h.host.dispatchSuperTasks([[{ title: "空设置", task: "干活" }]]);
    expect(result.deferred).toBe(true);
    await waitFor(() => h.spawn.mock.calls.length === 1);
    expect(existsSync(builtin)).toBe(true);
    expect(h.host.superRepoRoot()).toBe(builtin);
    expect(h.toasts.some((t) => t.message.includes("无法派发") || t.message.includes("无法准备"))).toBe(false);
  });

  it("③ 合法但不存在的目录 → 自动 mkdir 后派发", async () => {
    const configured = path.join(tempDir("iflow-config-missing-"), "nested", "workspace");
    setConfigOverrides({ "superAgent.defaultWorkspace": configured });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = path.join(tempDir("iflow-builtin-cfg-"), "w");

    const result = h.host.dispatchSuperTasks([[{ title: "不存在目录", task: "干活" }]]);
    expect(result.deferred).toBe(true);
    await waitFor(() => h.spawn.mock.calls.length === 1);
    expect(existsSync(configured)).toBe(true);
    expect(h.host.superRepoRoot()).toBe(configured);
    expect(h.toasts.some((t) => t.message.includes("默认工作区设置无效"))).toBe(false);
  });

  it("④ 相对路径 → 回退默认 + 警告且派发成功", async () => {
    const builtin = path.join(tempDir("iflow-builtin-rel-"), "workspace");
    setConfigOverrides({ "superAgent.defaultWorkspace": "relative/dir" });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = builtin;

    h.host.dispatchSuperTasks([[{ title: "相对路径", task: "干活" }]]);
    await waitFor(() => h.spawn.mock.calls.length === 1);
    expect(h.host.superRepoRoot()).toBe(builtin);
    const warning = h.toasts.find((t) => t.level === "warning" && t.message.includes("默认工作区设置无效"));
    expect(warning?.message).toContain("不是绝对路径");
    expect(warning?.message).toContain(builtin);
  });

  it("⑤ 指向普通文件 → 回退默认 + 警告且派发成功", async () => {
    const filePath = path.join(tempDir("iflow-file-ws-"), "file.txt");
    writeFileSync(filePath, "x", "utf8");
    const builtin = path.join(tempDir("iflow-builtin-file-"), "workspace");
    setConfigOverrides({ "superAgent.defaultWorkspace": filePath });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = builtin;

    h.host.dispatchSuperTasks([[{ title: "普通文件", task: "干活" }]]);
    await waitFor(() => h.spawn.mock.calls.length === 1);
    expect(h.host.superRepoRoot()).toBe(builtin);
    const warning = h.toasts.find((t) => t.level === "warning" && t.message.includes("默认工作区设置无效"));
    expect(warning?.message).toContain("不是目录");
    expect(warning?.message).toContain(builtin);
  });

  it("⑥ mkdir 真失败 → 拒绝且 toast 含真实 errno/message，零 spawn", async () => {
    const builtin = path.join(tempDir("iflow-builtin-fail-"), "never");
    setConfigOverrides({ "superAgent.defaultWorkspace": "" });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = builtin;
    const error = Object.assign(new Error("EACCES: permission denied, mkdir 'never'"), {
      code: "EACCES",
      errno: -13,
      syscall: "mkdir",
      path: builtin,
    });
    // 下一次 mkdir（即内置默认目录的创建）抛错；stat 仍真实返回 ENOENT。
    vi.mocked(mkdir).mockRejectedValueOnce(error);

    const result = h.host.dispatchSuperTasks([[{ title: "真失败", task: "干活" }]]);
    expect(result.deferred).toBe(true);
    await waitFor(() => h.toasts.length > 0);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.host.superRepoRoot()).toBeNull();
    const message = h.toasts.at(-1)?.message ?? "";
    expect(message).toContain("无法准备超流体工作目录");
    expect(message).toContain("EACCES");
    expect(message).toContain("permission denied");
    expect(message).toContain("iflow.superAgent.defaultWorkspace");
  });

  // --- 激活期 prefetch：无工作区判断前置到 splash 对应的启动期 ---------------
  it("⓪ 激活期 prefetch 后首次派发同步命中（无 deferred），默认目录已建好", async () => {
    const builtin = path.join(tempDir("iflow-prefetch-hit-"), "workspace");
    setConfigOverrides({ "superAgent.defaultWorkspace": "" });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = builtin;

    await h.host.prefetchSuperWorkspace();

    expect(existsSync(builtin)).toBe(true);
    expect(h.host.superRepoRoot()).toBe(builtin);
    const result = h.host.dispatchSuperTasks([[{ title: "预热后", task: "干活" }]]);
    expect(result.deferred).toBeUndefined();
    expect(result.managerAvailable).toBe(true);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it("⓪ prefetch 静默解析的 fallback 原因在首次派发补发一次警告（既有语义不变）", () => {
    const builtin = path.join(tempDir("iflow-prefetch-fallback-"), "workspace");
    setConfigOverrides({ "superAgent.defaultWorkspace": "relative/dir" });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = builtin;

    // prefetch 阶段没有 webview：只记日志，不弹 toast。
    void h.host.prefetchSuperWorkspace();
    return waitFor(() => h.host.defaultWorkspaceRoot === builtin).then(() => {
      expect(h.toasts.length).toBe(0);
      h.host.dispatchSuperTasks([[{ title: "回退后", task: "干活" }]]);
      h.host.dispatchSuperTasks([[{ title: "再来一次", task: "干活" }]]);
      const warnings = h.toasts.filter(
        (t) => t.level === "warning" && t.message.includes("默认工作区设置无效"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain("不是绝对路径");
      expect(warnings[0]?.message).toContain(builtin);
    });
  });

  it("⓪ 无工作区 + create:true 会提前 mkdir（含嵌套路径）", async () => {
    const builtin = path.join(tempDir("iflow-prefetch-create-"), "nested", "workspace");
    setConfigOverrides({ "superAgent.defaultWorkspace": "" });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = builtin;
    expect(existsSync(builtin)).toBe(false);

    await h.host.prefetchSuperWorkspace();

    expect(existsSync(builtin)).toBe(true);
    expect(h.host.defaultWorkspaceRoot).toBe(builtin);
  });

  it("⓪ 有工作区时 prefetch 零 I/O、不建默认目录、不缓存默认根", async () => {
    const ws = tempDir("iflow-prefetch-ws-");
    const builtin = path.join(tempDir("iflow-prefetch-ignored-"), "never");
    setConfigOverrides({ "superAgent.defaultWorkspace": "" });
    const h = makeHost({ workspaceRoot: ws });
    h.host.builtinDefaultWorkspace = builtin;

    await h.host.prefetchSuperWorkspace();

    expect(vi.mocked(mkdir).mock.calls.filter(([p]) => String(p) === builtin)).toHaveLength(0);
    expect(existsSync(builtin)).toBe(false);
    expect(h.host.superRepoRoot()).toBe(ws);
    expect(h.host.defaultWorkspaceRoot).toBeNull();
  });

  it("⓪ prefetch 失败只记日志、不弹 toast（提示仍归派发入口）", async () => {
    const builtin = path.join(tempDir("iflow-prefetch-fail-"), "never");
    setConfigOverrides({ "superAgent.defaultWorkspace": "" });
    const logs: string[] = [];
    const h = makeHost({ logs });
    h.host.builtinDefaultWorkspace = builtin;
    const error = Object.assign(new Error("EACCES: permission denied, mkdir 'never'"), {
      code: "EACCES",
      errno: -13,
      syscall: "mkdir",
      path: builtin,
    });
    vi.mocked(mkdir).mockRejectedValueOnce(error);

    await expect(h.host.prefetchSuperWorkspace()).resolves.toBeUndefined();

    expect(h.toasts.length).toBe(0);
    expect(existsSync(builtin)).toBe(false);
    expect(logs.some((m) => m.includes("预热失败"))).toBe(true);
    // 真实拒绝提示仍由 ensureSuperAgentForDispatch 入口给出（用例 ⑥ 已覆盖文案）。
  });

  it("⓪ prefetch 与派发并发：共享 in-flight，不重复解析 / 建目录 / 管理器", async () => {
    const builtin = path.join(tempDir("iflow-prefetch-concurrent-"), "workspace");
    setConfigOverrides({ "superAgent.defaultWorkspace": "" });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = builtin;
    const resolveSpy = vi.spyOn(h.host, "resolveSuperWorkspace");

    const prefetch = h.host.prefetchSuperWorkspace();
    const result = h.host.dispatchSuperTasks([[{ title: "并发", task: "干活" }]]);
    // prefetch 尚未 settle：派发只能同步返回 deferred，由后台链 join 同一解析。
    expect(result.deferred).toBe(true);
    await prefetch;
    await waitFor(() => h.spawn.mock.calls.length === 1);

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mkdir).mock.calls.filter(([p]) => String(p) === builtin)).toHaveLength(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.host.superRepoRoot()).toBe(builtin);
  });

  it("⓪ 恢复历史会话仍 create:false：不建目录、不缓存默认根、不弹 toast", async () => {
    const builtin = path.join(tempDir("iflow-restore-create-false-"), "never");
    setConfigOverrides({ "superAgent.defaultWorkspace": "" });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = builtin;
    const resolveSpy = vi.spyOn(h.host, "resolveSuperWorkspace");

    await h.host.resolveSuperWorkspace({ create: false });

    expect(resolveSpy).toHaveBeenCalledWith({ create: false });
    expect(existsSync(builtin)).toBe(false);
    expect(h.host.superRepoRoot()).toBeNull();
    expect(h.toasts.length).toBe(0);
  });

  it("⓪ 配置在运行中改动 → prefetch 结果失效，下次派发重新解析新根", async () => {
    const first = path.join(tempDir("iflow-cfg-first-"), "workspace");
    const second = path.join(tempDir("iflow-cfg-second-"), "workspace");
    setConfigOverrides({ "superAgent.defaultWorkspace": first });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = path.join(tempDir("iflow-cfg-builtin-"), "w");

    await h.host.prefetchSuperWorkspace();
    expect(h.host.superRepoRoot()).toBe(first);

    setConfigOverrides({ "superAgent.defaultWorkspace": second });
    h.host.invalidateDefaultWorkspace();
    expect(h.host.superRepoRoot()).toBeNull();

    const result = h.host.dispatchSuperTasks([[{ title: "换根后", task: "干活" }]]);
    expect(result.deferred).toBe(true);
    await waitFor(() => h.spawn.mock.calls.length === 1);
    expect(h.host.superRepoRoot()).toBe(second);
  });

  it("⓪ 有子会话在跑时改配置不换根（沿用 adoptDefaultWorkspaceRoot 约束）", async () => {
    const first = path.join(tempDir("iflow-cfg-busy-"), "workspace");
    setConfigOverrides({ "superAgent.defaultWorkspace": first });
    const h = makeHost();
    h.host.builtinDefaultWorkspace = path.join(tempDir("iflow-cfg-busy-builtin-"), "w");
    await h.host.prefetchSuperWorkspace();
    h.host.superAgent = { list: () => [{}], dispose: vi.fn(async () => []) } as never;

    setConfigOverrides({ "superAgent.defaultWorkspace": path.join(tempDir("iflow-cfg-other-"), "w") });
    h.host.invalidateDefaultWorkspace();

    expect(h.host.superRepoRoot()).toBe(first);
    expect(h.host.superAgent).not.toBeNull();
  });
});