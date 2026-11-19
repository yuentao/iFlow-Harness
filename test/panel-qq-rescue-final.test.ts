/**
 * QQ 主会话「迟到补发」不再等价于定终局（2026-11-19 回归）。
 *
 * 缺陷现场：子会话尚未全部结束时，awaiter 等过阈值就被判成「可以定终局」
 * → 汇报轮被标成 final → 投出去的是一条**空正文兜底**（22 字占位）→ 任务被
 * 写成终态、awaiter 被摘掉 → 后到的真实长正文**永不再投**（用户实测：QQ 端
 * 只收到 22 字占位）。
 *
 * 三条验收口径：
 *  1. **等待过久 ≠ 定终局**：rescueDue 只放宽提示词（要结论），final 仍只由
 *     pendingCount===0 决定；子会话没跑完时 awaiter 必须留着，真·最终轮到达
 *     时 QQ 收到的 summary **逐字等于**那段完整报告。
 *  2. **硬上限与子会话仍在跑的语义一致**：到点但仍有活跃子会话时，补发降级成
 *     「仍在进行中」的进度措辞 —— 不写 succeeded、不写 resultDeliveredAt，
 *     子会话终态后跑一轮真·最终汇报仍能成功投递。
 *  3. **补发可观测**：让路 / 降级写 `task_final_rescue_deferred`，每次投递写
 *     `task_answer_delivered` 并标注来源（final-report / rescue / intermediate）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { QqTaskStore } from "../src/qq/store.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { SuperReport, SuperSessionUi } from "../shared/super-agent.js";

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

const SESSION = "main-session";
const TASK = "T-qq-1";
/** 完整报告正文：真·最终轮投递时必须逐字等于它。 */
const FULL_REPORT = [
  "第 1 项完成：安装段已换成内网镜像并验证通过。",
  "第 2 项完成：缓存键已统一，回归测试通过。",
  "第 3 项完成：文档已同步到最新用法。",
].join("\n");

function child(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "super-1",
    title: "修好安装段",
    task: "修好 src/install.ts",
    status: "running",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    mainSessionId: SESSION,
    ...overrides,
  };
}

const READY_REPORT: SuperReport = { state: "ready", summary: "安装段已换成内网镜像", at: 2000 };

type PromptCall = {
  prompt: Array<{ type: string; text?: string }>;
  resolve: (v: { stopReason: string }) => void;
};

type FakeManager = {
  list: () => SuperSessionUi[];
  reportPromptWithPending: (
    entries: Array<{ session: SuperSessionUi }>,
    options?: { pendingOwner?: string | null; finalOverride?: boolean },
  ) => { text: string; pendingCount: number };
  reportPrompt: (entries: Array<{ session: SuperSessionUi }>) => string;
};

/**
 * 假 QQ 服务：**镜像真实服务的状态机契约**（见 `src/qq/service.ts`）——
 *  - 中间正文只投给仍停在 `injected` 的任务；
 *  - 最终答复才把任务写成 `succeeded` 并落 `resultDeliveredAt` 幂等锚点。
 * 这样「补发没有写 succeeded / resultDeliveredAt」就是可断言的事实，而不是
 * 「某个 mock 没被调用」这种弱断言。
 */
class FakeQqService {
  readonly tasks = new Map<string, { status: string; resultDeliveredAt?: number; summary?: string }>();
  readonly finals: Array<{ taskId: string; text: string; stopReason?: string }> = [];
  readonly intermediates: Array<{ taskId: string; text: string }> = [];

  constructor(taskIds: readonly string[]) {
    for (const taskId of taskIds) {
      this.tasks.set(taskId, { status: "injected" });
    }
  }

  async deliverMainTurnText(taskId: string, text: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "injected") return;
    this.intermediates.push({ taskId, text });
  }

  async completeMainFinalAnswer(input: {
    taskId: string;
    text: string;
    stopReason?: string;
  }): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (!task || task.status !== "injected") return;
    task.status = "succeeded";
    task.resultDeliveredAt = Date.now();
    task.summary = input.text;
    this.finals.push({ taskId: input.taskId, text: input.text, stopReason: input.stopReason });
  }
}

type PanelInternals = {
  superAgent: unknown;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: Array<{ type: string; text?: string }>,
  ) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  queueSuperReport: (entries: Array<{ session: SuperSessionUi; report: SuperReport }>) => void;
  drainSuperReports: () => Promise<void>;
  pendingSuperReportPrompts: Array<{
    mainSessionId: string | null;
    text: string;
    final?: boolean;
    fallbackText?: string;
  }>;
  superReportRunning: boolean;
  qqMainFinalAwaiters: Map<string, string>;
  qqMainFinalAwaiterSince: Map<string, number>;
  qqFinalRescueText: Map<string, string>;
  qqReportFallbackText: Map<string, string>;
  qqTaskFinalText: Map<string, string>;
  qqTaskBySuperSession: Map<string, string>;
  qqFinalRescueDefers: Map<string, number>;
  qqFinalRescueMs: number;
  qqFinalHardRescueMs: number;
  rescueStaleQqFinalAwaiters: () => void;
  qq?: {
    service?: {
      completeMainFinalAnswer?: (input: {
        taskId: string;
        text: string;
        stopReason?: string;
      }) => Promise<void>;
      deliverMainTurnText?: (taskId: string, text: string) => Promise<void>;
    };
    store?: {
      appendEvent: (event: {
        type: string;
        ts?: number;
        taskId?: string;
        detail?: unknown;
      }) => Promise<void>;
    };
  };
  store: {
    getState: () => {
      status: string;
      sessionId: string | null;
      superWaiting: boolean;
      blocks: Array<{ kind: string; id?: string; text?: string; system?: boolean }>;
      [k: string]: unknown;
    };
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: Record<string, unknown>) => void;
    sendToast: (...args: unknown[]) => number;
  };
};

describe("QQ 主会话迟到补发：等待过久 ≠ 定终局", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let qqRoot: string;
  /** 仍在飞的回合（未 resolve）。 */
  let pending: PromptCall[];
  let manager: FakeManager;
  let service: FakeQqService;
  let qqStore: QqTaskStore;

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false, autoTitle: false, autoMemoryCapture: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-rescue-final-storage-"));
    qqRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-rescue-final-store-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    pending = [];
    manager = {
      list: () => [],
      reportPromptWithPending: (entries, options) => ({
        text: `【汇报】${entries.map((e) => e.session.title).join("/")}${
          options?.finalOverride ? "（放宽：要结论）" : ""
        }`,
        pendingCount: 0,
      }),
      reportPrompt: (entries) => `【汇报】${entries.map((e) => e.session.title).join("/")}`,
    };
    p.superAgent = manager;
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) =>
        new Promise<{ stopReason: string }>((resolve) => {
          pending.push({ prompt, resolve });
        }),
    ) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    service = new FakeQqService([TASK]);
    qqStore = new QqTaskStore(qqRoot);
    p.qq = { service, store: qqStore };
    p.store.sessionStarted({ sessionId: SESSION });
    p.store.replaceState({ ...p.store.getState(), status: "idle" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // 别把回合留在半空：否则 dispose 会等到永远。
    for (const call of pending.splice(0)) call.resolve({ stopReason: "end_turn" });
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(qqRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  /** 等到主会话真的开出一个回合（面板内部有多个 await）。 */
  async function nextTurn(): Promise<PromptCall> {
    for (let i = 0; i < 300; i += 1) {
      if (pending.length > 0) return pending[0]!;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("主会话没有开出回合");
  }

  /** 跑完一个汇报轮：本轮正文由 `text` 决定，结束后等回合收尾。 */
  async function runReportRound(text: string, blockId: string): Promise<void> {
    const call = await nextTurn();
    p.store.getState().blocks.push({ kind: "text", id: blockId, text });
    pending.splice(pending.indexOf(call), 1);
    call.resolve({ stopReason: "end_turn" });
    for (let i = 0; i < 30; i += 1) await flush();
  }

  function readEvents(): Array<Record<string, unknown>> {
    const file = path.join(qqRoot, "events.ndjson");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("① 子会话没跑完时：awaiter 等过阈值也不定终局，真·最终轮逐字送达完整报告", async () => {
    const done = child({ id: "super-done", status: "completed" });
    const running1 = child({ id: "super-running-1", status: "running" });
    const running2 = child({ id: "super-running-2", status: "running" });
    manager.list = () => [done, running1, running2];
    manager.reportPromptWithPending = (entries, options) => ({
      text: `【汇报】${entries.map((e) => e.session.title).join("/")}${
        options?.finalOverride ? "（放宽：要结论）" : ""
      }`,
      pendingCount: 2,
    });
    p.qqMainFinalAwaiters.set(TASK, SESSION);
    p.qqMainFinalAwaiterSince.set(TASK, Date.now() - 100_000);
    p.qqFinalRescueMs = 1; // awaiter 已等过软阈值 → rescueDue=true

    // ── 第 1 轮：pendingCount=2（还有两个子会话在跑）──────────────────────
    p.queueSuperReport([{ session: done, report: READY_REPORT }]);
    await nextTurn();
    const relaxed = p.pendingSuperReportPrompts.find((i) => i.mainSessionId === SESSION);
    // 提示词被放宽（要结论），但这一轮**不是** final。
    expect(relaxed?.text).toContain("放宽：要结论");
    expect(relaxed?.final).toBe(false);

    await runReportRound("进度：第 1 项完成，1/4 进度", "round-progress");

    // 没有定终局：最终答复通道一次都没被调用，任务仍是 injected、awaiter 仍在。
    expect(service.finals).toHaveLength(0);
    expect(service.tasks.get(TASK)?.status).toBe("injected");
    expect(service.tasks.get(TASK)?.resultDeliveredAt).toBeUndefined();
    expect(p.qqMainFinalAwaiters.has(TASK)).toBe(true);
    // 这一轮的正文只作为「进度」转发，不冒充最终结论。
    expect(service.intermediates.map((i) => i.text).join("\n")).toContain("1/4 进度");
    expect(service.finals.map((f) => f.text).join("\n")).not.toContain("1/4 进度");

    // ── 第 2 轮：pendingCount=0（子会话全结束）→ 真·最终汇报 ───────────────
    manager.list = () => [done, running1, running2].map((c) => ({ ...c, status: "completed" }));
    manager.reportPromptWithPending = (entries) => ({
      text: `【最终汇报】${entries.map((e) => e.session.title).join("/")}`,
      pendingCount: 0,
    });
    p.queueSuperReport([{ session: running1, report: READY_REPORT }]);
    await runReportRound(FULL_REPORT, "round-final");

    // 完整报告**逐字**送达：不是「第 1 项完成」，也不是「1/4 进度」。
    expect(service.finals).toHaveLength(1);
    expect(service.finals[0]!.taskId).toBe(TASK);
    expect(service.finals[0]!.text).toBe(FULL_REPORT);
    expect(service.finals[0]!.text).not.toContain("1/4 进度");
    expect(service.tasks.get(TASK)?.status).toBe("succeeded");
    expect(p.qqMainFinalAwaiters.has(TASK)).toBe(false);
  });

  it("② 硬上限到点但子会话仍在跑：降级为「进行中」进度措辞，不写终局", async () => {
    const running = child({ id: "super-running", status: "running" });
    manager.list = () => [running];
    p.qqMainFinalAwaiters.set(TASK, SESSION);
    p.qqMainFinalAwaiterSince.set(TASK, Date.now() - 1_000_000);
    p.qqFinalRescueMs = 1_000_000; // 软阈值还远未到（即便到了也要求无活跃子会话）
    p.qqFinalHardRescueMs = 1; // 硬上限已到

    p.rescueStaleQqFinalAwaiters();
    for (let i = 0; i < 30; i += 1) await flush();

    // 绝不写终局：没有最终答复、任务仍是 injected、没有 resultDeliveredAt。
    expect(service.finals).toHaveLength(0);
    expect(service.tasks.get(TASK)?.status).toBe("injected");
    expect(service.tasks.get(TASK)?.resultDeliveredAt).toBeUndefined();
    // awaiter 保留：等子会话终态后的真·最终汇报。
    expect(p.qqMainFinalAwaiters.has(TASK)).toBe(true);

    // QQ 收到的是「进行中」，不是「已完成」。
    const progress = service.intermediates.map((i) => i.text).join("\n");
    expect(progress).toContain("进行中");
    expect(progress).not.toContain("已完成");
    expect(progress).not.toContain("超流体任务已完成");

    // ── 子会话终态后跑一轮真·最终汇报：这一轮正文成功投递 ──────────────────
    manager.list = () => [{ ...running, status: "completed" }];
    manager.reportPromptWithPending = (entries) => ({
      text: `【最终汇报】${entries.map((e) => e.session.title).join("/")}`,
      pendingCount: 0,
    });
    p.queueSuperReport([{ session: { ...running, status: "completed" }, report: READY_REPORT }]);
    await runReportRound(FULL_REPORT, "round-final");

    expect(service.finals).toHaveLength(1);
    expect(service.finals[0]!.text).toBe(FULL_REPORT);
    expect(service.tasks.get(TASK)?.status).toBe("succeeded");
    expect(p.qqMainFinalAwaiters.has(TASK)).toBe(false);
  });

  it("③ 补发可观测：让路 / 降级写归档事件，投递事件标注来源", async () => {
    const running = child({ id: "super-running", status: "running" });
    manager.list = () => [running];
    p.qqMainFinalAwaiters.set(TASK, SESSION);
    p.qqMainFinalAwaiterSince.set(TASK, Date.now() - 1_000_000);
    p.qqFinalRescueMs = 1_000_000;
    p.qqFinalHardRescueMs = 1;

    // ① 汇报轮在途 → 补发让路（不投递、不定终局），并写归档事件。
    p.superReportRunning = true;
    p.rescueStaleQqFinalAwaiters();
    for (let i = 0; i < 30; i += 1) await flush();

    const deferred = readEvents().filter((e) => e["type"] === "task_final_rescue_deferred");
    expect(deferred.length).toBeGreaterThan(0);
    const detail = deferred[0]!["detail"] as Record<string, unknown>;
    expect(detail["reason"]).toBe("report-in-flight");
    expect(detail["waited"]).toBeGreaterThan(0);
    expect(detail["activeChildren"]).toBe(1);
    expect(typeof detail["defers"]).toBe("number");
    expect(deferred[0]!["taskId"]).toBe(TASK);

    // ② 硬上限到点 + 子会话仍在跑 → 降级为进度措辞，同样写归档事件。
    p.superReportRunning = false;
    p.rescueStaleQqFinalAwaiters();
    for (let i = 0; i < 30; i += 1) await flush();

    const events = readEvents();
    const runningReason = events
      .filter((e) => e["type"] === "task_final_rescue_deferred")
      .map((e) => e["detail"] as Record<string, unknown>)
      .find((d) => d["reason"] === "children-running");
    expect(runningReason).toBeTruthy();
    expect(runningReason!["activeChildren"]).toBe(1);

    // ③ 每次投递都标注来源：这一次是「中间正文 / 进度」。
    const delivered = events.filter((e) => e["type"] === "task_answer_delivered");
    expect(delivered.length).toBeGreaterThan(0);
    const sources = delivered.map(
      (e) => (e["detail"] as Record<string, unknown>)["source"],
    );
    expect(sources).toContain("intermediate");

    // ④ 真·最终汇报那一轮标注来源 final-report。
    manager.list = () => [{ ...running, status: "completed" }];
    manager.reportPromptWithPending = (entries) => ({
      text: `【最终汇报】${entries.map((e) => e.session.title).join("/")}`,
      pendingCount: 0,
    });
    p.queueSuperReport([{ session: { ...running, status: "completed" }, report: READY_REPORT }]);
    await runReportRound(FULL_REPORT, "round-final");

    const finalEvents = readEvents().filter((e) => e["type"] === "task_answer_delivered");
    const finalSource = finalEvents
      .map((e) => e["detail"] as Record<string, unknown>)
      .find((d) => d["source"] === "final-report");
    expect(finalSource).toBeTruthy();
    expect(finalSource!["chars"]).toBe(FULL_REPORT.length);
    expect(finalSource!["owner"]).toBe(SESSION);
  });
});