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
  client: { setMode: ReturnType<typeof vi.fn> } | null;
  onSessionUpdate: (n: { sessionId: string; update: ToolCallFrame }) => void;
  sendPrompt: (...args: unknown[]) => Promise<boolean>;
  autoApproveSuperAgentTool: (req: RequestPermissionRequest) => RequestPermissionResponse | null;
  scanSuperDirectives: (content: unknown) => void;
  requestPlanExitFromUser: (req: {
    sessionId: string;
    plan: string;
  }) => Promise<{ approved: boolean }>;
  handlePlanExitResponse: (
    id: string,
    approved: boolean,
    reason?: string,
    replan?: boolean,
  ) => Promise<void>;
  persistPlanSpec: (plan: string) => Promise<string | null>;
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
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  it("super-agent 工具收到纯 actions 载荷：走动作链路，不派发、不 warn", async () => {
    // 用户实测：模型把管理动作塞进 super-agent 工具的 {"actions":[...]}，
    // 旧逻辑按派发解析 → 「工具参数未能完整解析」。合并载荷必须按动作执行。
    const toast = vi.spyOn(p.store, "sendToast");
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        toolName: "super-agent",
        status: "in_progress",
        args: { actions: [{ action: "cancel", sessionId: "super-merged" }] },
      }),
    });

    await waitFor(() => manager.cancel.mock.calls.length > 0);
    expect(manager.cancel).toHaveBeenCalledWith("super-merged");
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(toast.mock.calls.filter((call) => call[0] === "warning")).toHaveLength(0);
  });

  it("命名空间形态的 super-agent 工具收到 actions 载荷同样走动作链路", async () => {
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        toolName: "iflow__super-agent",
        status: "in_progress",
        args: { actions: [{ action: "cancel", sessionId: "super-ns" }] },
      }),
    });

    await waitFor(() => manager.cancel.mock.calls.length > 0);
    expect(manager.cancel).toHaveBeenCalledWith("super-ns");
    expect(manager.spawn).not.toHaveBeenCalled();
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
    expect(String(warnings[0]?.[1])).toContain("载荷不合法");
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

  it("畸形 tasks（字符串数组）：warning 含具体原因，零 spawn", () => {
    const toast = vi.spyOn(p.store, "sendToast");
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        status: "in_progress",
        // 实测形态：模型把 tasks[].task 写成字符串数组。
        args: { tasks: [["a", "b"]] },
      }),
    });

    expect(manager.spawn).not.toHaveBeenCalled();
    const warnings = toast.mock.calls.filter((call) => call[0] === "warning");
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[1])).toContain("载荷不合法");
    expect(String(warnings[0]?.[1])).toContain("task 必须是字符串");
    expect(String(warnings[0]?.[1])).toContain("未派发子会话");
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

  // --- 参数纠错闭环：工具层报错 + 宿主 hidden prompt 引导重派 -----------------

  /** 取出发给主会话的 super-agent 参数纠错提示（hidden prompt）。 */
  function correctionPrompts(): Array<{ text: string; options: Record<string, unknown> | undefined }> {
    const mock = p.sendPrompt as unknown as { mock: { calls: unknown[][] } };
    return mock.mock.calls
      .filter((call) => {
        const options = call[4] as Record<string, unknown> | undefined;
        return (
          options?.hidden === true &&
          typeof call[0] === "string" &&
          call[0].includes("[super-agent tool call rejected]")
        );
      })
      .map((call) => ({
        text: String(call[0]),
        options: call[4] as Record<string, unknown> | undefined,
      }));
  }

  it("畸形调用：入队一条 hidden 纠错提示（含原因与正确格式，不回贴畸形原文）", async () => {
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        status: "in_progress",
        args: { tasks: [{ title: "坏任务", task: 5 }] },
      }),
    });

    await waitFor(() => correctionPrompts().length > 0);
    const prompts = correctionPrompts();
    expect(prompts).toHaveLength(1);
    const text = prompts[0]!.text;
    // 正确格式示例（模型可直接照抄）。
    expect(text).toContain('{"tasks":[{"title":"short title","task":"self-contained brief"}]}');
    // 明确的修正指令 + 具体到字段的原因。
    expect(text).toContain("请修正后重新调用 super-agent");
    expect(text).toMatch(/task/);
    // 畸形原文绝不回贴（否则既费 token 又可能诱导模型照抄）。
    expect(text).not.toContain('"task":5');
    expect(text).not.toContain("坏任务");
    // 纠错回合禁止被派发成子会话（delegateOnBusy: false）。
    expect(prompts[0]!.options).toMatchObject({ hidden: true, delegateOnBusy: false });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("同一轮最多 2 条纠错提示：第 3 次畸形调用只留 toast，不再入队", async () => {
    for (let i = 0; i < 3; i += 1) {
      p.onSessionUpdate({
        sessionId: "tool-session",
        update: frame({
          toolCallId: `tc-bad-${i}`,
          status: "in_progress",
          args: { tasks: [{ task: 42 }] },
        }),
      });
    }

    await waitFor(() => correctionPrompts().length >= 2);
    await flush();
    expect(correctionPrompts()).toHaveLength(2);
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("正常派发不产生纠错提示", async () => {
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        status: "in_progress",
        args: { tasks: [{ title: "正常任务", task: "把这件事做完" }] },
      }),
    });

    await flush();
    await flush();
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(correctionPrompts()).toHaveLength(0);
  });

  // --- Plan 模式：只做计划，不派发 / 不管理 ---------------------------------

  const planModes = (
    currentModeId: "plan" | "default",
  ): NonNullable<SessionState["modes"]> => ({
    currentModeId,
    availableModes: [
      { id: "default", name: "Default", kind: "default" },
      { id: "plan", name: "Plan", kind: "plan" },
    ],
  });

  function setMode(currentModeId: "plan" | "default"): void {
    p.store.replaceState({ ...p.store.getState(), modes: planModes(currentModeId) });
  }

  const fence = (title: string, task: string): string =>
    ["```super-agent", JSON.stringify({ tasks: [{ title, task }] }), "```"].join("\n");

  it("Plan 模式下正文围栏不派发，提示可见；退出后同一载荷需重新下达才派发", () => {
    const toast = vi.spyOn(p.store, "sendToast");
    setMode("plan");

    p.scanSuperDirectives(fence("计划里的派发", "这不应该执行"));
    expect(manager.spawn).not.toHaveBeenCalled();
    const warnings = toast.mock.calls.filter((call) => call[0] === "warning");
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[1])).toContain("计划模式");
    expect(String(warnings[0]?.[1])).toContain("exit_plan_mode");

    // 退出计划模式不会触发自动补派：被拦下的载荷已被扫描器消费掉。
    setMode("default");
    expect(manager.spawn).not.toHaveBeenCalled();

    // 用户重新下达同一指令才派发（被拦下的载荷没有写进去重账本）。
    p.scanSuperDirectives(fence("计划里的派发", "这不应该执行"));
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("Plan 模式下 super-agent 工具调用不派发，提示可见；退出后同一载荷派发一次", () => {
    const toast = vi.spyOn(p.store, "sendToast");
    setMode("plan");
    const args = { tasks: [{ title: "计划里的工具派发", task: "这不应该执行" }] };

    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ sessionUpdate: "tool_call_update", status: "in_progress", args }),
    });
    expect(manager.spawn).not.toHaveBeenCalled();
    const warnings = toast.mock.calls.filter((call) => call[0] === "warning");
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[1])).toContain("计划模式");
    expect(String(warnings[0]?.[1])).toContain("exit_plan_mode");
    // 同一条工具帧的后续更新不重复提示。
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ sessionUpdate: "tool_call_update", status: "in_progress", args }),
    });
    expect(toast.mock.calls.filter((call) => call[0] === "warning")).toHaveLength(1);

    // 离开计划模式后，模型重新发起同载荷调用才派发。
    setMode("default");
    expect(manager.spawn).not.toHaveBeenCalled();
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        toolCallId: "tc-plan-2",
        sessionUpdate: "tool_call_update",
        status: "in_progress",
        args,
      }),
    });
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("Plan 模式下管理动作工具调用不执行，提示可见", async () => {
    const toast = vi.spyOn(p.store, "sendToast");
    setMode("plan");

    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        toolName: "super-agent-actions",
        sessionUpdate: "tool_call_update",
        status: "in_progress",
        args: { actions: [{ action: "cancel", sessionId: "super-x" }] },
      }),
    });

    await flush();
    expect(manager.cancel).not.toHaveBeenCalled();
    const warnings = toast.mock.calls.filter((call) => call[0] === "warning");
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[1])).toContain("计划模式");
    expect(String(warnings[0]?.[1])).toContain("管理操作");
  });

  it("modes 为 null（未上报 / 恢复中）不误判为 Plan 模式", () => {
    p.store.replaceState({ ...p.store.getState(), modes: null });

    p.scanSuperDirectives(fence("普通派发", "正常执行"));

    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("Plan 模式下 exit_plan_mode 仍能发起；批准离开后模式恢复且派发恢复", async () => {
    setMode("plan");
    const setModeMock = vi.fn(async (_sessionId: string, modeId: string) => ({
      success: true,
      currentModeId: modeId,
    }));
    p.client = { setMode: setModeMock } as unknown as PanelInternals["client"];
    // 批准会持久化 plan spec；测试里避免往工作区写文件。
    p.persistPlanSpec = async () => null;

    p.scanSuperDirectives(fence("审批前", "不派发"));
    expect(manager.spawn).not.toHaveBeenCalled();

    const exit = p.requestPlanExitFromUser({
      sessionId: "tool-session",
      plan: "1. 只做计划\n2. 需要执行时请求退出计划模式",
    });
    const id = p.store.getState().pendingPlanExit?.id;
    expect(id).toBeTruthy();

    // 等待审批期间仍是 Plan 模式：依旧不派发。
    p.scanSuperDirectives(fence("审批中", "不派发"));
    expect(manager.spawn).not.toHaveBeenCalled();

    await p.handlePlanExitResponse(id!, true);
    await expect(exit).resolves.toMatchObject({ approved: true });
    expect(setModeMock).toHaveBeenCalledWith("tool-session", "default");
    expect(p.store.getState().modes?.currentModeId).toBe("default");

    p.scanSuperDirectives(fence("审批后", "现在执行"));
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });
});
