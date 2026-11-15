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
import type { RequestPermissionRequest, RequestPermissionResponse } from "../src/acp/protocol.js";
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
  autoApproveSuperAgentTool: (req: RequestPermissionRequest) => RequestPermissionResponse | null;
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

  it("工具调用兜底不缓冲用户补投；真有补投时只投一次", async () => {
    const internals = p as unknown as {
      pendingDelegatedUserTurns: Array<{
        mainSessionId: string | null;
        text: string;
        images: unknown[];
        files: unknown[];
        droppedByChild: number;
      }>;
      drainDelegatedUserTurns: () => Promise<void>;
      currentMainSessionId: () => string | null;
    };
    // 结构化工具帧派发的是「模型指令」，不是 streaming 中的用户消息 —— 不进
    // 补投缓冲，也不会凭空开一个 hidden 回合。
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        args: { tasks: [{ title: "工具式派发", task: "把这件事做完" }] },
      }),
    });
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(internals.pendingDelegatedUserTurns).toHaveLength(0);
    await internals.drainDelegatedUserTurns();
    expect(p.sendPrompt).not.toHaveBeenCalled();

    // 真有一条被改道的用户消息时：只投一次，出队后不重复补投、不二次派发。
    internals.pendingDelegatedUserTurns.push({
      mainSessionId: internals.currentMainSessionId(),
      text: "生成中发出的消息",
      images: [],
      files: [],
      droppedByChild: 0,
    });
    await internals.drainDelegatedUserTurns();
    expect(p.sendPrompt).toHaveBeenCalledTimes(1);
    expect(p.sendPrompt).toHaveBeenCalledWith(
      expect.stringContaining("[补投用户消息]"),
      undefined,
      undefined,
      undefined,
      { delegateOnBusy: false, hidden: true },
    );
    expect(internals.pendingDelegatedUserTurns).toHaveLength(0);
    await internals.drainDelegatedUserTurns();
    expect(p.sendPrompt).toHaveBeenCalledTimes(1);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
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

  // --- 内置工具权限请求：直接放行、不弹审批卡 -------------------------------

  function permissionRequest(over: {
    toolName?: string;
    title?: string;
    options?: RequestPermissionRequest["options"];
  } = {}): RequestPermissionRequest {
    return {
      sessionId: "tool-session",
      toolCall: {
        toolCallId: "tc-perm",
        toolName: over.toolName ?? "super-agent",
        title: over.title ?? "",
        kind: "other",
        locations: [],
      },
      options: over.options ?? [
        { optionId: "allow-always", name: "Always", kind: "allow_always" },
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    };
  }

  it("dispatch / actions 内置工具直接允许，优先 allow_always", () => {
    expect(p.autoApproveSuperAgentTool(permissionRequest())).toEqual({
      outcome: { outcome: "selected", optionId: "allow-always" },
    });
    expect(
      p.autoApproveSuperAgentTool(permissionRequest({ toolName: "iflow__super-agent-actions" })),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
  });

  it("没有 allow_always 时回退到任一 allow 项；toolName 为空时用 title", () => {
    const response = p.autoApproveSuperAgentTool(
      permissionRequest({
        toolName: "",
        title: "super-agent",
        options: [
          { optionId: "reject", name: "Reject", kind: "reject_once" },
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        ],
      }),
    );
    expect(response).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  it("没有允许项时按取消路径返回 cancelled（绝不伪造 optionId）", () => {
    const response = p.autoApproveSuperAgentTool(
      permissionRequest({
        options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
      }),
    );
    expect(response).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("其它工具不自动放行（返回 null，继续走规则表 / 审批卡）", () => {
    expect(
      p.autoApproveSuperAgentTool(
        permissionRequest({ toolName: "run_shell_command", title: "echo hi" }),
      ),
    ).toBeNull();
    expect(
      p.autoApproveSuperAgentTool(permissionRequest({ toolName: "super-agent-guard" })),
    ).toBeNull();
  });
});
