/**
 * 完成提示音 / 系统通知在 Super Agent 下的分档（宿主侧）。
 *
 * 用户原话（截图）：一个子会话汇报回来就弹一次「iFlow 已完成本轮回复」并响一次
 * 铃 —— 汇报是逐个投给主会话的 hidden 回合，逐个提示等于把「一个子会话干完」
 * 误报成「整件事做完了」。
 *
 * 三条要求：
 *  1. hidden 汇报回合完成时，只要**还有非终态子会话**，就完全静音（不弹通知、
 *     不响铃）。
 *  2. hidden 回合完成且已无运行中的子会话 → 只提示一次「子会话已全部结束」。
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
    options?: { internal?: boolean; delegateOnBusy?: boolean; hidden?: boolean },
  ) => Promise<boolean>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  notifyOs: (event: string, text: string) => boolean;
  postSound: (kind: "done" | "error") => void;
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
    manager = { list: () => [] };
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

  function spyCues(): {
    notify: ReturnType<typeof vi.spyOn>;
    sound: ReturnType<typeof vi.spyOn>;
  } {
    return {
      notify: vi.spyOn(p, "notifyOs").mockImplementation(() => true),
      sound: vi.spyOn(p, "postSound").mockImplementation(() => {}),
    };
  }

  it("hidden 汇报回合 + 仍有子会话在跑：完全静音", async () => {
    manager.list = () => [child({ status: "running" })];
    const { notify, sound } = spyCues();

    const started = p.sendPrompt("【汇报】子会话 A 完成", undefined, undefined, undefined, {
      hidden: true,
      delegateOnBusy: false,
    });
    const call = await waitForPrompt();
    call.resolve({ stopReason: "end_turn" });
    await started;

    expect(notify).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
  });

  it("hidden 汇报回合 + 子会话全部结束：只提示一次「子会话已全部结束」", async () => {
    manager.list = () => [child({ status: "completed", summary: "做完了" })];
    const { notify, sound } = spyCues();

    const started = p.sendPrompt("【汇报】子会话 A 完成", undefined, undefined, undefined, {
      hidden: true,
      delegateOnBusy: false,
    });
    const call = await waitForPrompt();
    call.resolve({ stopReason: "end_turn" });
    await started;

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("turnDone", "子会话已全部结束");
    expect(sound).toHaveBeenCalledTimes(1);
    expect(sound).toHaveBeenCalledWith("done");
  });

  it("非 hidden 的用户回合：仍提示「iFlow 已完成本轮回复」，不因有子会话在跑而静音", async () => {
    manager.list = () => [child({ status: "running" })];
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
});
