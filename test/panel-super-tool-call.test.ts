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
  /** 模拟「没有子会话管理器」时覆盖它（deps 每次调用都会重新读）。 */
  getSuperAgent: () => unknown;
  /** 结构化工具调用的终态账本（toolCallId → outcome）。 */
  superToolCallOutcomes: Map<string, string>;
  client: { setMode: ReturnType<typeof vi.fn> } | null;
  onSessionUpdate: (n: { sessionId: string; update: ToolCallFrame }) => void;
  sendPrompt: (...args: unknown[]) => Promise<boolean>;
  autoApproveSuperAgentTool: (req: RequestPermissionRequest) => RequestPermissionResponse | null;
  scanSuperDirectives: (content: unknown) => void;
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

  it("派发工具帧：从 args 取载荷并 spawn 一次超流体", () => {
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
        /** 多模态方案 C 起为必填（与 `images` 同下标的逐图说明）。 */
        imageCaptions: string[];
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
      // 多模态C 之后队列项必填 imageCaptions；生产 push 点始终写空数组或
      // 逐图说明，这里照同一形态构造，才真的走一遍补投链路。
      imageCaptions: [],
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

  it("没有子会话管理器时工具帧不记 dispatched（记 failed、零 spawn）", () => {
    const toast = vi.spyOn(p.store, "sendToast");
    // 模拟「没有打开的工作区 / 管理器不可用」：deps.getSuperAgent 返回 null。
    p.getSuperAgent = () => null;
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        toolCallId: "tc-no-manager",
        status: "in_progress",
        args: { tasks: [{ title: "无管理器", task: "正文" }] },
      }),
    });

    expect(manager.spawn).not.toHaveBeenCalled();
    // 假账回归：旧实现无论有没有 spawn 都写 dispatched。
    expect(p.superToolCallOutcomes.get("tc-no-manager")).toBe("failed");
    expect(p.superToolCallOutcomes.get("tc-no-manager")).not.toBe("dispatched");
    expect(
      toast.mock.calls.some(
        (call) => call[0] === "warning" && String(call[1]).includes("没有打开的工作区"),
      ),
    ).toBe(true);
  });

  it("重复载荷 dispatched===0：给一条可见提示 + 日志（不再静默返回）", () => {
    const args = { tasks: [{ title: "只派一次", task: "正文" }] };
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ toolCallId: "tc-first", args }),
    });
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    // 不同工具调用、同一份载荷：去重命中 → 零派发，但必须留可见痕迹。
    const toast = vi.spyOn(p.store, "sendToast");
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ toolCallId: "tc-second", args }),
    });

    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const infos = toast.mock.calls.filter((call) => call[0] === "info");
    expect(infos.some((call) => String(call[1]).includes("重复"))).toBe(true);
    expect(
      p.log.lines.some((line) => line.message.includes("already dispatched")),
    ).toBe(true);
    expect(p.superToolCallOutcomes.get("tc-second")).toBe("dispatched");
  });

  it("spawn 抛错：该帧记 failed、toast 可见，后续帧仍能派发", () => {
    manager.spawn.mockImplementationOnce(() => {
      throw new Error("boom-spawn");
    });
    const toast = vi.spyOn(p.store, "sendToast");

    expect(() =>
      p.onSessionUpdate({
        sessionId: "tool-session",
        update: frame({
          toolCallId: "tc-throw",
          args: { tasks: [{ title: "会炸", task: "正文" }] },
        }),
      }),
    ).not.toThrow();

    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(p.superToolCallOutcomes.get("tc-throw")).toBe("failed");
    expect(
      toast.mock.calls.some(
        (call) => call[0] === "warning" && String(call[1]).includes("boom-spawn"),
      ),
    ).toBe(true);
    expect(
      p.log.lines.some((line) => line.level === "error" && line.message.includes("spawn failed")),
    ).toBe(true);

    // 一帧异常不能吞掉整条流：后续工具帧照常派发。
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        toolCallId: "tc-after",
        args: { tasks: [{ title: "后续", task: "正文" }] },
      }),
    });
    expect(manager.spawn).toHaveBeenCalledTimes(2);
    expect(p.superToolCallOutcomes.get("tc-after")).toBe("dispatched");
  });

  it("缺 title 的结构性错误：纠错配额耗尽后仍留 toast + warn 日志", async () => {
    const toast = vi.spyOn(p.store, "sendToast");
    for (let i = 0; i < 3; i += 1) {
      p.onSessionUpdate({
        sessionId: "tool-session",
        update: frame({
          toolCallId: `tc-title-${i}`,
          status: "in_progress",
          args: { tasks: [{ task: "缺标题" }] },
        }),
      });
    }
    await flush();

    // 每次调用都有可见 toast（不被纠错配额压制）。
    const warnings = toast.mock.calls.filter((call) => call[0] === "warning");
    expect(warnings).toHaveLength(3);
    expect(warnings.every((call) => String(call[1]).includes("title 必填"))).toBe(true);

    // 第三次的 hidden prompt 被配额压制，但 warn 日志仍带原因（可诊断）。
    const warns = p.log.lines.filter((line) => line.level === "warn");
    expect(warns.some((line) => line.message.includes("title 必填"))).toBe(true);
    expect(
      warns.some((line) => line.message.includes("parameter-correction prompt suppressed")),
    ).toBe(true);
    expect(manager.spawn).not.toHaveBeenCalled();
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
    expect(manager.cancel).toHaveBeenCalledWith("super-x", "agent");
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
    expect(manager.cancel).toHaveBeenCalledWith("super-merged", "agent");
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
    expect(manager.cancel).toHaveBeenCalledWith("super-ns", "agent");
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("名字命中但整轮都没带 args：completed 帧留痕（一次 toast + 日志），不 spawn", () => {
    const toast = vi.spyOn(p.store, "sendToast");
    // in_progress 帧理论上应带 args；缺失时不立刻报（下一帧可能补），
    // 等 completed 帧仍没有载荷才下结论。
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ status: "in_progress" }),
    });
    expect(toast.mock.calls.filter((call) => call[0] === "warning")).toHaveLength(0);

    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ sessionUpdate: "tool_call_update", status: "completed" }),
    });

    expect(manager.spawn).not.toHaveBeenCalled();
    const warnings = toast.mock.calls.filter((call) => call[0] === "warning");
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[1])).toContain("派发指令没有送达");
    expect(String(warnings[0]?.[1])).toContain("未派出任何新任务");
    expect(String(warnings[0]?.[1])).not.toContain("super-agent");
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
    expect(String(warnings[0]?.[1])).toContain("派发指令格式有误");
    expect(String(warnings[0]?.[1])).toContain("task 必须是字符串");
    expect(String(warnings[0]?.[1])).toContain("未派出任何新任务");
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

  it("completed 帧仍无载荷：toast + 纠错提示（不再静默 accepted）", async () => {
    // 实测故障形态：pending / in_progress / completed 三帧都没带 args。
    // 工具层仍回 `Delegation request accepted.`，宿主却什么都没派。
    const toast = vi.spyOn(p.store, "sendToast");
    p.onSessionUpdate({ sessionId: "tool-session", update: frame({ status: "pending" }) });
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ sessionUpdate: "tool_call_update", status: "in_progress" }),
    });
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(toast.mock.calls.filter((call) => call[0] === "warning")).toHaveLength(0);

    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ sessionUpdate: "tool_call_update", status: "completed" }),
    });
    const warnings = toast.mock.calls.filter((call) => call[0] === "warning");
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[1])).toContain("派发指令没有送达");
    expect(manager.spawn).not.toHaveBeenCalled();
    // 模型也要知道：一条 hidden 纠错提示送回主会话。
    await waitFor(() => correctionPrompts().length > 0);
    expect(correctionPrompts()).toHaveLength(1);
    expect(String(p.log.lines.find((line) => line.level === "warn")?.message)).toContain(
      "NOTHING was dispatched",
    );

    // 同一条调用的重复 completed 帧不再弹第二条提示。
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ sessionUpdate: "tool_call_update", status: "completed" }),
    });
    expect(toast.mock.calls.filter((call) => call[0] === "warning")).toHaveLength(1);
  });

  it("completed 帧才带载荷：补派发一次，不误报「未派发」", () => {
    const toast = vi.spyOn(p.store, "sendToast");
    p.onSessionUpdate({ sessionId: "tool-session", update: frame({ status: "pending" }) });
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        sessionUpdate: "tool_call_update",
        status: "completed",
        args: { tasks: [{ title: "迟到载荷", task: "正文" }] },
      }),
    });
    // 工具层只回 ack，载荷晚到也比丢掉好：宿主在 completed 帧补处理。
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls.filter((call) => call[0] === "warning")).toHaveLength(0);
  });

  it("已派发后 completed 帧不弹「未派发」提示", () => {
    const toast = vi.spyOn(p.store, "sendToast");
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ args: { tasks: [{ title: "正常", task: "正文" }] } }),
    });
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({ sessionUpdate: "tool_call_update", status: "completed" }),
    });
    expect(toast.mock.calls.filter((call) => call[0] === "warning")).toHaveLength(0);
  });

  it("工具帧只带短标签标题（Delegate 1 task）也能识别并派发", () => {
    p.onSessionUpdate({
      sessionId: "tool-session",
      update: frame({
        toolName: undefined,
        title: "Delegate 1 task",
        status: "in_progress",
        args: { tasks: [{ title: "标题式派发", task: "正文" }] },
      }),
    });
    expect(manager.spawn).toHaveBeenCalledTimes(1);
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
    /** `null` = 彻底省略 toolName（CLI 智能审批的权限请求就不带它）。 */
    toolName?: string | null;
    title?: string;
    args?: unknown;
    options?: RequestPermissionRequest["options"];
  } = {}): RequestPermissionRequest {
    const toolName = over.toolName === undefined ? "super-agent" : over.toolName;
    return {
      sessionId: "tool-session",
      toolCall: {
        toolCallId: "tc-perm",
        ...(toolName ? { toolName } : {}),
        title: over.title ?? "",
        ...(over.args !== undefined ? { args: over.args } : {}),
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

  it("智能审批形态（无 toolName、标题 Delegate N task）直接放行，不落审批卡", () => {
    // CLI 0.5.19 智能审批 RISKY 分支构造 toolCall 只填
    // `title: getDescription(params)`，没有 toolName、也没有 args：
    // 派发是 `Delegate N task(s)`，管理是 `Manage N child session action(s)`。
    expect(
      p.autoApproveSuperAgentTool(permissionRequest({ toolName: null, title: "Delegate 1 task" })),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
    expect(
      p.autoApproveSuperAgentTool(permissionRequest({ toolName: null, title: "Delegate 3 tasks" })),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
    expect(
      p.autoApproveSuperAgentTool(
        permissionRequest({ toolName: null, title: "Manage 1 child session action" }),
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
    expect(
      p.autoApproveSuperAgentTool(
        permissionRequest({ toolName: null, title: "Manage 2 child session actions" }),
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
  });

  it("名字与标题都缺失时按真实载荷结构识别（tasks / actions）", () => {
    expect(
      p.autoApproveSuperAgentTool(
        permissionRequest({ toolName: null, args: { tasks: [{ task: "做点事" }] } }),
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
    expect(
      p.autoApproveSuperAgentTool(
        permissionRequest({
          toolName: null,
          args: { actions: [{ action: "cancel", sessionId: "super-1" }] },
        }),
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
  });

  it("载荷兜底不误放行：结构不匹配（或标题无关）的请求仍返回 null", () => {
    // 名字 / 标题都命不中，载荷也不像 super-agent → 必须继续走审批卡。
    expect(
      p.autoApproveSuperAgentTool(
        permissionRequest({ toolName: null, title: "Run shell command", args: { command: "dir" } }),
      ),
    ).toBeNull();
    // 结构相近但 action 名字不在协议枚举里 → 不认（避免把真实工具当派发放行）。
    expect(
      p.autoApproveSuperAgentTool(
        permissionRequest({
          toolName: null,
          args: { actions: [{ action: "delete", sessionId: "super-1" }] },
        }),
      ),
    ).toBeNull();
    // tasks 元素缺少非空 task 字符串 → 不认。
    expect(
      p.autoApproveSuperAgentTool(
        permissionRequest({ toolName: null, args: { tasks: [{ title: "缺 task" }] } }),
      ),
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
});
