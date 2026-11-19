/**
 * 面板侧的主会话注入（QQ 消息固定走主会话）。
 *
 * 这里不 spawn CLI：`sendPrompt` 被替换成假实现，只钉住注入这一层的语义 ——
 * 等空闲、传参正确（来源标记 / 气泡正文 / 静默忙）、只取本轮 assistant 文本、
 * 取消能立刻放手、真实 user 块带 origin 徽标。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type { QqMainInjectInput } from "../src/qq/service.js";
import type { QqTask } from "../shared/qq-task.js";
import type { QqTaskUi } from "../shared/messages.js";
import { beginUserPrompt } from "../shared/session-state.js";
import { initialSessionState } from "../shared/messages.js";
import { buildSuperReportPrompt } from "../shared/super-agent.js";
import type { SuperReport, SuperSessionUi } from "../shared/super-agent.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      (store.has(key) ? (store.get(key) as T) : defaultValue) as T,
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

type PanelInternals = {
  injectQqMainTurn: (input: QqMainInjectInput) => Promise<{
    injected: boolean;
    text?: string;
    stopReason?: string;
    failed?: boolean;
    reason?: string;
    canceled?: boolean;
    delegated?: boolean;
  }>;
  cancelQqMainInjection: (taskId: string) => boolean;
  sendPrompt: (...args: unknown[]) => Promise<boolean>;
  qqInjectedTaskId: string | null;
  qqMainQuestionIds: Map<string, string>;
  qqTaskBySuperSession: Map<string, string>;
  forwardQqMainTaskChildQuestion: (
    taskId: string,
    superSessionId: string,
    questions: readonly Record<string, unknown>[],
  ) => void;
  getSuperAgent: () => {
    list: () => Array<{ id: string; mainSessionId?: string | null; status: string }>;
  } | null;
  deliverQqMainFinalAnswer: (
    sessionId: string | null,
    text: string,
    stopReason: string,
    onlyTaskIds?: ReadonlySet<string>,
    fallbackText?: string,
  ) => Promise<void>;
  captureQqReportTurnText: (
    anchorId: string | undefined,
    beforeCount: number,
    anchorLen?: number,
  ) => string;
  drainSuperReports: () => Promise<void>;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: unknown,
  ) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  maybeAutoCompressOnIdle: (sessionId: string) => Promise<boolean>;
  pendingSuperReportPrompts: Array<{
    mainSessionId: string | null;
    text: string;
    final?: boolean;
    fallbackText?: string;
  }>;
  deliverQqMainIntermediateText: (
    owner: string | null,
    text: string,
    taskIds?: readonly string[],
  ) => Promise<void>;
  qqMainFinalAwaiters: Map<string, string>;
  qqMainFinalAwaiterSince: Map<string, number>;
  qqFinalRescueText: Map<string, string>;
  qqReportFallbackText: Map<string, string>;
  qqTaskFinalText: Map<string, string>;
  qqFinalRescueMs: number;
  qqFinalHardRescueMs: number;
  superReportRunning: boolean;
  superAgent: {
    list: () => Array<{ id: string; mainSessionId?: string | null; status: string }>;
    reportPromptWithPending?: (
      entries: Array<{ session: SuperSessionUi; report: SuperReport }>,
      options?: { pendingOwner?: string | null; finalOverride?: boolean },
    ) => { text: string; pendingCount: number };
  } | null;
  queueSuperReport: (entries: Array<{ session: SuperSessionUi; report: SuperReport }>) => void;
  qqDelegationGraceMs: number;
  rescueStaleQqFinalAwaiters: () => void;
  qq?: {
    service?: {
      forwardMainTaskQuestion?: (input: {
        taskId: string;
        questions: readonly Record<string, unknown>[];
      }) => Promise<void>;
      forwardMainTaskChildQuestion?: (input: {
        taskId: string;
        superSessionId: string;
        questions: readonly Record<string, unknown>[];
      }) => Promise<void>;
      clearQuestionWait?: (taskId: string) => void;
      completeMainFinalAnswer?: (input: {
        taskId: string;
        text: string;
        stopReason?: string;
      }) => Promise<void>;
      deliverMainTurnText?: (taskId: string, text: string) => Promise<void>;
    };
  };
  userQuestionsFromAgent: (req: {
    questions: Array<{
      header: string;
      question: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  }) => Promise<{ answers: Record<string, string | string[]> }>;
  answerQqMainQuestion: (taskId: string, answers: Record<string, string | string[]>) => boolean;
  handleQuestionAnswers: (id: string, answers: Record<string, string | string[]>) => void;
  store: {
    getState: () => {
      status: string;
      initializing: boolean;
      replaying: boolean;
      sessionId: string | null;
      blocks: Array<Record<string, unknown>>;
      stopReason: string | null;
      errorMessage: string | null;
    };
    userPrompt: (text: string, images?: string[], files?: unknown[], origin?: "qq") => number;
    onSessionUpdate: (notification: unknown) => void;
  };
};

const TASK: QqTask = {
  taskId: "T-main-1",
  idempotencyKey: "qqbot:m-main-1",
  source: { chatType: "private", chatId: "u1", senderId: "D754D2240C503C2ABE2B236DC1E78D11", msgId: "m-main-1" },
  target: { workspace: "/ws" },
  payload: { prompt: "把安装段改成内网镜像", attachments: [], contexts: [] },
  policy: { remotePolicy: "supervised", resultDetail: "standard" },
  status: "queued",
  channel: "main",
  createdAt: 1_000,
  updatedAt: 1_000,
  correlation: {},
};

interface InjectCall {
  text: string;
  displayText?: string;
  origin?: string;
  internal?: boolean;
  hidden?: boolean;
  quietBusy?: boolean;
  delegateOnBusy?: boolean;
  onTurnStarted?: () => void | Promise<void>;
}

function fakeSendPrompt(p: PanelInternals, calls: InjectCall[], behaviour: "start" | "reject" = "start") {
  return async (...args: unknown[]): Promise<boolean> => {
    const options = (args[4] ?? {}) as {
      origin?: string;
      displayText?: string;
      internal?: boolean;
      hidden?: boolean;
      quietBusy?: boolean;
      delegateOnBusy?: boolean;
      onTurnStarted?: () => void | Promise<void>;
    };
    calls.push({ text: String(args[0] ?? ""), ...options });
    if (behaviour === "reject") return false;
    p.store.userPrompt(
      options.displayText ?? String(args[0] ?? ""),
      undefined,
      undefined,
      options.origin === "qq" ? "qq" : undefined,
    );
    await options.onTurnStarted?.();
    // 模拟这一轮的 assistant 输出（思考块不算结果）。
    p.store.getState().blocks.push({ kind: "thought", text: "先想一想" });
    p.store.getState().blocks.push({ kind: "text", text: "已经改好了：安装段换成内网镜像" });
    p.store.getState().status = "idle";
    p.store.getState().stopReason = "end_turn";
    return true;
  };
}

describe("QQ 主会话注入（面板侧）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let iflowHome: string;

  beforeEach(async () => {
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-main-home-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-main-storage-"));
    setConfigOverrides({});
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    const state = p.store.getState();
    state.sessionId = "main-session";
    state.status = "idle";
    state.initializing = false;
    state.replaying = false;
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("空闲时立即注入：传来源标记与气泡正文，只取本轮 assistant 文本", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = fakeSendPrompt(p, calls);
    // 先放一段上一轮的 assistant 文本，确保结果不会把它算进来。
    p.store.getState().blocks.push({ kind: "text", text: "上一轮的回答" });

    const injected = vi.fn();
    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "[来自 QQ 用户 D754********8D11 的消息]\n\n把安装段改成内网镜像",
      displayText: "把安装段改成内网镜像",
      origin: "qq",
      onInjected: injected,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.origin).toBe("qq");
    expect(calls[0]!.displayText).toBe("把安装段改成内网镜像");
    expect(calls[0]!.internal).toBe(true);
    expect(calls[0]!.hidden).toBeUndefined(); // 必须是可见的用户气泡
    expect(calls[0]!.quietBusy).toBe(true);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(result.injected).toBe(true);
    expect(result.text).toBe("已经改好了：安装段换成内网镜像");
  });

  it("注入的 user 块带 origin=qq（转录徽标的数据来源）", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = fakeSendPrompt(p, calls);
    await p.injectQqMainTurn({
      task: TASK,
      text: "包裹后的正文",
      displayText: "对方发来的原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });
    const userBlock = p.store.getState().blocks.find((b) => b.kind === "user");
    expect(userBlock?.text).toBe("对方发来的原文");
    expect(userBlock?.origin).toBe("qq");
  });

  it("主会话忙时不注入；空闲后自动补上", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = fakeSendPrompt(p, calls);
    p.store.getState().status = "streaming";

    const pending = p.injectQqMainTurn({
      task: TASK,
      text: "包裹后的正文",
      displayText: "对方发来的原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 3_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toHaveLength(0);

    p.store.getState().status = "idle";
    const result = await pending;
    expect(calls).toHaveLength(1);
    expect(result.injected).toBe(true);
  });

  it("等待空闲时被取消：立即返回 canceled，且不发出任何一轮", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = fakeSendPrompt(p, calls);
    p.store.getState().status = "streaming";
    const controller = new AbortController();

    const pending = p.injectQqMainTurn({
      task: TASK,
      text: "包裹后的正文",
      displayText: "对方发来的原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(p.cancelQqMainInjection(TASK.taskId)).toBe(true);

    const result = await pending;
    expect(result.canceled).toBe(true);
    expect(calls).toHaveLength(0);
    // 取消后表项已清理：重复取消不再命中。
    expect(p.cancelQqMainInjection(TASK.taskId)).toBe(false);
  });

  it("sendPrompt 被别的回合抢走：回到等空闲重试，不把任务判失败", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = async (...args: unknown[]) => {
      calls.push({ text: String(args[0] ?? "") });
      // 第一次被抢（返回 false，未开始），第二次正常跑完。
      if (calls.length === 1) return false;
      const options = (args[4] ?? {}) as { onTurnStarted?: () => Promise<void> | void };
      await options.onTurnStarted?.();
      p.store.getState().blocks.push({ kind: "text", text: "第二次真的跑完了" });
      p.store.getState().status = "idle";
      return true;
    };

    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "包裹后的正文",
      displayText: "对方发来的原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 3_000,
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(result.injected).toBe(true);
    expect(result.text).toBe("第二次真的跑完了");
  });
});

// ---------------------------------------------------------------------------
// 转录块来源标记（shared reducer）
// ---------------------------------------------------------------------------

describe("beginUserPrompt 来源标记", () => {
  it("origin=qq 写进 user 块；缺省不写该键", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "外部消息", undefined, undefined, "qq");
    beginUserPrompt(state, "本地输入");
    const [external, local] = state.blocks;
    expect(external).toMatchObject({ kind: "user", text: "外部消息", origin: "qq" });
    expect(local).toMatchObject({ kind: "user", text: "本地输入" });
    expect((local as { origin?: string }).origin).toBeUndefined();
  });
});

// 类型层面：QqTaskUi.channel 必填，看板据此标注渠道。
void (null as unknown as QqTaskUi);

// ---------------------------------------------------------------------------
// F1：main 路由的 remotePolicy 闸门
// ---------------------------------------------------------------------------

describe("QQ 主会话注入 · remotePolicy 闸门（F1）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;

  beforeEach(async () => {
    process.env.IFLOW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-gate-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-gate-storage-"));
    setConfigOverrides({});
    panel = new ChatPanel(makeContext(dir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    const state = p.store.getState();
    state.sessionId = "main-session";
    state.status = "idle";
    state.initializing = false;
    state.replaying = false;
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
  });

  it("readonly 远程策略：main 渠道拒绝注入，不触碰主会话", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = fakeSendPrompt(p, calls);
    const readonlyTask: QqTask = {
      ...TASK,
      policy: { remotePolicy: "readonly", resultDetail: "standard" },
    };

    const result = await p.injectQqMainTurn({
      task: readonlyTask,
      text: "请改一下代码",
      displayText: "请改一下代码",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });

    expect(result.injected).toBe(false);
    expect(result.canceled).toBeUndefined();
    expect(result.reason).toContain("只读");
    expect(calls).toHaveLength(0);
  });

  it("trusted / supervised 仍可正常注入（闸门不误伤常规策略）", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = fakeSendPrompt(p, calls);
    for (const remotePolicy of ["trusted", "supervised"] as const) {
      const result = await p.injectQqMainTurn({
        task: { ...TASK, policy: { remotePolicy, resultDetail: "standard" } },
        text: "继续",
        displayText: "继续",
        origin: "qq",
        onInjected: () => undefined,
        signal: new AbortController().signal,
        timeoutMs: 2_000,
      });
      expect(result.injected).toBe(true);
    }
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F5：轮次锚定（sessionId + 稳定块 id）
// ---------------------------------------------------------------------------

describe("QQ 主会话注入 · 结果锚定（F5）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;

  beforeEach(async () => {
    process.env.IFLOW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-anchor-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-anchor-storage-"));
    setConfigOverrides({});
    panel = new ChatPanel(makeContext(dir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    const state = p.store.getState();
    state.sessionId = "main-session";
    state.status = "idle";
    state.initializing = false;
    state.replaying = false;
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
  });

  it("回合中会话被替换：判失败且绝不返回新会话的无关文本", async () => {
    p.sendPrompt = async (...args: unknown[]) => {
      const options = (args[4] ?? {}) as { onTurnStarted?: () => Promise<void> | void };
      await options.onTurnStarted?.();
      const state = p.store.getState();
      state.sessionId = "another-session";
      state.blocks.push({ kind: "text", text: "无关会话的回答" });
      state.status = "idle";
      return true;
    };

    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "原始任务",
      displayText: "原始任务",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });

    expect(result.injected).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.reason).toContain("会话");
    expect(result.text).toBe("");
  });

  it("基线统计与取结果同口径：system text 块不算基线也不算结果", async () => {
    p.store.getState().blocks.push({ kind: "text", text: "系统提示文本", system: true });
    p.sendPrompt = async (...args: unknown[]) => {
      const options = (args[4] ?? {}) as { onTurnStarted?: () => Promise<void> | void };
      await options.onTurnStarted?.();
      p.store.getState().blocks.push({ kind: "text", text: "本轮真正的回答" });
      p.store.getState().status = "idle";
      p.store.getState().stopReason = "end_turn";
      return true;
    };

    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "问题",
      displayText: "问题",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });

    expect(result.text).toBe("本轮真正的回答");
  });

  it("稳定块 id 锚定：基线锚块消失时判失败而非按数量误取", async () => {
    p.store.getState().blocks.push({ kind: "text", text: "带 id 的旧回答", id: "blk-old" });
    p.sendPrompt = async (...args: unknown[]) => {
      const options = (args[4] ?? {}) as { onTurnStarted?: () => Promise<void> | void };
      await options.onTurnStarted?.();
      const blocks = p.store.getState().blocks;
      // 模拟转录被清空/重排：锚块不在了，但数量还在。
      blocks.splice(0, blocks.length);
      blocks.push({ kind: "text", text: "不属于本轮的文本" });
      p.store.getState().status = "idle";
      return true;
    };

    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "问题",
      displayText: "问题",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });

    expect(result.injected).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 新功能：main 渠道 agent 提问 → QQ → 回答回灌 → agent 继续
// ---------------------------------------------------------------------------

describe("QQ 主渠道提问转发与回灌", () => {
  let panel: ChatPanel;
  let p: PanelInternals;

  beforeEach(async () => {
    process.env.IFLOW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-question-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-question-storage-"));
    setConfigOverrides({});
    panel = new ChatPanel(makeContext(dir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    p.store.getState().sessionId = "main-session";
    p.store.getState().status = "idle";
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
  });

  it("注入回合里的提问转发到 QQ（含选项/多选），回答后 agent 的提问 Promise 被 resolve", async () => {
    const forwardMain = vi.fn(async () => undefined);
    p.qq = { service: { forwardMainTaskQuestion: forwardMain } };
    p.qqInjectedTaskId = TASK.taskId;

    const pending = p.userQuestionsFromAgent({
      questions: [
        {
          header: "颜色",
          question: "选哪个颜色？",
          options: [{ label: "红色", description: "热情" }],
          multiSelect: true,
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(forwardMain).toHaveBeenCalledTimes(1);
    expect(forwardMain.mock.calls[0]![0]).toMatchObject({
      taskId: TASK.taskId,
    });
    expect(forwardMain.mock.calls[0]![0]!.questions[0]).toMatchObject({
      header: "颜色",
      question: "选哪个颜色？",
      multiSelect: true,
    });
    expect(p.qqMainQuestionIds.size).toBe(1);

    expect(p.answerQqMainQuestion(TASK.taskId, { 颜色: ["红色"] })).toBe(true);
    await expect(pending).resolves.toEqual({ answers: { 颜色: ["红色"] } });
    expect(p.qqMainQuestionIds.size).toBe(0);
    expect(p.store.getState().pendingQuestions).toBeNull();
  });

  it("本地回合的提问不转发，也不被 QQ 回答误答", async () => {
    const forwardMain = vi.fn(async () => undefined);
    p.qq = { service: { forwardMainTaskQuestion: forwardMain } };

    const local = p.userQuestionsFromAgent({ questions: [{ header: "确认", question: "继续吗？" }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(forwardMain).not.toHaveBeenCalled();

    // 即便随后出现一个 QQ 注入回合，本地卡也不在 qqMainQuestionIds 里。
    p.qqInjectedTaskId = TASK.taskId;
    expect(p.answerQqMainQuestion(TASK.taskId, { 确认: "是" })).toBe(false);
    expect(p.store.getState().pendingQuestions?.id).toBeDefined();
    // 收尾：本地作答让 promise settle，避免悬挂定时器。
    p.handleQuestionAnswers(p.store.getState().pendingQuestions!.id, { 确认: "是" });
    await expect(local).resolves.toEqual({ answers: { 确认: "是" } });
  });

  it("超时/停止的空答案按「未回答」回灌，agent 不被挂住", async () => {
    p.qq = { service: { forwardMainTaskQuestion: vi.fn(async () => undefined) } };
    p.qqInjectedTaskId = TASK.taskId;

    const pending = p.userQuestionsFromAgent({ questions: [{ header: "颜色", question: "选哪个？" }] });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(p.answerQqMainQuestion(TASK.taskId, {})).toBe(true);
    await expect(pending).resolves.toEqual({ answers: {} });
  });

  it("本机先作答时撤销 QQ 侧等待槽位，避免二次回灌", async () => {
    const clearWait = vi.fn();
    p.qq = {
      service: {
        forwardMainTaskQuestion: vi.fn(async () => undefined),
        clearQuestionWait: clearWait,
      },
    };
    p.qqInjectedTaskId = TASK.taskId;

    const pending = p.userQuestionsFromAgent({ questions: [{ header: "颜色", question: "选哪个？" }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cardId = p.store.getState().pendingQuestions!.id;

    p.handleQuestionAnswers(cardId, { 颜色: "蓝色" });
    await expect(pending).resolves.toEqual({ answers: { 颜色: "蓝色" } });
    expect(clearWait).toHaveBeenCalledWith(TASK.taskId);
    // QQ 再来回答时已无可命中的卡。
    expect(p.answerQqMainQuestion(TASK.taskId, { 颜色: "红色" })).toBe(false);
  });

  it("回合结束后迟到的 QQ 回答仍能命中提问卡（不依赖实时 qqInjectedTaskId）", async () => {
    p.qq = { service: { forwardMainTaskQuestion: vi.fn(async () => undefined) } };
    p.qqInjectedTaskId = TASK.taskId;

    const pending = p.userQuestionsFromAgent({ questions: [{ header: "确认", question: "继续吗？" }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 模拟回合收尾：实时字段被清空，但卡还挂着（answer 走服务端口在稍后才到）。
    p.qqInjectedTaskId = null;

    expect(p.answerQqMainQuestion(TASK.taskId, { 确认: "是" })).toBe(true);
    await expect(pending).resolves.toEqual({ answers: { 确认: "是" } });
  });

  it("QQ 主任务派生的超流体提问转发到 QQ，并携带超流体 id 供回答回灌", async () => {
    const forwardChild = vi.fn(async () => undefined);
    p.qq = { service: { forwardMainTaskChildQuestion: forwardChild } };
    // 派发子会话时登记的归属映射：子会话 super-1 属于 QQ 主任务 TASK。
    p.qqTaskBySuperSession.set("super-1", TASK.taskId);

    p.forwardQqMainTaskChildQuestion(TASK.taskId, "super-1", [
      { header: "颜色", question: "选哪个颜色？", options: [{ label: "红", description: "热情" }] },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(forwardChild).toHaveBeenCalledTimes(1);
    expect(forwardChild.mock.calls[0]![0]).toMatchObject({
      taskId: TASK.taskId,
      superSessionId: "super-1",
    });
    expect(forwardChild.mock.calls[0]![0]!.questions[0]).toMatchObject({
      header: "颜色",
      question: "选哪个颜色？",
    });
  });
});

// ---------------------------------------------------------------------------
// 最终回执：注入轮只回占位，汇报汇总轮回传真正答复
// ---------------------------------------------------------------------------

describe("QQ 注入轮与最终答复轮的衔接", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let iflowHome: string;

  beforeEach(async () => {
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-final-home-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-final-storage-"));
    setConfigOverrides({});
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    const state = p.store.getState();
    state.sessionId = "main-session";
    state.status = "idle";
    state.initializing = false;
    state.replaying = false;
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("注入轮派生了超流体：回 delegated=true 并登记等最终答复，占位文本不当最终回执", async () => {
    const children: Array<{ id: string; mainSessionId?: string | null; status: string }> = [];
    p.getSuperAgent = () => ({ list: () => children });
    p.sendPrompt = async (...args: unknown[]) => {
      const options = args[4] as { onTurnStarted?: () => Promise<void> | void };
      p.store.userPrompt("原文");
      await options.onTurnStarted?.();
      // 主 Agent 在注入轮里派出了子会话（基线之后才出现）。
      children.push({ id: "child-1", mainSessionId: "main-session", status: "running" });
      p.store.getState().blocks.push({ kind: "text", text: "已派超流体去做" });
      p.store.getState().status = "idle";
      return true;
    };

    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "包裹正文",
      displayText: "原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });

    expect(result.injected).toBe(true);
    expect(result.text).toBe("已派超流体去做");
    expect(result.delegated).toBe(true);
    expect(p.qqMainFinalAwaiters.get(TASK.taskId)).toBe("main-session");
  });

  it("超流体登记晚于回合收尾一拍时，宽限期内仍判 delegated，awaiter 不被提前摘除（R3）", async () => {
    const children: Array<{ id: string; mainSessionId?: string | null; status: string }> = [];
    p.getSuperAgent = () => ({ list: () => children });
    p.qqDelegationGraceMs = 80;
    p.sendPrompt = async (...args: unknown[]) => {
      const options = args[4] as { onTurnStarted?: () => Promise<void> | void };
      p.store.userPrompt("原文");
      await options.onTurnStarted?.();
      p.store.getState().blocks.push({ kind: "text", text: "已派超流体去做" });
      p.store.getState().status = "idle";
      // 模拟子会话异步登记：回合结束后才出现在 list()（比收尾晚一拍）。
      setTimeout(() => {
        children.push({ id: "child-late", mainSessionId: "main-session", status: "running" });
      }, 20);
      return true;
    };

    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "包裹正文",
      displayText: "原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });

    expect(result.delegated).toBe(true);
    expect(p.qqMainFinalAwaiters.get(TASK.taskId)).toBe("main-session");
  });

  it("注入轮没有派生超流体：delegated 缺省，不登记等最终答复（兼容直答）", async () => {
    p.getSuperAgent = () => ({ list: () => [] });
    p.sendPrompt = fakeSendPrompt(p, []);
    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "包裹正文",
      displayText: "原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });

    expect(result.injected).toBe(true);
    expect(result.delegated).toBeUndefined();
    expect(p.qqMainFinalAwaiters.size).toBe(0);
  });

  it("汇总轮空正文仍回传如实兜底并摘除 awaiter（R1，不让 QQ 停在已受理）", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    p.qqMainFinalAwaiters.set(TASK.taskId, "main-session");
    p.qqMainFinalAwaiters.set("T-other", "other-session");

    await p.deliverQqMainFinalAnswer("main-session", "   ", "end_turn");

    // 空正文不再静默 return：如实兜底经 completeMainFinalAnswer（forceActive）送出，
    // 且记账被摘除，QQ 不会停在「已受理」。
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      taskId: TASK.taskId,
      text: "超流体任务已完成，但未产生可转发的正文摘要。",
      stopReason: "end_turn",
    });
    expect(p.qqMainFinalAwaiters.has(TASK.taskId)).toBe(false);
    // 别的会话的任务留着等它自己的汇总轮。
    expect(p.qqMainFinalAwaiters.get("T-other")).toBe("other-session");
  });

  it("最终答复按归属会话回传一次并摘除记账；别会话不误投", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    p.qqMainFinalAwaiters.set(TASK.taskId, "main-session");
    p.qqMainFinalAwaiters.set("T-other", "other-session");

    // 汇总轮真正答复：只回传归属本会话的任务，且摘除记账（不重复投递）。
    await p.deliverQqMainFinalAnswer("main-session", "真正的最终答复", "end_turn");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      taskId: TASK.taskId,
      text: "真正的最终答复",
      stopReason: "end_turn",
    });
    expect(p.qqMainFinalAwaiters.has(TASK.taskId)).toBe(false);
    // 别的会话的任务留着等它自己的汇总轮。
    expect(p.qqMainFinalAwaiters.get("T-other")).toBe("other-session");

    await p.deliverQqMainFinalAnswer("main-session", "再来的结论", "end_turn");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 回归：同会话多任务按 task 归属投递，杜绝「摘要相同、id 不同」重复卡
// ---------------------------------------------------------------------------

describe("QQ 最终答复按 task 归属投递（同会话多任务不串台）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let iflowHome: string;

  beforeEach(async () => {
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-attr-home-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-attr-storage-"));
    setConfigOverrides({});
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    const state = p.store.getState();
    state.sessionId = "main-session";
    state.status = "idle";
    state.initializing = false;
    state.replaying = false;
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("同会话两 task 各收自己那份结论，互不串台、不共享汇总文本", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    p.qqMainFinalAwaiters.set("T-A", "main-session");
    p.qqMainFinalAwaiters.set("T-B", "main-session");
    p.qqTaskFinalText.set("T-A", "任务A结论：登录跳转已修好");
    p.qqTaskFinalText.set("T-B", "任务B结论：镜像源已切换");

    // 一轮汇总结论不能广播给两个 task。
    await p.deliverQqMainFinalAnswer("main-session", "汇总结论：A 与 B 都完成了", "end_turn");

    expect(complete).toHaveBeenCalledTimes(2);
    const byTask = new Map(
      complete.mock.calls.map(([input]) => [input!.taskId, input!.text]),
    );
    expect(byTask.get("T-A")).toBe("任务A结论：登录跳转已修好");
    expect(byTask.get("T-B")).toBe("任务B结论：镜像源已切换");
    // 共享汇总文本绝不出现在任一份里（重复卡根因）。
    expect(byTask.get("T-A")).not.toContain("汇总结论");
    expect(byTask.get("T-B")).not.toContain("汇总结论");
    expect(p.qqMainFinalAwaiters.size).toBe(0);
    expect(p.qqTaskFinalText.size).toBe(0);
  });

  it("同会话中无归属的 awaiter 走如实兜底，不共享别人的结论", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    p.qqMainFinalAwaiters.set("T-A", "main-session");
    p.qqMainFinalAwaiters.set("T-B", "main-session");
    // 只有 A 有归属正文；B 派生子会话的汇报没被记账。
    p.qqTaskFinalText.set("T-A", "任务A结论：登录跳转已修好");

    await p.deliverQqMainFinalAnswer(
      "main-session",
      "汇总结论：A 与 B 都完成了",
      "end_turn",
      undefined,
      "B的子会话汇报正文",
    );

    const byTask = new Map(
      complete.mock.calls.map(([input]) => [input!.taskId, input!.text]),
    );
    expect(byTask.get("T-A")).toBe("任务A结论：登录跳转已修好");
    // B 拿如实兜底，既不共享 A 的结论，也不共享共享汇总/兜底正文。
    expect(byTask.get("T-B")).toBe("超流体任务已完成，但未产生可转发的正文摘要。");
    expect(byTask.get("T-B")).not.toContain("任务A结论");
    expect(byTask.get("T-B")).not.toContain("汇总结论");
    expect(byTask.get("T-B")).not.toContain("B的子会话汇报正文");
  });

  it("汇总轮投递后补发再命中同一 task 不重复投递", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    p.qqMainFinalAwaiters.set("T-A", "main-session");
    p.qqMainFinalAwaiters.set("T-B", "main-session");
    p.qqTaskFinalText.set("T-A", "任务A结论");
    p.qqTaskFinalText.set("T-B", "任务B结论");

    // 汇总轮：每 task 一次。
    await p.deliverQqMainFinalAnswer("main-session", "汇总结论", "end_turn");
    expect(complete).toHaveBeenCalledTimes(2);

    // 迟到补发精确命中 T-A：awaiter 已被汇总轮摘除，不应再投一次。
    await p.deliverQqMainFinalAnswer(
      "main-session",
      "补发结论",
      "end_turn",
      new Set(["T-A"]),
    );
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 新功能：主会话纯文本正文轮同步到 QQ（工具/思考等不同步）
// ---------------------------------------------------------------------------

describe("QQ 主会话中间正文轮同步", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let iflowHome: string;

  beforeEach(async () => {
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-turntext-home-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-turntext-storage-"));
    setConfigOverrides({});
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    const state = p.store.getState();
    state.sessionId = "main-session";
    state.status = "idle";
    state.initializing = false;
    state.replaying = false;
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("委派注入轮只把 assistant 纯文本正文转发一次，thought/tool 不进正文", async () => {
    const deliver = vi.fn(async () => undefined);
    p.qq = { service: { deliverMainTurnText: deliver } };
    const children: Array<{ id: string; mainSessionId?: string | null; status: string }> = [];
    p.getSuperAgent = () => ({ list: () => children });
    p.sendPrompt = async (...args: unknown[]) => {
      const options = args[4] as { onTurnStarted?: () => Promise<void> | void };
      p.store.userPrompt("原文");
      await options.onTurnStarted?.();
      children.push({ id: "child-1", mainSessionId: "main-session", status: "running" });
      const blocks = p.store.getState().blocks;
      blocks.push({ kind: "thought", text: "内部思考，不该转发" });
      blocks.push({ kind: "tool", toolName: "run_shell_command", text: "rm -rf" });
      blocks.push({ kind: "text", text: "我先看一下项目结构，已经拆成两个子任务" });
      p.store.getState().status = "idle";
      return true;
    };

    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "包裹正文",
      displayText: "原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });
    await tick();

    expect(result.delegated).toBe(true);
    expect(result.text).toBe("我先看一下项目结构，已经拆成两个子任务");
    // thought / tool 块都被过滤：只投这一段纯文本正文，且只投一次。
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      TASK.taskId,
      "我先看一下项目结构，已经拆成两个子任务",
    );
  });

  it("直答轮（未委派）不转发中间正文，避免与最终结果重复", async () => {
    const deliver = vi.fn(async () => undefined);
    p.qq = { service: { deliverMainTurnText: deliver } };
    p.getSuperAgent = () => ({ list: () => [] });
    p.sendPrompt = fakeSendPrompt(p, []);

    await p.injectQqMainTurn({
      task: TASK,
      text: "包裹正文",
      displayText: "原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });
    await tick();

    // 这一段正文马上由 finalizeMainTask 作为最终结果发出，这里绝不重复投递。
    expect(deliver).not.toHaveBeenCalled();
  });

  it("最终答复只走 completeMainFinalAnswer，不再经中间正文通道重复投递", async () => {
    const deliver = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { deliverMainTurnText: deliver, completeMainFinalAnswer: complete } };
    p.qqMainFinalAwaiters.set(TASK.taskId, "main-session");

    await p.deliverQqMainFinalAnswer("main-session", "真正的最终结论", "end_turn");
    await tick();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("中间正文只投归属会话的等待任务，别的会话不误投", async () => {
    const deliver = vi.fn(async () => undefined);
    p.qq = { service: { deliverMainTurnText: deliver } };
    p.qqMainFinalAwaiters.set(TASK.taskId, "main-session");
    p.qqMainFinalAwaiters.set("T-other", "other-session");

    await p.deliverQqMainIntermediateText("main-session", "进度正文");
    await tick();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(TASK.taskId, "进度正文");
  });
});

// ---------------------------------------------------------------------------
// 回归：汇总轮正文被流式并入锚块导致 QQ 转发出空摘要（2026-11-19）
// ---------------------------------------------------------------------------

describe("汇总轮正文锚点回归（QQ 空摘要 bug）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let iflowHome: string;
  let complete: ReturnType<typeof vi.fn>;

  const streamChunk = (text: string): void => {
    p.store.onSessionUpdate({
      sessionId: "main-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
  };

  /** 预置一个 injected 卡（挡住异步注入卡）+ 末尾 text 锚块，返回该锚块。 */
  const seedAnchor = (oldText: string): Record<string, unknown> => {
    p.store.getState().blocks.push({
      kind: "injected",
      notice: "上下文",
      items: [],
      tokens: 0,
      id: "b-test-injected",
    });
    p.store.getState().blocks.push({ kind: "text", text: oldText, id: "b-test-anchor" });
    const blocks = p.store.getState().blocks;
    return blocks[blocks.length - 1]!;
  };

  beforeEach(async () => {
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-anchor-home-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-anchor-storage-"));
    // 关掉回合末联网任务，避免 fire-and-forget 的真实网关调用。
    setConfigOverrides({ checkpoints: false, autoTitle: false, autoMemoryCapture: false });
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    const state = p.store.getState();
    state.sessionId = "main-session";
    state.status = "idle";
    state.initializing = false;
    state.replaying = false;

    complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete as never } };
    p.qqMainFinalAwaiters.set(TASK.taskId, "main-session");

    // 让真实 sendPrompt 跑完整条收尾链（锚点提取 + 回执），但不 spawn CLI。
    const fakeClient = {};
    p.ensureClient = async () => fakeClient;
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.maybeAutoCompressOnIdle = async () => false;
    p.promptWithRetry = vi.fn(async () => ({ stopReason: "end_turn" }));
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("① 汇报正文被流式并入末尾 text 锚块时，汇总轮仍回真实正文而非兜底", async () => {
    const anchor = seedAnchor("上一轮旧正文");
    const anchorId = String(anchor["id"]);

    // 两个 chunk 都通过真实 session/update 流进来 —— appendTextToLast 会把它们
    // 就地并入锚块、复用同一个 id（这正是 bug 触发条件：hidden 回合无 user 块边界）。
    p.promptWithRetry = vi.fn(async () => {
      streamChunk("子会话A已完成：修复了空摘要 bug；");
      streamChunk("验证：定向测试 3 个文件全绿。");
      return { stopReason: "end_turn" };
    });

    const started = await p.sendPrompt("汇报提示", undefined, undefined, undefined, {
      hidden: true,
      reportTurn: true,
      finalReport: true,
    });
    expect(started).toBe(true);
    await tick();

    const blocks = p.store.getState().blocks;
    const merged = blocks.find((block) => block["id"] === anchorId) as { text: string } | undefined;
    // 前提确认：新正文确实并入了锚块（否则这个测试没复现到 bug）。
    expect(merged?.text).toContain("子会话A已完成：修复了空摘要 bug；");
    expect(merged?.text).toContain("验证：定向测试 3 个文件全绿。");

    expect(complete).toHaveBeenCalledTimes(1);
    const sent = (complete.mock.calls[0]?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(sent).toContain("子会话A已完成：修复了空摘要 bug；");
    expect(sent).toContain("验证：定向测试 3 个文件全绿。");
    // 旧正文不能混进来，兜底文案更不该出现。
    expect(sent).not.toContain("上一轮旧正文");
    expect(sent).not.toContain("超流体任务已完成，但未产生可转发的正文摘要。");
  });

  it("② captureQqReportTurnText 按锚块旧长度切片取回并入的正文", async () => {
    const anchor = seedAnchor("旧正文");
    const anchorId = String(anchor["id"]);
    const anchorLen = String(anchor["text"]).length;

    streamChunk("本轮新增汇报正文");

    const captured = p.captureQqReportTurnText(anchorId, p.store.getState().blocks.length, anchorLen);
    expect(captured).toBe("本轮新增汇报正文");
    // 不传旧长度会把整块（含上一轮旧正文）都算进来 —— 正说明必须记录锚块长度。
    const noLen = p.captureQqReportTurnText(anchorId, p.store.getState().blocks.length);
    expect(noLen).toBe("旧正文本轮新增汇报正文");
  });

  it("③ 二次转述为空时用清洗后的 report.summary 兜底，不双重出现占位文案", async () => {
    const anchor = seedAnchor("上一轮旧正文");
    // 汇报正文含协议围栏 / 凭据 / 本机绝对路径 / 长 id，必须被清洗掉。
    const rawSummary =
      "子会话A：修复了 QQ 空摘要 bug，改了 shared/qq-access.ts。" +
      "```super-agent {\"tasks\":[]}``` " +
      "token=sk-abcdefgh12345678 日志 J:\\git\\proj\\out.log id=0123456789abcdef0123";
    p.pendingSuperReportPrompts.push({
      mainSessionId: "main-session",
      text: "汇报提示文本",
      final: true,
      fallbackText: rawSummary,
    });

    // 汇总轮二次转述为空：promptWithRetry 不 streams 任何文本。
    p.promptWithRetry = vi.fn(async () => ({ stopReason: "end_turn" }));

    await p.drainSuperReports();
    await tick();

    expect(complete).toHaveBeenCalledTimes(1);
    const sent = (complete.mock.calls[0]?.[0] as { text?: string } | undefined)?.text ?? "";
    // 真实汇报内容要到达 QQ。
    expect(sent).toContain("子会话A：修复了 QQ 空摘要 bug");
    expect(sent).toContain("shared/qq-access.ts");
    // 协议标记 / 凭据 / 本机路径 / 长 id 全部抹掉。
    expect(sent).not.toContain("super-agent");
    expect(sent).not.toContain("sk-abcdefgh12345678");
    expect(sent).not.toContain("J:\\git");
    expect(sent).not.toContain("0123456789abcdef0123");
    // 旧正文与占位文案都不该出现（服务侧也不会再补一条占位）。
    expect(sent).not.toContain("上一轮旧正文");
    expect(sent).not.toContain("超流体任务已完成，但未产生可转发的正文摘要。");
    expect(String(anchor["text"])).toBe("上一轮旧正文");
  });
});

// ---------------------------------------------------------------------------
// 回归：10 分钟硬上限补发抢跑（摘要变兜底 / 主会话最终汇报丢失）
// ---------------------------------------------------------------------------

describe("QQ 硬上限补发抢跑回归", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let iflowHome: string;

  const child = (overrides: Partial<SuperSessionUi> = {}): SuperSessionUi => ({
    id: "super-done",
    title: "修好登录跳转",
    task: "修好 src/auth.ts",
    status: "completed",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    mainSessionId: "main-session",
    ...overrides,
  });
  const REPORT: SuperReport = { state: "ready", summary: "登录跳转已修好", at: 2000 };

  beforeEach(async () => {
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-rescue-home-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-rescue-storage-"));
    setConfigOverrides({ checkpoints: false, autoTitle: false, autoMemoryCapture: false });
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    const state = p.store.getState();
    state.sessionId = "main-session";
    state.status = "idle";
    state.initializing = false;
    state.replaying = false;
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("补发缓存正文为空时用汇报兜底正文（第 5 参），不再只发占位文案", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete as never } };
    p.qqMainFinalAwaiters.set(TASK.taskId, "main-session");
    p.qqMainFinalAwaiterSince.set(TASK.taskId, Date.now() - 1_000_000);
    p.qqFinalHardRescueMs = 1;
    // qqFinalRescueText 故意不设 —— 正是抢跑时的空缓存现场。
    p.qqReportFallbackText.set("main-session", "子会话真实汇报：安装段已换成内网镜像并验证通过");

    p.rescueStaleQqFinalAwaiters();
    await tick();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      taskId: TASK.taskId,
      text: "子会话真实汇报：安装段已换成内网镜像并验证通过",
      stopReason: "end_turn",
    });
    expect(p.qqMainFinalAwaiters.has(TASK.taskId)).toBe(false);
  });

  it("finalOverride 仅覆盖轮生效：普通汇报轮仍压制最终正文", () => {
    const entries = [{ session: child(), report: REPORT }];

    // 非 QQ 普通轮（未传 finalOverride）：pendingCount>0 照旧压制最终汇报。
    const normal = buildSuperReportPrompt(entries, { pendingCount: 1 });
    expect(normal).toContain("1 other child session(s) are still running");
    expect(normal).toContain("do not give the user a final complete report yet");
    expect(normal).not.toContain("give the user one complete report");

    // QQ 迟到补发覆盖：同一 pendingCount 下解除压制，产出最终汇报指令。
    const overridden = buildSuperReportPrompt(entries, { pendingCount: 1, finalOverride: true });
    expect(overridden).not.toContain("do not give the user a final complete report yet");
    expect(overridden).toContain("give the user one complete report");
  });

  it("rescueDue+pendingCount>0 时面板透传 finalOverride=true，但**不**把该轮标为 final", () => {
    const done = child();
    let captured: { finalOverride?: boolean } | undefined;
    p.superAgent = {
      list: () => [done],
      reportPromptWithPending: (entries, options) => {
        captured = options;
        return {
          text: buildSuperReportPrompt(entries, {
            pendingCount: 1,
            finalOverride: options?.finalOverride,
          }),
          pendingCount: 1,
        };
      },
    };
    p.qqMainFinalAwaiters.set(TASK.taskId, "main-session");
    p.qqMainFinalAwaiterSince.set(TASK.taskId, Date.now() - 100_000);
    p.qqFinalRescueMs = 1;

    p.queueSuperReport([{ session: done, report: REPORT }]);

    // 提示词被放宽：模型这一轮就给结论（不再被 pendingCount 压制）。
    expect(captured?.finalOverride).toBe(true);
    const item = p.pendingSuperReportPrompts.find((i) => i.mainSessionId === "main-session");
    // 但这一轮**不是** final：等待过久 ≠ 定终局（2026-11-19 修复）。
    // 标成 final 会让 QQ 先收到一条空正文兜底（22 字占位）、任务被写成终态、
    // awaiter 被摘掉，随后迟到的真实长正文再也投不出去。
    expect(item?.final).toBe(false);
    expect(item?.text).toContain("give the user one complete report");
    expect(item?.text).not.toContain("do not give the user a final complete report yet");
    // awaiter 仍在：真·最终汇报轮（pendingCount=0）到达时才定终局。
    expect(p.qqMainFinalAwaiters.has(TASK.taskId)).toBe(true);
  });
});
