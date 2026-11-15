/**
 * 结构化工具调用式派发 / 管理的宿主兜底（面板级）。
 *
 * 模型把 `super-agent` / `super-agent-actions` 写成**工具调用**时，内核
 * registry 里没有这两个工具。旧实现静默丢失（用户以为已经派了），这里钉住
 * 兜底行为：
 *
 *  - 名字命中 + 载荷可用 → 走与正文围栏完全相同的派发 / 动作链路；
 *  - 同一载荷的重复帧（pending → in_progress → completed）不重复派发；
 *  - 名字命中但载荷取不出来 → 只留痕（日志 + 一次 toast），绝不伪造派发。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { SessionState } from "../shared/messages.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
    update: () => Promise.resolve(),
    keys: () => [...store.keys()],
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [],
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    workspaceState: state,
    globalState: state,
    extensionUri: { fsPath: here },
    extensionPath: here,
    extensionMode: 3,
    logPath: here,
    storageUri: { fsPath: storageDir },
    globalStorageUri: { fsPath: storageDir },
    storagePath: storageDir,
    globalStoragePath: storageDir,
    asAbsolutePath: (p: string) => path.join(here, p),
  } as unknown as vscodeTypes.ExtensionContext;
}

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type ToolCallFrame = {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId: string;
  toolName?: string;
  title?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  args?: unknown;
};

type FakeManager = {
  spawn: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  list: () => never[];
  reportPrompt: () => string;
};

type PanelInternals = {
  superAgent: unknown;
  onSessionUpdate: (n: { sessionId: string; update: ToolCallFrame }) => void;
  sendPrompt: (...args: unknown[]) => Promise<boolean>;
  log: { lines: { level: string; message: string }[] };
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: SessionState) => void;
    sendToast: (
      level: "info" | "warning" | "error",
      message: string,
      opts?: unknown,
    ) => number;
  };
};

describe("Super Agent · 结构化工具调用兜底", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let manager: FakeManager;

  beforeEach(() => {
    // checkpoint 会拉真实 git 子进程；回合末跟进的网关调用也必须关掉。
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-supertool-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    manager = {
      spawn: vi.fn(() => ({ id: "super-tool-1" })),
      cancel: vi.fn(async () => ({ ok: true, reason: "cancelled" as const })),
      list: () => [],
      reportPrompt: () => "",
    };
    p.superAgent = manager;
    // 动作回执会以 hidden prompt 投回主会话；这里只关心动作本身，直接吞掉。
    p.sendPrompt = vi.fn(async () => true);
    p.store.sessionStarted({ sessionId: "tool-session" });
    p.store.replaceState({ ...p.store.getState(), status: "idle" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !predicate(); i += 1) await flush();
  }

  function frame(overrides: Partial<ToolCallFrame> = {}): ToolCallFrame {
    return {
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      toolName: "super-agent",
      status: "pending",
      ...overrides,
    };
  }

  it("派发工具帧：从 args 取载荷并 spawn 一次子会话", () => {
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        args: { tasks: [{ title: "工具式派发", task: "把这件事做完" }] },
      }),
    });

    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const spec = manager.spawn.mock.calls[0]?.[0] as { title: string; task: string };
    expect(spec.title).toBe("工具式派发");
    expect(spec.task).toBe("把这件事做完");
  });

  it("重复帧不重复 spawn：同载荷的 in_progress 更新与 completed 帧都跳过", () => {
    const args = { tasks: [{ title: "只派一次", task: "正文" }] };
    p.onSessionUpdate({ sessionId: "tool-session", update: frame({ args }) });
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    // 同一条工具帧的 in_progress 更新：载荷相同，去重键命中，不再 spawn。
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ sessionUpdate: "tool_call_update", status: "in_progress", args }),
    });
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    // 完成帧不再走兜底（只看 pending / in_progress）。
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ sessionUpdate: "tool_call_update", status: "completed", args }),
    });
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("管理动作工具帧：走取消链路", async () => {
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        toolName: "super-agent-actions",
        status: "in_progress",
        args: { actions: [{ action: "cancel", sessionId: "super-x" }] },
      }),
    });

    await waitFor(() => manager.cancel.mock.calls.length > 0);
    expect(manager.cancel).toHaveBeenCalledWith("super-x");
  });

  it("名字命中但 args 为空：只留痕（一次 toast + 日志），不 spawn", () => {
    const toast = vi.spyOn(p.store, "sendToast");
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ status: "in_progress" }),
    });

    expect(manager.spawn).not.toHaveBeenCalled();
    const warnings = toast.mock.calls.filter((call) => call[0] === "warning");
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[1])).toContain("super-agent");
    expect(String(warnings[0]?.[1])).toContain("未派发子会话");
    expect(p.log.lines.some((line) => line.level === "warn")).toBe(true);

    // 同一条工具帧的后续更新按 toolCallId 去重，不再重复弹提示。
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ sessionUpdate: "tool_call_update", status: "pending" }),
    });
    expect(toast.mock.calls.filter((call) => call[0] === "warning")).toHaveLength(1);
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("pending 帧不带 args 时不误报「未派发」，随后 in_progress 照常派发一次", () => {
    const toast = vi.spyOn(p.store, "sendToast");
    // wire 实证：args 只随 tool_call_update(in_progress) 到达，pending 帧没有 args。
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ status: "pending" }),
    });
    // 此时还没有载荷，不能弹「未派发子会话」—— 下一帧就会派发。
    expect(toast.mock.calls.filter((call) => call[0] === "warning")).toHaveLength(0);

    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        sessionUpdate: "tool_call_update",
        status: "in_progress",
        args: { tasks: [{ title: "后续帧派发", task: "正文" }] },
      }),
    });
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls.filter((call) => call[0] === "warning")).toHaveLength(0);
  });

  it("同一条 actions 工具帧 pending + in_progress 各带 args 时只执行一次", async () => {
    const args = { actions: [{ action: "cancel", sessionId: "super-x" }] };
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ toolName: "super-agent-actions", status: "pending", args }),
    });
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        sessionUpdate: "tool_call_update",
        toolName: "super-agent-actions",
        status: "in_progress",
        args,
      }),
    });
    await waitFor(() => manager.cancel.mock.calls.length > 0);
    // 同一 toolCallId 的重复帧不重复执行（cleanup/retry 的假失败、并发 worktree
    // 操作都由此避免）。
    expect(manager.cancel).toHaveBeenCalledTimes(1);

    // 另一次工具调用即使载荷相同也是模型的真实意图，必须各自执行。
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        toolCallId: "tc-2",
        toolName: "super-agent-actions",
        status: "in_progress",
        args,
      }),
    });
    await waitFor(() => manager.cancel.mock.calls.length > 1);
    expect(manager.cancel).toHaveBeenCalledTimes(2);
  });
});
