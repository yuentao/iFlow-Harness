/**
 * 完成提示在 Super Agent 下的分档（宿主侧）。
 *
 * 历史：第一版把「一个子会话汇报回来」当成「整轮完成」弹「iFlow 已完成本轮
 * 回复」；第二版改成 hidden 回合一律静音、只在「非终态数 >0 掉到 0」时提示
 * 「子会话已全部结束」—— 那仍然与用户回合共用 turnDone 事件和 done 音，而且
 * 聚合判定让「子会话干完」与「主会话干完」在通知通道上无法区分。
 *
 * 现行契约（2026-11-16 用户确认的粒度）：
 *  1. **每个子会话**从非终态迁移到终态（completed / failed / cancelled）各提示
 *     一次：事件 `childDone`、音色 `child`、文案「子会话「{0}」已完成/已失败/
 *     已中断」。首次看到就终态（恢复归档）、awaiting_input、重复 sync 都不提示。
 *  2. 主会话**汇报回合**（hidden + reportTurn）收尾：事件 `superReport`、音色
 *     `done`、文案「主会话已汇报子会话结果」；`cancelled` 不提示。
 *  3. 动作回执 / 被改道用户消息补投的 hidden 回合仍然完全静音。
 *  4. 非 hidden 的用户回合保持「iFlow 已完成本轮回复」+ done 音，不变。
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
import type { SuperSessionUi } from "../shared/super-agent.js";
import type { OsNotifyDecision } from "../shared/notifications.js";

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

type FakeManager = {
  list: (mainSessionId?: string | null) => SuperSessionUi[];
};

type PromptCall = {
  prompt: Array<{ type: string; text?: string }>;
  resolve: (v: { stopReason: string }) => void;
};

type PanelInternals = {
  superAgent: unknown;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: unknown,
  ) => Promise<{ stopReason: string }>;
  sendPrompt: (
    text: string,
    images?: unknown,
    files?: unknown,
    contexts?: unknown,
    options?: { internal?: boolean; delegateOnBusy?: boolean; hidden?: boolean; reportTurn?: boolean },
  ) => Promise<boolean>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  notifyOsDecision: (event: string, text: string) => OsNotifyDecision;
  postSound: (kind: "done" | "error" | "child") => void;
  syncSuperWaitingState: () => void;
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: SessionState) => void;
  };
};

describe("Super Agent 完成提示：子会话 / 主会话汇报分档", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let manager: FakeManager;
  let children: SuperSessionUi[];

  beforeEach(() => {
    // checkpoint 会拉真实 git 子进程；回合末跟进的网关调用也必须关掉。
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-supernotify-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    children = [];
    manager = { list: () => children };
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
    p.store.sessionStarted({ sessionId: "notify-session" });
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

  /** 等回合真正跑到 promptWithRetry（中间有几个 await 窗口）。 */
  async function waitForPrompt(): Promise<PromptCall> {
    for (let i = 0; i < 100 && calls.length === 0; i += 1) await flush();
    const call = calls[0];
    if (!call) throw new Error("prompt never started");
    return call;
  }

  /** 把通知判定固定成「用户在看」：系统通知不发，但铃声响（转录/卡片在眼前）。 */
  function spyCues(): {
    notify: ReturnType<typeof vi.spyOn>;
    sound: ReturnType<typeof vi.spyOn>;
  } {
    return {
      notify: vi.spyOn(p, "notifyOsDecision").mockImplementation((event: string, text: string) => {
        void event;
        void text;
        return { fire: false, gate: { lastFiredAt: {} }, reason: "watching" };
      }),
      sound: vi.spyOn(p, "postSound").mockImplementation(() => {}),
    };
  }

  async function runHiddenTurn(
    text: string,
    options: { reportTurn?: boolean } = {},
  ): Promise<void> {
    calls = [];
    const started = p.sendPrompt(text, undefined, undefined, undefined, {
      hidden: true,
      delegateOnBusy: false,
      ...options,
    });
    const call = await waitForPrompt();
    call.resolve({ stopReason: "end_turn" });
    await started;
  }

  // ── 主会话汇报回合 ────────────────────────────────────────────────────────

  it("hidden 汇报回合（reportTurn）→ superReport 事件 + done 音", async () => {
    children = [child({ status: "completed", summary: "做完了" })];
    const { notify, sound } = spyCues();

    await runHiddenTurn("【汇报】子会话 A 完成", { reportTurn: true });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("superReport", "主会话已汇报子会话结果");
    expect(sound).toHaveBeenCalledTimes(1);
    expect(sound).toHaveBeenCalledWith("done");
  });

  it("hidden 汇报回合被用户停止（cancelled）→ 不提示", async () => {
    const { notify, sound } = spyCues();
    const started = p.sendPrompt("【汇报】子会话 A 完成", undefined, undefined, undefined, {
      hidden: true,
      delegateOnBusy: false,
      reportTurn: true,
    });
    const call = await waitForPrompt();
    call.resolve({ stopReason: "cancelled" });
    await started;

    expect(notify).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
  });

  it("hidden 动作回执回合（无 reportTurn）完全静音", async () => {
    // 动作回执与汇报共用同一条 hidden 通道，但它是宿主记账、不是汇报 ——
    // 用户既没有新气泡，也没有新结果可看。
    children = [child({ status: "completed" }), child({ id: "super-2", status: "cancelled" })];
    const { notify, sound } = spyCues();

    await runHiddenTurn("【动作回执】已按指令清理子会话：成功 1 个");

    expect(notify).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
  });

  it("hidden 回合不误触发被改道用户消息的补投（也不伪造用户气泡）", async () => {
    const internals = p as unknown as { pendingDelegatedUserTurns: unknown[] };
    // runHiddenTurn 显式传 undefined 附件 + delegateOnBusy:false —— 它是宿主
    // 记账回合，不是「streaming 中被改道的用户消息」，不该进补投缓冲。
    await runHiddenTurn("【汇报】子会话 A 完成", { reportTurn: true });
    await flush();
    expect(calls).toHaveLength(1); // 只有这一轮 hidden prompt，没有补投出来的第二轮
    expect(internals.pendingDelegatedUserTurns).toHaveLength(0);
    expect(p.store.getState().blocks.filter((b) => b.kind === "user")).toHaveLength(0);
  });

  it("非 hidden 的用户回合：仍提示「iFlow 已完成本轮回复」+ done 音", async () => {
    children = [child({ status: "running" })];
    const { notify, sound } = spyCues();

    const started = p.sendPrompt("继续推进剩下的部分");
    const call = await waitForPrompt();
    call.resolve({ stopReason: "end_turn" });
    await started;

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("turnDone", "iFlow 已完成本轮回复");
    expect(sound).toHaveBeenCalledTimes(1);
    expect(sound).toHaveBeenCalledWith("done");
  });

  // ── 单个子会话收尾 ───────────────────────────────────────────────────────

  it("子会话 running → completed：提示一次 childDone + child 音", () => {
    const { notify, sound } = spyCues();
    children = [child({ status: "running" })];
    p.syncSuperWaitingState();
    expect(sound).not.toHaveBeenCalled();

    children = [child({ status: "completed", summary: "做完了" })];
    p.syncSuperWaitingState();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("childDone", "子会话「修好登录跳转」已完成");
    expect(sound).toHaveBeenCalledTimes(1);
    expect(sound).toHaveBeenCalledWith("child");
  });

  it("重复 sync（心跳每 1.5s 一次）不重复提示", () => {
    const { sound } = spyCues();
    children = [child({ status: "running" })];
    p.syncSuperWaitingState();
    children = [child({ status: "completed" })];
    p.syncSuperWaitingState();
    p.syncSuperWaitingState();
    p.syncSuperWaitingState();
    expect(sound).toHaveBeenCalledTimes(1);
  });

  it("新子会话开跑后再完成会再提示一次（按子会话逐个提示）", () => {
    const { notify, sound } = spyCues();
    children = [child({ status: "running" })];
    p.syncSuperWaitingState();
    children = [child({ status: "completed" })];
    p.syncSuperWaitingState();
    expect(sound).toHaveBeenCalledTimes(1);

    children = [child({ status: "completed" }), child({ id: "super-2", status: "running", title: "第二个" })];
    p.syncSuperWaitingState();
    children = [
      child({ status: "completed" }),
      child({ id: "super-2", status: "completed", title: "第二个" }),
    ];
    p.syncSuperWaitingState();
    expect(sound).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith("childDone", "子会话「第二个」已完成");
  });

  it("两个子会话先后完成：各提示一次（不是等到全部结束才提示）", () => {
    const { notify, sound } = spyCues();
    children = [
      child({ status: "running", title: "A" }),
      child({ id: "super-2", status: "running", title: "B" }),
    ];
    p.syncSuperWaitingState();
    expect(sound).not.toHaveBeenCalled();

    children = [
      child({ status: "completed", title: "A" }),
      child({ id: "super-2", status: "running", title: "B" }),
    ];
    p.syncSuperWaitingState();
    expect(notify).toHaveBeenLastCalledWith("childDone", "子会话「A」已完成");
    expect(sound).toHaveBeenCalledTimes(1);

    children = [
      child({ status: "completed", title: "A" }),
      child({ id: "super-2", status: "completed", title: "B" }),
    ];
    p.syncSuperWaitingState();
    expect(notify).toHaveBeenLastCalledWith("childDone", "子会话「B」已完成");
    expect(sound).toHaveBeenCalledTimes(2);
    expect(sound).toHaveBeenNthCalledWith(1, "child");
    expect(sound).toHaveBeenNthCalledWith(2, "child");
  });

  it("恢复归档 / 首次看到就已是终态：不提示", () => {
    const { notify, sound } = spyCues();
    // 恢复的归档里子会话早已终态 —— 那是过期事实，不是「刚刚结束」。
    children = [child({ status: "completed" }), child({ id: "super-2", status: "failed" })];
    p.syncSuperWaitingState();
    p.syncSuperWaitingState();
    expect(notify).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
  });

  it("awaiting_input 不是完成：不提示", () => {
    const { sound } = spyCues();
    children = [child({ status: "awaiting_input" })];
    p.syncSuperWaitingState();
    children = [child({ status: "awaiting_input" })];
    p.syncSuperWaitingState();
    expect(sound).not.toHaveBeenCalled();
  });

  it("failed / cancelled 的文案分别正确", () => {
    const { notify, sound } = spyCues();
    children = [child({ status: "running", title: "失败的那个" })];
    p.syncSuperWaitingState();
    children = [child({ status: "failed", title: "失败的那个" })];
    p.syncSuperWaitingState();
    expect(notify).toHaveBeenLastCalledWith("childDone", "子会话「失败的那个」已失败");
    expect(sound).toHaveBeenLastCalledWith("child");

    children = [
      child({ status: "failed", title: "失败的那个" }),
      child({ id: "super-2", status: "running", title: "被中断的那个" }),
    ];
    p.syncSuperWaitingState();
    children = [
      child({ status: "failed", title: "失败的那个" }),
      child({ id: "super-2", status: "cancelled", title: "被中断的那个" }),
    ];
    p.syncSuperWaitingState();
    expect(notify).toHaveBeenLastCalledWith("childDone", "子会话「被中断的那个」已中断");
    expect(sound).toHaveBeenCalledTimes(2);
  });

  it("子会话从看板消失后清掉记录，同 id 再次出现不会当成「刚刚结束」", () => {
    const { sound } = spyCues();
    children = [child({ status: "running" })];
    p.syncSuperWaitingState();
    children = [child({ status: "completed" })];
    p.syncSuperWaitingState();
    expect(sound).toHaveBeenCalledTimes(1);

    // 清理掉（从 list 消失）：记录被剪掉。
    children = [];
    p.syncSuperWaitingState();
    // 同一个 id 再次出现且已是终态：首次看到，不提示。
    children = [child({ status: "completed" })];
    p.syncSuperWaitingState();
    expect(sound).toHaveBeenCalledTimes(1);
  });

  // ── 核心需求：两类完成信号必须不同 ────────────────────────────────────────

  it("childDone 与 superReport 是两个不同事件、不同提示音", async () => {
    const { notify, sound } = spyCues();
    children = [child({ status: "running", title: "子任务" })];
    p.syncSuperWaitingState();
    children = [child({ status: "completed", title: "子任务" })];
    p.syncSuperWaitingState();

    expect(notify).toHaveBeenLastCalledWith("childDone", "子会话「子任务」已完成");
    expect(sound).toHaveBeenLastCalledWith("child");

    await runHiddenTurn("【汇报】子会话 A 完成", { reportTurn: true });

    expect(notify).toHaveBeenLastCalledWith("superReport", "主会话已汇报子会话结果");
    expect(sound).toHaveBeenLastCalledWith("done");

    const events = notify.mock.calls.map((call) => call[0]);
    expect(events).toContain("childDone");
    expect(events).toContain("superReport");
    expect(events[0]).not.toBe(events[events.length - 1]);
  });
});
