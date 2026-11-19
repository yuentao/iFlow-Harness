/**
 * Super Agent 单车道仲裁与迟到结论（宿主侧）。
 *
 * 覆盖两项改动：
 *  1. 5 条宿主自动回合队列由统一仲裁点按「明确优先级 + 轮转游标」取任务，卡住
 *     的队列只占一拍、不永久挡住其余；所有既有互斥门控与 mainLane 申领释放不变。
 *  2. 已被清理 / 合并释放的子会话，其迟到汇报不再静默丢弃，而是以「已归档子会
 *     话的迟到结论」sticky 提示落到看板，不伪造为活跃子会话的实时汇报。
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
import type { SuperReport, SuperSessionUi } from "../shared/super-agent.js";

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

function child(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "super-1",
    title: "修好登录跳转",
    task: "修好 src/auth.ts",
    status: "running",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    ...overrides,
  };
}

const READY_REPORT: SuperReport = { state: "ready", summary: "登录跳转已修好", at: 2000 };

type PromptCall = {
  prompt: Array<{ type: string; text?: string }>;
  resolve: (v: { stopReason: string }) => void;
};

type ToastCall = { message: string; opts?: Record<string, unknown> };

type FakeManager = {
  list: (mainSessionId?: string | null) => SuperSessionUi[];
  reportPrompt: (entries: Array<{ session: SuperSessionUi }>) => string;
  spawn: ReturnType<typeof vi.fn>;
};

type PanelInternals = {
  superAgent: unknown;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: unknown,
  ) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  drainSuperAutoTurns: () => Promise<void>;
  drainSuperReports: () => Promise<void>;
  refreshSuperWaitHeartbeat: () => void;
  queueSuperReport: (entries: Array<{ session: SuperSessionUi; report: SuperReport }>) => void;
  superAutoTurnCursor: number;
  pendingSuperReportPrompts: Array<{
    mainSessionId: string | null;
    text: string;
    final?: boolean;
    fallbackText?: string;
  }>;
  superReportRunning: boolean;
  pendingSuperActionReceipts: Array<{ mainSessionId: string | null; text: string }>;
  autoTurnsStoppedFor: string | null;
  qqMainFinalAwaiters: Map<string, string>;
  qqMainFinalAwaiterSince: Map<string, number>;
  qqFinalRescueText: Map<string, string>;
  qqReportFallbackText: Map<string, string>;
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
    };
  };
  store: {
    getState: () => {
      status: string;
      superWaiting: boolean;
      blocks: Array<{ kind: string; id?: string; text?: string; system?: boolean }>;
      [k: string]: unknown;
    };
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: Record<string, unknown>) => void;
    sendToast: (...args: unknown[]) => number;
  };
};

describe("ChatPanel · Super Agent 单车道仲裁与迟到结论", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let toasts: ToastCall[];
  let manager: FakeManager;

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superlane-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    toasts = [];
    manager = {
      list: () => [],
      reportPrompt: (entries) => entries.map((e) => `【汇报】${e.session.title}`).join("\n"),
      spawn: vi.fn(() => ({ id: "super-spawned" })),
    };
    p.superAgent = manager;
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) =>
        new Promise<{ stopReason: string }>((resolve) => {
          calls.push({ prompt, resolve });
        }),
    ) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    vi.spyOn(p.store, "sendToast").mockImplementation(((...args: unknown[]) => {
      toasts.push({ message: String(args[1]), opts: args[2] as Record<string, unknown> });
      return toasts.length;
    }) as PanelInternals["store"]["sendToast"]);
    p.store.sessionStarted({ sessionId: "lane-session" });
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

  it("汇报优先于动作回执；仲裁后轮转游标前进", async () => {
    p.pendingSuperReportPrompts = [{ mainSessionId: "lane-session", text: "REPORT-TEXT" }];
    p.pendingSuperActionReceipts = [{ mainSessionId: "lane-session", text: "RECEIPT-TEXT" }];
    p.superAutoTurnCursor = 0;

    void p.drainSuperAutoTurns();
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("REPORT-TEXT");
    // 汇报是优先级首位；被仲裁后游标挪到动作回执。
    expect(p.superAutoTurnCursor).toBe(1);
  });

  it("上一拍服务过的队列挪到队尾：下一拍动作回执获得投递机会", async () => {
    p.pendingSuperReportPrompts = [{ mainSessionId: "lane-session", text: "REPORT-1" }];
    p.pendingSuperActionReceipts = [{ mainSessionId: "lane-session", text: "RECEIPT-1" }];
    p.superAutoTurnCursor = 0;

    void p.drainSuperAutoTurns();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("REPORT-1");

    // 汇报回合收尾后，下一次仲裁（心跳 / 回合收尾钩子）从动作回执起步：
    // 它先于剩下的汇报投递。
    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();
    void p.drainSuperAutoTurns();
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt[0]!.text).toContain("RECEIPT-1");
  });

  it("被 Stop 压住的汇报只占一拍，不会连带挡住动作回执", async () => {
    p.autoTurnsStoppedFor = "lane-session";
    p.pendingSuperReportPrompts = [{ mainSessionId: "lane-session", text: "HELD-REPORT" }];
    p.pendingSuperActionReceipts = [{ mainSessionId: "lane-session", text: "FREE-RECEIPT" }];
    p.superAutoTurnCursor = 0;

    // 第一拍仲裁到汇报：它自行被 autoTurnsHeld 挡回，游标前进。
    void p.drainSuperAutoTurns();
    await flush();
    expect(calls).toHaveLength(0);
    expect(p.superAutoTurnCursor).toBe(1);

    // 第二拍从动作回执起步：它不受 Stop 压制，照常投递。
    void p.drainSuperAutoTurns();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("FREE-RECEIPT");
    // 被压住的汇报仍在队列里，一条不丢。
    expect(p.pendingSuperReportPrompts).toHaveLength(1);
  });

  it("超流体被清理后其迟到结论以「已归档」提示落到看板，不伪造实时汇报", async () => {
    const awaiting = child({
      id: "super-archived",
      title: "归档任务",
      status: "awaiting_input",
    });
    manager.list = () => [awaiting];
    p.queueSuperReport([
      {
        session: awaiting,
        report: { state: "blocked", summary: "迟到的结论正文", at: 2000, humanAction: "等回答" },
      },
    ]);
    await flush();
    expect(calls).toHaveLength(0); // 来源未终态：不作为实时汇报投递

    // 子会话被清理：迟到结论不该静默丢失。
    manager.list = () => [];
    p.refreshSuperWaitHeartbeat();
    await flush();

    expect(calls).toHaveLength(0); // 绝不伪造为 hidden 回合 / 用户气泡
    expect(p.pendingSuperReportPrompts).toHaveLength(0);
    expect(p.store.getState().superWaiting).toBe(false);
    const archived = toasts.find(
      (t) => t.message.includes("已归档超流体") && t.message.includes("迟到的结论正文"),
    );
    expect(archived).toBeTruthy();
    expect(archived!.message).toContain("归档任务");
    // sticky = 用户可关闭的提示，不是 host 独占生命周期的 displayOnly 等待条。
    expect(archived!.opts?.sticky).toBe(true);
    // 重复刷新不重复提示。
    p.refreshSuperWaitHeartbeat();
    await flush();
    expect(toasts.filter((t) => t.message.includes("已归档超流体"))).toHaveLength(1);
  });

  it("压制期间新到的汇报点亮「继续处理」动作，恢复不再只有下一条消息一个解除点", async () => {
    p.autoTurnsStoppedFor = "lane-session";
    const done = child({ id: "super-done", status: "completed" });
    manager.list = () => [done];

    p.queueSuperReport([{ session: done, report: READY_REPORT }]);
    await flush();

    expect(calls).toHaveLength(0); // 仍被压住
    const held = toasts.find((t) => t.message.includes("已停止"));
    expect(held).toBeTruthy();
    expect((held!.opts?.action as { actionId: string } | undefined)?.actionId).toBe(
      "resume-super-turns",
    );
  });

  it("最终汇总轮（final）把本轮 assistant 文本作为 QQ 最终答复回传，进度轮不回执", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    p.qqMainFinalAwaiters.set("T-qq", "lane-session");
    p.store.getState().blocks.push({ kind: "text", id: "baseline", text: "上一轮文本" });

    // 非 final 进度汇报轮：收尾不回执 QQ。
    p.pendingSuperReportPrompts = [
      { mainSessionId: "lane-session", text: "PROGRESS-REPORT", final: false },
    ];
    void p.drainSuperReports();
    await flush();
    p.store.getState().blocks.push({ kind: "text", id: "mid", text: "中途进度答复" });
    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(p.qqMainFinalAwaiters.has("T-qq")).toBe(true);

    // final 汇总轮：只取基线之后本轮新增的 assistant 文本。
    p.pendingSuperReportPrompts = [
      { mainSessionId: "lane-session", text: "FINAL-REPORT", final: true },
    ];
    void p.drainSuperReports();
    await flush();
    const call = calls[calls.length - 1]!;
    expect(call.prompt[0]!.text).toContain("FINAL-REPORT");
    p.store.getState().blocks.push({ kind: "text", id: "final", text: "真正的最终答复" });
    call.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      taskId: "T-qq",
      text: "真正的最终答复",
      stopReason: "end_turn",
    });
    expect(p.qqMainFinalAwaiters.has("T-qq")).toBe(false);
  });

  it("pendingCount 长期>0 且 awaiter 等过阈值时，汇报轮仍被标为 final（R2 迟到补发）", async () => {
    const done = child({ id: "super-done", status: "completed" });
    const stuck = child({ id: "super-stuck", status: "running" });
    manager.list = () => [done, stuck];
    p.qqMainFinalAwaiters.set("T-qq", "lane-session");
    // 该 awaiter 已等很久；把软阈值注入成 1ms 即可判定「迟到」。
    p.qqMainFinalAwaiterSince.set("T-qq", Date.now() - 100_000);
    p.qqFinalRescueMs = 1;

    p.queueSuperReport([{ session: done, report: READY_REPORT }]);
    await flush();

    // pendingCount=1（stuck 子会话仍非终态），但 awaiter 迟到 → 该轮放宽为 final，
    // 主会话这一轮的正文就能作为 QQ 真正最终答复投递（不再永远停在已受理）。
    const item = p.pendingSuperReportPrompts.find((i) => i.mainSessionId === "lane-session");
    expect(item).toBeTruthy();
    expect(item!.final).toBe(true);
  });

  it("无新汇报轮时，超时 awaiter 由迟到补发兜底并摘除（R2）", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    manager.list = () => [];
    p.qqMainFinalAwaiters.set("T-qq", "lane-session");
    p.qqMainFinalAwaiterSince.set("T-qq", Date.now() - 100_000);
    p.qqFinalRescueMs = 1;
    p.qqFinalHardRescueMs = 1_000_000;
    p.qqFinalRescueText.set("lane-session", "缓存的真实结论");

    p.rescueStaleQqFinalAwaiters();
    await flush();
    await flush();

    expect(complete).toHaveBeenCalledWith({
      taskId: "T-qq",
      text: "缓存的真实结论",
      stopReason: "end_turn",
    });
    expect(p.qqMainFinalAwaiters.has("T-qq")).toBe(false);
  });

  it("软阈值下仍有活跃超流体时不提前补发（不误伤正常长任务）", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    manager.list = () => [child({ id: "super-running", status: "running" })];
    p.qqMainFinalAwaiters.set("T-qq", "lane-session");
    p.qqMainFinalAwaiterSince.set("T-qq", Date.now() - 100_000);
    p.qqFinalRescueMs = 1;
    p.qqFinalHardRescueMs = 1_000_000; // 硬上限还远未到

    p.rescueStaleQqFinalAwaiters();
    await flush();

    expect(complete).not.toHaveBeenCalled();
    expect(p.qqMainFinalAwaiters.has("T-qq")).toBe(true);
  });

  it("硬上限到点但汇报轮在途 / 排队时先让路，不抢在真实最终汇报前面", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    manager.list = () => [];
    p.qqMainFinalAwaiters.set("T-qq", "lane-session");
    p.qqMainFinalAwaiterSince.set("T-qq", Date.now() - 1_000_000);
    p.qqFinalHardRescueMs = 1;
    p.qqFinalRescueText.set("lane-session", "缓存正文");

    // 汇报轮正在投递：补发必须让路。
    p.superReportRunning = true;
    p.rescueStaleQqFinalAwaiters();
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(p.qqMainFinalAwaiters.has("T-qq")).toBe(true);
    expect(p.qqFinalRescueDefers.get("T-qq")).toBe(1);

    // 汇报轮结束但同一 owner 还有排队汇报：继续让路。
    p.superReportRunning = false;
    p.pendingSuperReportPrompts = [{ mainSessionId: "lane-session", text: "QUEUED" }];
    p.rescueStaleQqFinalAwaiters();
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(p.qqFinalRescueDefers.get("T-qq")).toBe(2);

    // 队列清空后补发照常发生 —— 让路只推迟、不永久取消。
    p.pendingSuperReportPrompts = [];
    p.rescueStaleQqFinalAwaiters();
    await flush();
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      taskId: "T-qq",
      text: "缓存正文",
      stopReason: "end_turn",
    });
    expect(p.qqFinalRescueDefers.has("T-qq")).toBe(false);
  });

  it("在途汇报轮持续卡死时让路有上限，超过后仍强制补发（真正卡死的兜底）", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    manager.list = () => [];
    p.qqMainFinalAwaiters.set("T-qq", "lane-session");
    p.qqMainFinalAwaiterSince.set("T-qq", Date.now() - 1_000_000);
    p.qqFinalHardRescueMs = 1;
    p.qqFinalRescueText.set("lane-session", "缓存正文");
    p.superReportRunning = true;

    // 让路 6 拍都不补发；第 7 拍强制补发。
    for (let i = 0; i < 6; i += 1) {
      p.rescueStaleQqFinalAwaiters();
      await flush();
      expect(complete).not.toHaveBeenCalled();
    }
    expect(p.qqFinalRescueDefers.get("T-qq")).toBe(6);
    p.rescueStaleQqFinalAwaiters();
    await flush();
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(p.qqMainFinalAwaiters.has("T-qq")).toBe(false);
  });

  it("补发缓存正文为空时用汇报正文兜底，不再只发一句占位文案", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    manager.list = () => [];
    p.qqMainFinalAwaiters.set("T-qq", "lane-session");
    p.qqMainFinalAwaiterSince.set("T-qq", Date.now() - 1_000_000);
    p.qqFinalHardRescueMs = 1;
    // qqFinalRescueText 故意不设：缓存为空。
    p.qqReportFallbackText.set("lane-session", "子会话真实汇报：登录跳转已修好并验证通过");

    p.rescueStaleQqFinalAwaiters();
    await flush();
    await flush();

    expect(complete).toHaveBeenCalledWith({
      taskId: "T-qq",
      text: "子会话真实汇报：登录跳转已修好并验证通过",
      stopReason: "end_turn",
    });
    expect(p.qqMainFinalAwaiters.has("T-qq")).toBe(false);
  });

  it("finalReport 锚点失效时经 finalFallbackText 投递，不再静默放弃滑向空缓存补发", async () => {
    const complete = vi.fn(async () => undefined);
    p.qq = { service: { completeMainFinalAnswer: complete } };
    p.qqMainFinalAwaiters.set("T-qq", "lane-session");
    p.store.getState().blocks.push({ kind: "text", id: "anchor", text: "上一轮旧正文" });
    p.pendingSuperReportPrompts = [
      {
        mainSessionId: "lane-session",
        text: "FINAL-REPORT",
        final: true,
        fallbackText: "子会话汇报正文兜底",
      },
    ];

    void p.drainSuperReports();
    await flush();
    const call = calls[calls.length - 1]!;
    // 模拟转录被清空 / 重排：锚块消失，按 id 切片不安全。
    const blocks = p.store.getState().blocks;
    blocks.splice(0, blocks.length);
    call.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      taskId: "T-qq",
      text: "子会话汇报正文兜底",
      stopReason: "end_turn",
    });
    expect(p.qqMainFinalAwaiters.has("T-qq")).toBe(false);
  });
});
