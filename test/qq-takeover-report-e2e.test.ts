/**
 * 回归复现：任务进行中才开启远程接续，QQ 只收到「主会话已汇报超流体结果」
 * 短提醒，收不到完整汇报正文（用户 2026-11-22 报告「之前修过、现在又出现」）。
 *
 * 已查证链路（git 历史：be79be5 修通知全丢、caba3dc 修完整正文，代码至今全在
 * HEAD，无 revert —— 是运行态绕过，不是代码被改坏）：
 *   panel.ts finalReport 收尾块计算
 *     awaitedHere = [...qqMainFinalAwaiters.values()].includes(promptSessionId)
 *   仅当 `!awaitedHere && qqTakeoverActive` 才 forwardTakeoverReport(正文)。
 *   若该 session 已登记 QQ awaiter（awaitedHere=true），正文补投被跳过，
 *   takeoverReportSent 保持 false → 落回 announceSuperReport(短文案)
 *     → announceCue("superReport") → 接管态改投 forwardTakeoverCue → notifyBoundUser(短文案)。
 *   而正文只走 deliverQqMainFinalAnswer 的任务通道 completeMainFinalAnswer，
 *   本地发起的任务没有 QQ 归属 → QQ 私聊里看到的只有那句状态语。
 *
 * 本测试构造 awaitedHere=true 的本地汇报轮，断言 notifyBoundUser 收到含完整正文
 * （带「（完整结果请在面板查看）」）的消息。当前未修复代码上必须 FAIL。
 */
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? store.get(key) : defaultValue) as T,
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
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
  } as unknown as vscode.ExtensionContext;
}

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type Internals = {
  handleWebviewMessage: (msg: unknown) => Promise<void>;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: unknown,
  ) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  sendPrompt: (
    text: string,
    images?: unknown,
    files?: unknown,
    contexts?: unknown,
    options?: {
      hidden?: boolean;
      reportTurn?: boolean;
      finalReport?: boolean;
      finalFallbackText?: string;
    },
  ) => Promise<boolean>;
  postToWebview: (msg: unknown) => void;
  pushQqState: () => void;
  qqTakeoverActive: boolean;
  qqInjectedTaskId: string | null;
  qqMainFinalAwaiters: Map<string, string>;
  superAgent: unknown;
  deliverQqMainFinalAnswer: (
    sessionId: string | null,
    text: string,
    stopReason: string,
    onlyTaskIds?: ReadonlySet<string>,
    fallbackText?: string,
  ) => Promise<void>;
  store: {
    getState: () => { sessionId: string | null; [key: string]: unknown };
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: unknown) => void;
  };
  qq?: {
    service?: {
      completeMainFinalAnswer?: (input: {
        taskId: string;
        text: string;
        stopReason?: string;
      }) => Promise<void>;
      notifyBoundUser?: (text: string) => Promise<boolean>;
    };
  };
};

describe("QQ 接管态：awaiter 已登记时完整汇报正文仍须投递", () => {
  let panel: ChatPanel;
  let p: Internals;
  let iflowHome: string;
  let storageDir: string;

  beforeEach(async () => {
    iflowHome = await mkdtemp(path.join(os.tmpdir(), "iflow-takeover-report-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-takeover-report-store-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as Internals;
    const realGetState = p.store.getState.bind(p.store);
    vi.spyOn(p.store, "getState").mockImplementation(() => ({ ...realGetState(), sessionId: "s1" }) as never);
    vi.spyOn(p, "postToWebview").mockImplementation(() => {});
    vi.spyOn(p, "pushQqState").mockImplementation(() => {});
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
  });

  afterEach(async () => {
    await panel.dispose();
    await rm(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    delete process.env.IFLOW_HOME;
    vi.restoreAllMocks();
  });

  it("本地汇报轮 + 中途开启接续 + 该 session 已登记 awaiter：QQ 必须收到完整正文而非只有状态语", async () => {
    const complete = vi.fn(async () => {});
    const notifyBoundUser = vi.fn(async () => true);
    p.qq = { service: { completeMainFinalAnswer: complete, notifyBoundUser } };

    // 关键触发条件：该 session 已登记 QQ awaiter → awaitedHere=true。
    p.qqMainFinalAwaiters.set("task-existing", "s1");
    expect(p.qqMainFinalAwaiters.get("task-existing")).toBe("s1");

    p.superAgent = { list: () => [] };
    p.ensureClient = async () => ({});
    const pending: Array<(v: { stopReason: string }) => void> = [];
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, _prompt: unknown) =>
        new Promise<{ stopReason: string }>((resolve) => pending.push(resolve)),
    ) as unknown as Internals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.store.sessionStarted({ sessionId: "s1" });
    p.store.replaceState({ ...p.store.getState(), status: "idle", blocks: [] });

    // 任务进行中才开启远程接续。
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    expect(p.qqTakeoverActive).toBe(true);
    // 本地发起的任务：没有 QQ 注入 taskId。
    expect(p.qqInjectedTaskId).toBeNull();

    const fallback = "修好登录跳转：改动 src/auth.ts，npx vitest run 全绿";
    const started = p.sendPrompt("【汇报】超流体完成", undefined, undefined, undefined, {
      hidden: true,
      reportTurn: true,
      finalReport: true,
      finalFallbackText: fallback,
    });
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(pending).toHaveLength(1);
    pending[0]?.({ stopReason: "end_turn" });
    await started;

    // awaiter 走任务通道投递（正文只到 completeMainFinalAnswer，私聊看不到）。
    expect(complete).toHaveBeenCalled();

    // 核心断言：无论 awaitedHere 是否为 true，接管态私聊都必须收到完整正文。
    // 未修复代码上 awaitedHere=true → forwardTakeoverReport 被跳过 → 这里 FAIL。
    const delivered = notifyBoundUser.mock.calls.map((c) => c[0] as string);
    expect(
      delivered.some(
        (text) => text.includes(fallback) && text.includes("完整结果请在面板查看"),
      ),
      `notifyBoundUser 实际收到：${JSON.stringify(delivered)}`,
    ).toBe(true);
  });
});
