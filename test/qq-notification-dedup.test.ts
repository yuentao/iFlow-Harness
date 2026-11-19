/**
 * 「系统通知回合重复转发到 QQ」回归（2026-11-19）。
 *
 * 缺陷：主会话一次子会话取消（interrupted 状态上报 + cancel 动作回执）会被
 * 宿主拆成多条 host-state 通知注入；面板把非汇总汇报回合的 assistant 正文当
 * 进度转发到 QQ，服务侧又只有「精确指纹去重」，措辞不同的近似转述全部漏过 ——
 * 用户一次取消连续收到三条内容相近的回复。
 *
 * 两道防线：
 *  ① 面板来源判别：宿主通知回合（[子会话状态上报] 非汇总轮）不再转发正文；
 *  ② 服务短窗相似去重：近似转述也不重复投递，但保留真实用户消息的合法回复。
 *
 * 本文件只钉住这两处，不碰入站 / 回填 / 双通道 / 占位升级等既有语义。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import {
  QqService,
  normalizeQqOutboundText,
  qqOutboundSimilarity,
  QQ_OUTBOUND_SIMILAR_THRESHOLD,
  type QqMainInjectInput,
  type QqMainInjectResult,
  type QqServiceHost,
} from "../src/qq/service.js";
import type {
  QqTaskEvent,
  QqTaskIndexEntry,
  QqTaskRecord,
  QqTaskStore,
} from "../src/qq/store.js";
import type { QqTask } from "../shared/qq-task.js";
import type { QqConfig } from "../src/qq/config.js";
import type { InboundMessage } from "../src/qq/adapter/types.js";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 纯函数：规范化与相似度
// ---------------------------------------------------------------------------

describe("QQ 出站短窗相似去重 — 纯函数", () => {
  it("规范化去掉 Markdown 标记 / 标点 / 空白，中文原样保留", () => {
    expect(normalizeQqOutboundText("我先看一下 `项目`，已经拆成 2 个子任务。\n")).toBe(
      "我先看一下项目已经拆成2个子任务",
    );
  });

  it("同一件事的两种转述相似度达到阈值，两条独立指令的答复低于阈值", () => {
    // 系统通知回合的典型形态：同一件事被主会话用两种相近措辞转述。
    const a = normalizeQqOutboundText("打包任务已经取消，已经另外派了一个新的打包任务去做");
    const b = normalizeQqOutboundText("打包任务已取消，已另外派了新的打包任务去做");
    const unrelated = normalizeQqOutboundText("登录跳转已修好并且跑通了全部测试");
    expect(qqOutboundSimilarity(a, b)).toBeGreaterThanOrEqual(QQ_OUTBOUND_SIMILAR_THRESHOLD);
    expect(qqOutboundSimilarity(a, unrelated)).toBeLessThan(QQ_OUTBOUND_SIMILAR_THRESHOLD);
    expect(qqOutboundSimilarity(a, a)).toBe(1);
    expect(qqOutboundSimilarity(a, "")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 服务夹具
// ---------------------------------------------------------------------------

class MemoryStore {
  readonly records = new Map<string, QqTask>();
  readonly events: QqTaskEvent[] = [];
  async saveTask(task: QqTaskRecord): Promise<void> {
    this.records.set(task.taskId, JSON.parse(JSON.stringify(task)) as QqTask);
  }
  async loadTask(taskId: string): Promise<QqTask | null> {
    const record = this.records.get(taskId);
    return record ? (JSON.parse(JSON.stringify(record)) as QqTask) : null;
  }
  async listTasks(): Promise<QqTaskIndexEntry[]> {
    return [...this.records.values()].map((task) => ({
      taskId: task.taskId,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      chatId: task.source.chatId,
      senderId: task.source.senderId,
    }));
  }
  async appendEvent(event: QqTaskEvent): Promise<void> {
    this.events.push(event);
  }
}

interface Delivered {
  chatType: "private" | "group";
  chatId: string;
  text: string;
  replyToMsgId?: string;
  dedupeKey?: string;
}

function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
  return {
    enabled: true,
    allowedUsers: ["u1"],
    allowedGroups: [],
    workspace: "/ws",
    remotePolicy: "supervised",
    maxConcurrentTasks: 2,
    rateLimitPerMin: 20,
    resultDetail: "standard",
    autoMerge: false,
    ...overrides,
  };
}

function makeServiceFixture(options: { monotonicNow?: () => number } = {}) {
  const store = new MemoryStore();
  const delivered: Delivered[] = [];
  const injections: Array<{
    input: QqMainInjectInput;
    resolve: (result: QqMainInjectResult) => void;
  }> = [];
  let clock = 0;
  const host: QqServiceHost = {
    workspaceRoots: () => ["/ws"],
    dispatchTask: async () => ({ superSessionId: "super-1", branch: "iflow/qq/test" }),
    cancelTask: async () => undefined,
    mergeTask: async () => ({ ok: true, detail: "已合并" }),
    discardTask: async () => ({}),
    readTaskOutcome: () => ({ summary: "完成", stopReason: "end_turn" }),
    deliver: async (msg) => {
      delivered.push({ ...msg });
      return { ok: true };
    },
    onPendingUser: () => undefined,
    unbindAccount: async () => ({ ok: true, message: "已解绑" }),
    notify: () => undefined,
    injectIntoMainSession: (input) =>
      new Promise<QqMainInjectResult>((resolve) => {
        injections.push({ input, resolve });
      }),
  };
  const service = new QqService({
    config: makeConfig(),
    store: store as unknown as QqTaskStore,
    host,
    newTaskChannel: "main",
    deliveryRetryDelayMs: 0,
    log: () => undefined,
    now: () => clock,
    ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : { monotonicNow: () => clock }),
  });
  return { service, store, delivered, injections, tick: (ms: number) => (clock += ms) };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatType: "private",
    chatId: "u1",
    senderId: "u1",
    msgId: "m1",
    text: "帮我打包",
    mentionsBot: false,
    attachments: [],
    timestamp: 0,
    ...overrides,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 走完入站 + 注入（delegated），让任务停在 injected 等最终答复。 */
async function injectedMainTask(f: ReturnType<typeof makeServiceFixture>): Promise<string> {
  await f.service.handleInboundMessage(inbound({ msgId: "m-main" }));
  await waitFor(() => f.injections.length === 1);
  await f.injections[0]!.input.onInjected();
  f.injections[0]!.resolve({
    injected: true,
    text: "已派超流体去做，先等一下",
    stopReason: "end_turn",
    delegated: true,
  });
  await waitFor(() => f.delivered.some((item) => item.text.includes("已受理，正在处理")));
  const summary = f.service.listTasks()[0];
  if (!summary) throw new Error("没有任务");
  return summary.taskId;
}

// ---------------------------------------------------------------------------
// 服务层：短窗相似去重
// ---------------------------------------------------------------------------

describe("QQ 出站 — 系统通知近似转述短窗去重", () => {
  it("同一任务短时间内高度相似的中间正文只发一条，窗口外的新正文仍可发", async () => {
    const f = makeServiceFixture();
    const taskId = await injectedMainTask(f);
    f.delivered.length = 0;

    await f.service.deliverMainTurnText(taskId, "打包任务已经取消，已经另外派了一个新的打包任务去做");
    expect(f.delivered.length).toBe(1);
    // 措辞略有不同但高度相似：被短窗相似去重挡住。
    await f.service.deliverMainTurnText(taskId, "打包任务已取消，已另外派了新的打包任务去做");
    expect(f.delivered.length).toBe(1);

    // 超过相似窗口 + 进度节流窗口后，真正不同的新进展仍要发出（不误杀合法后续进度）。
    f.tick(70_000);
    await f.service.deliverMainTurnText(taskId, "新的打包任务已经跑完，镜像推送成功");
    expect(f.delivered.length).toBe(2);
  });

  it("同一段正文即使措辞不同也不跨任务抑制（两个 QQ 用户互不干扰）", async () => {
    const f = makeServiceFixture();
    const taskId = await injectedMainTask(f);
    // 造第二条 main 渠道任务并注入。
    await f.service.handleInboundMessage(inbound({ msgId: "m-main-2", text: "再打个包" }));
    await waitFor(() => f.injections.length === 2);
    await f.injections[1]!.input.onInjected();
    f.injections[1]!.resolve({
      injected: true,
      text: "已派发",
      stopReason: "end_turn",
      delegated: true,
    });
    await waitFor(() => f.service.listTasks().length === 2);
    // 等第二条任务的「已受理」回执真正投递完再清空，避免异步回执混入计数。
    await waitFor(
      () => f.delivered.filter((item) => item.text.includes("已受理，正在处理")).length >= 2,
    );
    const other = f.service.listTasks().find((t) => t.taskId !== taskId);
    if (!other) throw new Error("没有第二个任务");
    f.delivered.length = 0;

    await f.service.deliverMainTurnText(taskId, "打包任务的取消已经确认生效");
    await f.service.deliverMainTurnText(other.taskId, "打包任务的取消已经确认生效");
    expect(f.delivered.length).toBe(2);
  });

  it("最终答复与近期中间正文高度相似时只落盘收尾、不重复投递", async () => {
    const f = makeServiceFixture();
    const taskId = await injectedMainTask(f);
    f.delivered.length = 0;

    await f.service.deliverMainTurnText(taskId, "打包任务已经取消，已经另外派了一个新的打包任务去做");
    expect(f.delivered.length).toBe(1);
    await f.service.completeMainFinalAnswer({
      taskId,
      text: "打包任务已取消，已另外派了新的打包任务去做",
      stopReason: "end_turn",
    });
    // 相似：不再投第二条；任务仍照常收尾为终态。
    expect(f.delivered.length).toBe(1);
    expect(f.service.getTask(taskId)?.status).toBe("succeeded");
    expect(f.store.events.some((e) => e.type === "task_answer_deduped")).toBe(true);
  });

  it("真实用户消息触发的独立答复仍正常投递（未被去重误杀）", async () => {
    const f = makeServiceFixture();
    const taskId = await injectedMainTask(f);
    f.delivered.length = 0;

    await f.service.completeMainFinalAnswer({
      taskId,
      text: "登录跳转已修好，全部测试通过并已合并到主分支",
      stopReason: "end_turn",
    });
    expect(f.delivered.length).toBeGreaterThan(0);
    expect(f.service.getTask(taskId)?.status).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// 面板夹具：来源判别
// ---------------------------------------------------------------------------

function makePanelContext(storageDir: string): vscodeTypes.ExtensionContext {
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

type PanelInternals = {
  store: {
    getState: () => {
      sessionId: string | null;
      status: string;
      blocks: Array<{ kind: string; id?: string; text?: string; system?: boolean }>;
      [k: string]: unknown;
    };
    sendToast: (...args: unknown[]) => number;
  };
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: unknown,
  ) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  drainSuperReports: () => Promise<void>;
  pendingSuperReportPrompts: Array<{
    mainSessionId: string | null;
    text: string;
    final?: boolean;
    fallbackText?: string;
    suppressQqProgress?: boolean;
  }>;
  superReportRunning: boolean;
  qqMainFinalAwaiters: Map<string, string>;
  qq?: { service?: { deliverMainTurnText?: (taskId: string, text: string) => Promise<void> } };
};

describe("QQ 出站 — 宿主通知回合不转发到 QQ（面板来源判别）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-notify-"));
    panel = new ChatPanel(makePanelContext(storageDir), {
      workspaceRoot: here,
      watchers: makeWatchers(),
    });
    p = panel as unknown as PanelInternals;
    p.store.getState().sessionId = "main-session";
    p.store.getState().status = "idle";
    p.store.getState().initializing = false;
    p.store.getState().replaying = false;
    p.ensureClient = async () => ({});
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    vi.spyOn(p.store, "sendToast").mockImplementation((() => 1) as never);
  });

  afterEach(async () => {
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("全中断通知回合（suppressQqProgress）的 assistant 正文不转发，正常进度回合仍转发", async () => {
    const deliver = vi.fn(async () => undefined);
    p.qq = { service: { deliverMainTurnText: deliver } };
    p.qqMainFinalAwaiters.set("T-qq", "main-session");
    let resolvePrompt: (v: { stopReason: string }) => void = () => undefined;
    p.promptWithRetry = vi.fn(
      () => new Promise<{ stopReason: string }>((resolve) => (resolvePrompt = resolve)),
    ) as unknown as PanelInternals["promptWithRetry"];

    // ── 第 1 轮：全中断（用户取消）的非 final 汇报 → 不转发 ──
    p.pendingSuperReportPrompts = [
      {
        mainSessionId: "main-session",
        text: "INTERRUPTED-REPORT",
        final: false,
        suppressQqProgress: true,
      },
    ];
    void p.drainSuperReports();
    await flush();
    p.store.getState().blocks.push({
      kind: "text",
      id: "mid",
      text: "打包任务的中断通知重复上报，情况不变",
    });
    resolvePrompt({ stopReason: "end_turn" });
    await flush();
    await flush();
    expect(deliver).not.toHaveBeenCalled();

    // ── 第 2 轮：正常「有子会话完成」的非 final 汇报 → 照常转发进度 ──
    p.pendingSuperReportPrompts = [
      {
        mainSessionId: "main-session",
        text: "PROGRESS-REPORT",
        final: false,
      },
    ];
    void p.drainSuperReports();
    await flush();
    p.store.getState().blocks.push({
      kind: "text",
      id: "mid2",
      text: "第 1 项已完成，当前进度 1/4",
    });
    resolvePrompt({ stopReason: "end_turn" });
    await flush();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith("T-qq", "第 1 项已完成，当前进度 1/4");
  });

  it("queueSuperReport 对全中断批次置 suppressQqProgress，对含完成项的批次不置位", async () => {
    const withQueue = p as unknown as {
      queueSuperReport: (entries: Array<{ session: unknown; report: unknown }>) => void;
      superAgent: {
        list: () => unknown[];
        reportPromptWithPending: (entries: unknown[], options?: unknown) => {
          text: string;
          pendingCount: number;
        };
      } | null;
    };
    const cancelled = {
      id: "super-cancelled",
      title: "打包任务",
      status: "cancelled",
      mainSessionId: "main-session",
      isolation: {},
      createdAt: 1,
      updatedAt: 1,
      reports: [],
    };
    const done = {
      id: "super-done",
      title: "登录任务",
      status: "completed",
      mainSessionId: "main-session",
      isolation: {},
      createdAt: 1,
      updatedAt: 1,
      reports: [],
    };
    withQueue.superAgent = {
      list: () => [cancelled, done],
      reportPromptWithPending: () => ({ text: "REPORT", pendingCount: 1 }),
    };

    // 全 dropped 批次 → suppressQqProgress=true。
    withQueue.queueSuperReport([
      { session: cancelled, report: { state: "dropped", summary: "已中断", at: 1 } },
    ]);
    await flush();
    const droppedItem = p.pendingSuperReportPrompts.find((i) => i.text === "REPORT");
    expect(droppedItem?.suppressQqProgress).toBe(true);

    // 清掉队列，避免影响后续；含 ready 项的批次不应抑制。
    p.pendingSuperReportPrompts = [];
    withQueue.queueSuperReport([
      { session: done, report: { state: "ready", summary: "登录修好", at: 2 } },
    ]);
    await flush();
    const readyItem = p.pendingSuperReportPrompts.find((i) => i.text === "REPORT");
    expect(readyItem?.suppressQqProgress).toBe(false);
  });

  it("真实 QQ 入站注入回合的 assistant 正文仍正常转发（未被来源判别误杀）", async () => {
    const deliver = vi.fn(async () => undefined);
    p.qq = { service: { deliverMainTurnText: deliver } };
    // 复用既有测试锁定的语义：委派注入轮的正文作为进度转发一次。
    // 这里直接验证投递通道对「真实入站回合」是放开的（与上面通知回合对照）。
    const withIntermediate = p as unknown as {
      deliverQqMainIntermediateText: (
        owner: string | null,
        text: string,
        taskIds?: readonly string[],
      ) => Promise<void>;
    };
    p.qqMainFinalAwaiters.set("T-qq", "main-session");
    await withIntermediate.deliverQqMainIntermediateText("main-session", "我已经取消了旧任务并派了新任务", [
      "T-qq",
    ]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith("T-qq", "我已经取消了旧任务并派了新任务");
  });
});
