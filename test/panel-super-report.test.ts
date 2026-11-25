/**
 * SA-2：Super Agent 汇报投递可靠性 + 缓冲按 attempt 键控（G2 + G13）。
 *
 * 覆盖：
 *  1. SuperReportBuffer 以 `sessionId:attempt` 为键 —— 同 id 不同 attempt 的汇报
 *     都保留，过期 attempt 的迟到汇报在取件时被忽略、不污染当前轮。
 *  2. drainSettled 非破坏性 + confirm —— 投递确认（sendPrompt 真的跑起来）前
 *     条目留在缓冲；主会话忙 / 投递失败时下一拍心跳重投，且不重复排队 / 不重复
 *     累积 QQ 归属正文（去重键 sessionId:attempt 生效）。
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
import {
  SuperReportBuffer,
  superReportKey,
  type SuperReport,
  type SuperSessionUi,
} from "../shared/super-agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      store.has(key) ? (store.get(key) as T) : (defaultValue as T),
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

type InternalBuffer = { size: number };

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
  refreshSuperWaitHeartbeat: () => void;
  superReportRunning: boolean;
  queueSuperReport: (entries: Array<{ session: SuperSessionUi; report: SuperReport }>) => void;
  pendingSuperReports: Map<string, InternalBuffer>;
  pendingSuperReportPrompts: Array<{
    mainSessionId: string | null;
    text: string;
    reportKeys?: string[];
  }>;
  qqTaskFinalText: Map<string, string>;
  qqTaskBySuperSession: Map<string, string>;
  qqMainFinalAwaiters: Map<string, string>;
  store: {
    getState: () => { status: string; [k: string]: unknown };
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: Record<string, unknown>) => void;
    sendToast: (level: string, message: string, opts?: unknown) => number;
  };
};

// ---------------------------------------------------------------------------
// 缓冲层（shared/super-agent.ts）
// ---------------------------------------------------------------------------

describe("SuperReportBuffer · attempt 键控与可靠投递", () => {
  it("superReportKey 用 id:attempt 区分同一子会话的不同执行", () => {
    expect(superReportKey(child({ id: "a" }))).toBe("a:1");
    expect(superReportKey(child({ id: "a", attempts: 2 }))).toBe("a:2");
    expect(superReportKey(child({ id: "a", attempts: 7 }))).toBe("a:7");
  });

  it("同 id 两 attempt 的汇报都保留在缓冲，互不覆盖", () => {
    const buffer = new SuperReportBuffer();
    const a1 = child({ id: "a", attempts: 1, status: "failed" });
    const a2 = child({ id: "a", attempts: 2, status: "completed" });
    buffer.add([{ session: a1, report: { state: "failed", summary: "第 1 次失败", at: 1 } }]);
    buffer.add([{ session: a2, report: { state: "ready", summary: "第 2 次完成", at: 2 } }]);
    expect(buffer.size).toBe(2);
  });

  it("取件时按当前 attempt 校验：过期 attempt 的迟到汇报被忽略，不污染当前轮", () => {
    const buffer = new SuperReportBuffer();
    const a1 = child({ id: "a", attempts: 1, status: "failed" });
    const a2 = child({ id: "a", attempts: 2, status: "completed" });
    buffer.add([{ session: a1, report: { state: "failed", summary: "过期 attempt 的迟到结论", at: 1 } }]);
    buffer.add([{ session: a2, report: { state: "ready", summary: "当前 attempt 的结论", at: 2 } }]);

    // 当前会话已重试到 attempt 2：只取 attempt 2 的汇报，attempt 1 被丢弃。
    const batch = buffer.takeSettled([a2]);
    expect(batch?.map((e) => e.report.summary)).toEqual(["当前 attempt 的结论"]);
    expect(buffer.size).toBe(0);
  });

  it("drainSettled 非破坏性：confirm 前条目留在缓冲，in-flight 不重复取", () => {
    const buffer = new SuperReportBuffer();
    const done = child({ id: "b", attempts: 1, status: "completed" });
    buffer.add([{ session: done, report: READY_REPORT }]);

    const first = buffer.drainSettled([done]);
    expect(first?.map((e) => e.session.id)).toEqual(["b"]);
    // 条目没出队；去重键 in-flight 挡住重复排队。
    expect(buffer.size).toBe(1);
    expect(buffer.drainSettled([done])).toBeNull();

    // 投递成功确认后才真正出队。
    buffer.confirm(["b:1"]);
    expect(buffer.size).toBe(0);
    expect(buffer.drainSettled([done])).toBeNull();
  });

  it("release 放弃 in-flight 标记后条目可被重新取（投递失败重投）", () => {
    const buffer = new SuperReportBuffer();
    const done = child({ id: "c", attempts: 1, status: "completed" });
    buffer.add([{ session: done, report: READY_REPORT }]);
    expect(buffer.drainSettled([done])).toHaveLength(1);
    expect(buffer.drainSettled([done])).toBeNull();
    buffer.release(["c:1"]);
    expect(buffer.drainSettled([done])).toHaveLength(1);
    expect(buffer.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 宿主层（src/panel/panel.ts）
// ---------------------------------------------------------------------------

describe("ChatPanel · 汇报投递可靠性（G2）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let manager: {
    list: () => SuperSessionUi[];
    reportPrompt: (e: Array<{ session: SuperSessionUi; report: SuperReport }>) => string;
  };
  let done: SuperSessionUi;

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superreport-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    done = child({ id: "super-report", status: "completed", attempts: 1 });
    manager = {
      list: () => [done],
      reportPrompt: (entries) => entries.map((e) => `【汇报】${e.report.summary}`).join("\n"),
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
    p.store.sessionStarted({ sessionId: "report-session" });
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

  it("主会话忙时汇报留在缓冲，下一拍心跳重投且只投一次；成功后才出队", async () => {
    // 主会话忙：汇报排队但一条都投不出去。
    p.store.replaceState({ ...p.store.getState(), status: "streaming" });
    p.queueSuperReport([{ session: done, report: READY_REPORT }]);
    await flush();

    expect(calls).toHaveLength(0);
    expect(p.pendingSuperReportPrompts).toHaveLength(1);
    expect(p.pendingSuperReportPrompts[0]!.reportKeys).toEqual(["super-report:1"]);
    // 关键：投递未被确认（sendPrompt 没跑起来），条目仍在缓冲里。
    expect(p.pendingSuperReports.get("report-session")!.size).toBe(1);

    // 主会话恢复空闲，下一拍心跳重投。
    p.store.replaceState({ ...p.store.getState(), status: "idle" });
    void p.drainSuperAutoTurns();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("登录跳转已修好");
    // 投递中（sendPrompt 等 promptWithRetry resolve）仍未 confirm。
    expect(p.pendingSuperReports.get("report-session")!.size).toBe(1);

    // 回合真正结束 → 确认投递 → 缓冲出队、队列清空。
    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();
    expect(p.pendingSuperReportPrompts).toHaveLength(0);
    expect(p.pendingSuperReports.get("report-session")!.size).toBe(0);

    // 再触发一拍心跳：不重复投递（去重键已确认，缓冲为空）。
    void p.drainSuperAutoTurns();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("多次心跳重算不重复排队，也不重复累积 QQ 归属正文（去重键 sessionId:attempt）", async () => {
    // QQ 归属：该汇报属于 T-qq 任务，归属正文会被 settleSuperReportsIfReady 累积。
    p.qqTaskBySuperSession.set("super-report", "T-qq");
    p.qqMainFinalAwaiters.set("T-qq", "report-session");
    p.store.replaceState({ ...p.store.getState(), status: "streaming" }); // 保持忙，避免真投递消耗归属正文

    p.queueSuperReport([{ session: done, report: READY_REPORT }]);
    await flush();
    for (let i = 0; i < 3; i += 1) {
      p.refreshSuperWaitHeartbeat(); // 每拍都重新 settle 一次
      await flush();
    }

    // 去重键 in-flight 生效：反复 settle 也只排队一条、正文只累积一次。
    expect(p.pendingSuperReportPrompts).toHaveLength(1);
    expect(p.qqTaskFinalText.get("T-qq")).toBe("登录跳转已修好");
    expect(calls).toHaveLength(0);
  });

  it("过期 attempt 的迟到汇报不会被投递到当前会话（attempt 校验）", async () => {
    const stale = child({ id: "super-report", attempts: 1, status: "failed" });
    const current = child({ id: "super-report", attempts: 2, status: "running" });
    manager.list = () => [current];

    // attempt 1 的迟到汇报进缓冲；当前会话已重试到 attempt 2 且还在跑。
    p.queueSuperReport([
      { session: stale, report: { state: "failed", summary: "过期的失败结论", at: 1 } },
    ]);
    await flush();
    expect(calls).toHaveLength(0);
    // 过期 attempt 与当前 attempt 键不一致 → 取件时被丢弃，不排队、不污染当前轮。
    expect(p.pendingSuperReportPrompts).toHaveLength(0);

    // 当前 attempt 2 完成后正常汇报，不受那条过期汇报影响。
    const currentDone = child({ id: "super-report", attempts: 2, status: "completed" });
    manager.list = () => [currentDone];
    p.queueSuperReport([
      { session: currentDone, report: { state: "ready", summary: "当前 attempt 的结论", at: 2 } },
    ]);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("当前 attempt 的结论");
    expect(calls[0]!.prompt[0]!.text).not.toContain("过期的失败结论");
  });

  it("并发完成不被吞：上一轮汇报在飞时，新完成的子会话各自立刻入队（N 个完成 = N 次上报）", async () => {
    // 用户实测回归：看板已显示 2 个子会话 completed，主会话却只收到 1 条汇报。
    // 旧实现在 settleSuperReportsIfReady 开头 `|| this.superReportRunning` 早退：
    // 上一轮汇报回合还在 await sendPrompt 时，后续完成的子会话既不进队列也不标
    // in-flight，只能等 1.5s 后的心跳把缓冲一次性 drainSettled → 攒成一条合并汇报。
    const a = child({ id: "super-a", status: "completed", summary: "A 完成" });
    const b = child({ id: "super-b", status: "completed", summary: "B 完成" });
    const c = child({ id: "super-c", status: "completed", summary: "C 完成" });
    manager.list = () => [a];

    // A 先完成：汇报回合开跑（calls[0] 挂着，superReportRunning=true）。
    p.queueSuperReport([{ session: a, report: { state: "ready", summary: "A 完成", at: 1 } }]);
    await flush();
    expect(calls).toHaveLength(1);
    expect(p.superReportRunning).toBe(true);

    // A 的回合还在飞，B、C 先后完成。
    manager.list = () => [a, b];
    p.queueSuperReport([{ session: b, report: { state: "ready", summary: "B 完成", at: 2 } }]);
    await flush();
    manager.list = () => [a, b, c];
    p.queueSuperReport([{ session: c, report: { state: "ready", summary: "C 完成", at: 3 } }]);
    await flush();

    // 关键断言：B、C 各自已作为独立汇报项进入投递队列 —— 不是攒在缓冲里等心跳。
    // 队列里此刻有正在飞的 A（投递成功才出队）+ 排队的 B + 排队的 C。
    expect(p.pendingSuperReportPrompts.map((item) => item.text)).toEqual([
      expect.stringContaining("A 完成"),
      expect.stringContaining("B 完成"),
      expect.stringContaining("C 完成"),
    ]);

    // 放行 A → drain 循环接着投 B；再放行 → 投 C。三条独立汇报全部送达。
    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();
    await flush();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();
    await flush();
    expect(calls.length).toBeGreaterThanOrEqual(3);

    const delivered = calls.map((call) => call.prompt[0]!.text ?? "").join("\n---\n");
    expect(delivered).toContain("A 完成");
    expect(delivered).toContain("B 完成");
    expect(delivered).toContain("C 完成");
    // 三条各自独立成轮（不是一条合并汇报里塞三份）。
    expect(calls.filter((call) => (call.prompt[0]!.text ?? "").includes("A 完成"))).toHaveLength(1);
    expect(calls.filter((call) => (call.prompt[0]!.text ?? "").includes("B 完成"))).toHaveLength(1);
    expect(calls.filter((call) => (call.prompt[0]!.text ?? "").includes("C 完成"))).toHaveLength(1);
  });

  it("settle 不受 superReportRunning 影响：汇报回合在飞时仍能把新终态条目搬进队列", async () => {
    // 直接钉住根因：把 superReportRunning 置为 true（模拟上一轮还在 await），
    // settleSuperReportsIfReady 仍必须取件入队 —— 它只搬队列、不发回合。
    const done2 = child({ id: "super-late", status: "completed", summary: "后来完成" });
    manager.list = () => [done2];
    p.superReportRunning = true;

    p.queueSuperReport([
      { session: done2, report: { state: "ready", summary: "后来完成", at: 5 } },
    ]);
    await flush();

    expect(p.pendingSuperReportPrompts.map((item) => item.text)).toEqual([
      expect.stringContaining("后来完成"),
    ]);
    // 一条都没投出去（重入锁仍然生效：superReportRunning 挡的是发送，不是取件）。
    expect(calls).toHaveLength(0);
  });

  it("主会话忙时并发完成的汇报不丢：忙窗口内全部入队，空闲后 N 条各自独立送达", async () => {
    // 用户实测形态：3 个子会话几乎同时结束，而主会话此刻正在 streaming。
    // 旧实现的 superReportRunning 早退会让后来的完成事件既不进队列也不标
    // in-flight；即便只修了那一处，忙窗口里也必须逐条入队、一条不丢。
    const a = child({ id: "super-a", status: "completed", summary: "A 完成" });
    const b = child({ id: "super-b", status: "completed", summary: "B 完成" });
    const c = child({ id: "super-c", status: "completed", summary: "C 完成" });
    manager.list = () => [a, b, c];
    p.store.replaceState({ ...p.store.getState(), status: "streaming" });

    p.queueSuperReport([{ session: a, report: { state: "ready", summary: "A 完成", at: 1 } }]);
    p.queueSuperReport([{ session: b, report: { state: "ready", summary: "B 完成", at: 2 } }]);
    p.queueSuperReport([{ session: c, report: { state: "ready", summary: "C 完成", at: 3 } }]);
    await flush();

    // 主会话忙：一条都投不出去，但三条都在队列里（各自独立，不是合并成一条）。
    expect(calls).toHaveLength(0);
    expect(p.pendingSuperReportPrompts.map((item) => item.text)).toEqual([
      expect.stringContaining("A 完成"),
      expect.stringContaining("B 完成"),
      expect.stringContaining("C 完成"),
    ]);

    // 主会话空闲 → 逐条投递，每条等自己的回合结束。
    p.store.replaceState({ ...p.store.getState(), status: "idle" });
    for (let round = 0; round < 3; round += 1) {
      void p.drainSuperAutoTurns();
      await flush();
      await flush();
      expect(calls).toHaveLength(round + 1);
      calls[round]!.resolve({ stopReason: "end_turn" });
      await flush();
      await flush();
    }

    // N 个完成 = N 次独立上报，每条只含自己的子会话结论。
    expect(calls).toHaveLength(3);
    const texts = calls.map((call) => call.prompt[0]!.text ?? "");
    expect(texts.filter((text) => text.includes("A 完成"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("B 完成"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("C 完成"))).toHaveLength(1);
    expect(p.pendingSuperReportPrompts).toHaveLength(0);
  });

  it("看门狗把子会话置 failed 后再来一条汇报：先前已入队的待汇报项一条不丢", async () => {
    // 看门狗在 manager 层把卡死的子会话归一为 failed 并再触发一次 onReport。
    // 宿主侧的风险是：这次 settle/心跳重算会不会把先前已入队（in-flight）的
    // 汇报清掉。断言队列是「累加」而不是「覆盖」。
    const doneA = child({ id: "super-a", status: "completed", summary: "A 完成" });
    manager.list = () => [doneA];
    p.store.replaceState({ ...p.store.getState(), status: "streaming" });
    p.queueSuperReport([{ session: doneA, report: { state: "ready", summary: "A 完成", at: 1 } }]);
    await flush();
    expect(p.pendingSuperReportPrompts).toHaveLength(1);

    // 看门狗触发：另一个会话被归一为 failed，onReport 送来它的 failed 汇报。
    const killed = child({ id: "super-b", status: "failed", error: "子会话运行中无响应超时" });
    manager.list = () => [doneA, killed];
    p.queueSuperReport([
      { session: killed, report: { state: "failed", summary: "子会话运行中无响应超时", at: 2 } },
    ]);
    await flush();

    // A 那条仍在队列首位（没有被这次 settle 清掉），B 追加在后。
    expect(p.pendingSuperReportPrompts.map((item) => item.text)).toEqual([
      expect.stringContaining("A 完成"),
      expect.stringContaining("无响应超时"),
    ]);
  });

  it("已 in-flight 的汇报来源被清理时：不以「已归档迟到结论」重复提示，也不重复入队", async () => {
    const toasts: string[] = [];
    vi.spyOn(p.store, "sendToast").mockImplementation(((...args: unknown[]) => {
      toasts.push(String(args[1]));
      return 1;
    }) as unknown as PanelInternals["store"]["sendToast"]);

    const doneA = child({ id: "super-a", status: "completed", summary: "A 完成" });
    manager.list = () => [doneA];
    p.store.replaceState({ ...p.store.getState(), status: "streaming" });
    p.queueSuperReport([{ session: doneA, report: { state: "ready", summary: "A 完成", at: 1 } }]);
    await flush();
    // 已入队 = 已标 in-flight。
    expect(p.pendingSuperReportPrompts).toHaveLength(1);

    // 来源被清理（list 里没了）：takeMissing 必须跳过 in-flight 条目，
    // 否则同一条汇报会既走 hidden 回合、又弹一条「已归档迟到结论」。
    manager.list = () => [];
    p.refreshSuperWaitHeartbeat();
    await flush();

    expect(toasts.some((text) => text.includes("已归档"))).toBe(false);
    expect(p.pendingSuperReportPrompts).toHaveLength(1);
  });
});
