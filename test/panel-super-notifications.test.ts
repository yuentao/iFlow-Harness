/**
 * 完成提示音 / 系统通知在 Super Agent 下的分档（宿主侧）。
 *
 * 用户原话（截图）：一个子会话汇报回来就弹一次「iFlow 已完成本轮回复」并响一次
 * 铃 —— 汇报是逐个投给主会话的 hidden 回合，逐个提示等于把「一个子会话干完」
 * 误报成「整件事做完了」。
 *
 * 第二轮（用户实测 2026-11-15）：**偶尔突然响铃，界面上却没有任何通知**。根因
 * 是提示仍挂在 hidden 回合收尾上：hidden 回合不止汇报，还有动作回执（子会话早
 * 已全部终态时也会跑一轮），于是每份回执都响一次铃并宣称「子会话已全部结束」
 * —— 那件事早就发生过；同一句文案又被 60s 内容冷却吞掉，只剩铃声。
 *
 * 现行契约：
 *  1. hidden 回合（汇报 / 动作回执）**永远不响铃、不弹通知** —— 它是宿主记账，
 *     不是用户的回合。
 *  2. 「子会话已全部结束」只挂在**真实事件**上：非终态子会话数从 >0 掉到 0 的
 *     那一刻提示一次（`syncSuperWaitingState` 驱动），心跳重复刷新不会重复响。
 *  3. 非 hidden 的用户回合保持原文案「iFlow 已完成本轮回复」，不因有子会话在跑
 *     而被静音（那是用户自己的回合）。
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
  superSettledAnnounced: boolean;
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
    options?: { internal?: boolean; delegateOnBusy?: boolean; hidden?: boolean },
  ) => Promise<boolean>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  notifyOs: (event: string, text: string) => boolean;
  notifyOsDecision: (event: string, text: string) => OsNotifyDecision;
  postSound: (kind: "done" | "error") => void;
  syncSuperWaitingState: () => void;
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: SessionState) => void;
  };
};

describe("Super Agent 回合的完成提示", () => {
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

  async function runHiddenTurn(text: string): Promise<void> {
    const started = p.sendPrompt(text, undefined, undefined, undefined, {
      hidden: true,
      delegateOnBusy: false,
    });
    const call = await waitForPrompt();
    call.resolve({ stopReason: "end_turn" });
    await started;
  }

  it("hidden 汇报回合 + 仍有子会话在跑：完全静音", async () => {
    children = [child({ status: "running" })];
    const { notify, sound } = spyCues();

    await runHiddenTurn("【汇报】子会话 A 完成");

    expect(notify).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
  });

  it("hidden 汇报回合 + 子会话全部终态：仍然静音（提示改挂在收尾事件上）", async () => {
    children = [child({ status: "completed", summary: "做完了" })];
    const { notify, sound } = spyCues();

    await runHiddenTurn("【汇报】子会话 A 完成");

    expect(notify).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
  });

  it("hidden 动作回执回合（子会话早已全部终态）不响铃 —— 「突然响铃但没有通知」的回归", async () => {
    // 动作回执与汇报共用同一条 hidden 通道。旧实现按「此刻还有没有子会话
    // 在跑」判断，于是每份回执都响一次铃并宣称「子会话已全部结束」（事件早
    // 已发生，文案又被 60s 内容冷却吞掉）—— 用户只听到铃，界面上什么都没有。
    children = [child({ status: "completed" }), child({ id: "super-2", status: "cancelled" })];
    const { notify, sound } = spyCues();

    await runHiddenTurn("【动作回执】已按指令清理子会话：成功 1 个");

    expect(notify).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
  });

  it("非 hidden 的用户回合：仍提示「iFlow 已完成本轮回复」，不因有子会话在跑而静音", async () => {
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

  it("子会话全部收尾的那一刻提示一次「子会话已全部结束」，心跳重复刷新不重复响", () => {
    const { notify, sound } = spyCues();
    children = [child({ status: "running" })];
    p.syncSuperWaitingState();
    expect(sound).not.toHaveBeenCalled();

    // 子会话收尾：状态变化驱动同一次同步。
    children = [child({ status: "completed", summary: "做完了" })];
    p.syncSuperWaitingState();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("turnDone", "子会话已全部结束");
    expect(sound).toHaveBeenCalledTimes(1);
    expect(sound).toHaveBeenCalledWith("done");

    // 心跳（1.5s 一次）与其它看板刷新会反复调它：同一次结束只提示一次。
    p.syncSuperWaitingState();
    p.syncSuperWaitingState();
    expect(sound).toHaveBeenCalledTimes(1);
  });

  it("新一批子会话开跑后重置标记，下一批结束还能再提示一次", () => {
    const { sound } = spyCues();
    children = [child({ status: "running" })];
    p.syncSuperWaitingState();
    children = [child({ status: "completed" })];
    p.syncSuperWaitingState();
    expect(sound).toHaveBeenCalledTimes(1);

    children = [child({ status: "completed" }), child({ id: "super-2", status: "running" })];
    p.syncSuperWaitingState();
    children = [child({ status: "completed" }), child({ id: "super-2", status: "completed" })];
    p.syncSuperWaitingState();
    expect(sound).toHaveBeenCalledTimes(2);
  });

  it("还在等用户回答的子会话不算「全部结束」", () => {
    const { sound } = spyCues();
    children = [child({ status: "awaiting_input" })];
    p.syncSuperWaitingState();
    p.syncSuperWaitingState();
    expect(sound).not.toHaveBeenCalled();
  });

  it("被中断（cancelled）也算终态：最后一个子会话被中断时提示一次", () => {
    const { notify, sound } = spyCues();
    children = [child({ status: "running" })];
    p.syncSuperWaitingState();
    children = [child({ status: "cancelled" })];
    p.syncSuperWaitingState();
    expect(notify).toHaveBeenCalledWith("turnDone", "子会话已全部结束");
    expect(sound).toHaveBeenCalledWith("done");
  });
});