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
});
