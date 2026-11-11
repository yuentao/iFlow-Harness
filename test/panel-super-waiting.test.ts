/**
 * 等待子会话汇报期间的会话状态（宿主侧）。
 *
 * 用户原话：「主会话等待子会话汇报和处理汇报时的状态应该是(正在生成)状态，
 * 不应该出现无状态……但是这个过程中用户应该可以继续发送消息并且主会话会进行
 * 响应」—— 等待期点顶栏「新会话」会把排队里的汇报落到已被替换的会话上。
 *
 * 三条要求：
 *  1. 等待期面板呈现忙碌态，但**不改** `status`：改成 "streaming" 会让
 *     `sendPrompt` 把用户消息派发成子会话（违反「主会话会进行响应」），
 *     `mainSessionFree()` 也会永远判不空闲，汇报再也投不出去（死锁）。
 *     所以用正交的 `superWaiting` 标记承载忙碌态。
 *  2. 汇报真正开跑的那一轮是正常的 "streaming"（hidden 回合不写用户块，
 *     状态必须显式翻开，否则那一轮同样是「无状态」）。
 *  3. 等待期点「新会话」（webview 按钮 + 命令面板 iflow.newSession）被拒绝，
 *     给出明确提示，且排队里的汇报一条都不丢。
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

type PromptCall = {
  prompt: Array<{ type: string; text?: string }>;
  resolve: (v: { stopReason: string }) => void;
};

/** 子会话 id → 面板看到的看板投影。 */
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

type FakeManager = {
  list: (mainSessionId?: string | null) => SuperSessionUi[];
  reportPrompt: (entries: Array<{ session: SuperSessionUi }>) => string;
  spawn: ReturnType<typeof vi.fn>;
};

/** 宿主看到的子会话管理器（只需要这三个成员）。 */
function makeManager(children: SuperSessionUi[]): FakeManager {
  return {
    list: () => children,
    reportPrompt: (entries) => entries.map((e) => `【汇报】${e.session.title}`).join("\n"),
    spawn: vi.fn(() => ({ id: "super-spawned" })),
  };
}

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
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  refreshSuperWaitHeartbeat: () => void;
  queueSuperReport: (entries: Array<{ session: SuperSessionUi; report: SuperReport }>) => void;
  pendingSuperReportPrompts: string[];
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: SessionState) => void;
    appendNotice: (text: string) => void;
    sendToast: (...args: unknown[]) => number;
  };
};

describe("ChatPanel 等待子会话汇报期间的状态", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let notices: string[];
  let manager: FakeManager;

  beforeEach(() => {
    // checkpoint 会拉真实 git 子进程；这里只测状态机，关掉。
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superwaiting-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    notices = [];
    manager = makeManager([child()]);
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
    vi.spyOn(p.store, "appendNotice").mockImplementation(((text: string) => {
      notices.push(text);
    }) as PanelInternals["store"]["appendNotice"]);
    p.store.sessionStarted({ sessionId: "sw-session" });
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

  it("等待期：忙碌标记为 true，但 status 仍是 idle（等待期用户还能发消息）", () => {
    manager.list = () => [child({ status: "running" })];
    p.refreshSuperWaitHeartbeat();

    expect(p.store.getState().superWaiting).toBe(true);
    // 关键：status 不能变成 "streaming" —— 那样用户消息会被派发成子会话，
    // 汇报也永远投不出去。
    expect(p.store.getState().status).toBe("idle");
  });

  it("等待期用户消息仍由主会话响应（不会被派发成子会话）", async () => {
    manager.list = () => [child({ status: "running" })];
    p.refreshSuperWaitHeartbeat();
    expect(p.store.getState().superWaiting).toBe(true);

    const turn = p.handleWebviewMessage({ type: "sendPrompt", text: "继续推进剩下的部分" });
    await flush();

    // 主会话收到了这条消息（prompt 走主会话的 CLI）。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("继续推进剩下的部分");
    // 没有被派发成子会话。
    expect(manager.spawn).not.toHaveBeenCalled();

    calls[0]!.resolve({ stopReason: "end_turn" });
    await turn;
    await flush();

    // 这一轮结束后子会话还在跑 → 忙碌态要重新出现（不能随 streaming→idle 丢掉）。
    expect(p.store.getState().status).toBe("idle");
    expect(p.store.getState().superWaiting).toBe(true);
  });

  it("汇报开跑那一轮：status 变 streaming；全部终态后回到 idle 且忙碌标记清掉", async () => {
    // 子会话全部结束 → 汇报入队 → 宿主把它当一次 hidden prompt 投给主会话。
    const done = child({ status: "completed", summary: "登录跳转已修好" });
    manager.list = () => [done];
    p.queueSuperReport([{ session: done, report: READY_REPORT }]);
    await flush();

    // 汇报那一轮是正常的 streaming（生成中）。
    expect(p.store.getState().status).toBe("streaming");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("修好登录跳转");
    // 汇报回合期间忙碌态同样成立（「新会话」不能点）。
    expect(p.store.getState().superWaiting).toBe(true);

    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();

    // 全部终态且汇报已投出 → 回到 idle，忙碌态消失。
    expect(p.store.getState().status).toBe("idle");
    expect(p.store.getState().superWaiting).toBe(false);
    expect(p.pendingSuperReportPrompts).toHaveLength(0);
  });

  it("等待期点「新会话」（webview 路径）：被拒绝、给出提示、排队里的汇报不丢", async () => {
    const done = child({ status: "completed", summary: "登录跳转已修好" });
    manager.list = () => [done];
    // 汇报已备好、还没投出去（主会话此刻不空闲）。
    p.pendingSuperReportPrompts = ["【汇报】修好登录跳转"];
    p.store.replaceState({ ...p.store.getState(), status: "idle" });
    p.refreshSuperWaitHeartbeat();
    expect(p.store.getState().superWaiting).toBe(true);

    const before = p.store.getState().sessionId;
    await p.handleWebviewMessage({ type: "newSession" });

    // 被拒绝：会话没换、也没抛异常。
    expect(p.store.getState().sessionId).toBe(before);
    expect(notices.some((n) => n.includes("子会话"))).toBe(true);
    // 排队里的汇报一条都没丢。
    expect(p.pendingSuperReportPrompts).toHaveLength(1);
    expect(p.pendingSuperReportPrompts[0]).toContain("修好登录跳转");
  });

  it("等待期点「新会话」（命令面板 iflow.newSession 路径）：同样被拒绝", async () => {
    manager.list = () => [child({ status: "running" })];
    p.refreshSuperWaitHeartbeat();
    expect(p.store.getState().superWaiting).toBe(true);

    const before = p.store.getState().sessionId;
    // 命令面板的 iflow.newSession 就是把 { type: "newSession" } 投给面板，
    // 与顶栏按钮同一条入口 —— 所以这里覆盖的就是命令面板那条路。
    await p.handleWebviewMessage({ type: "newSession" });

    expect(p.store.getState().sessionId).toBe(before);
    expect(notices.some((n) => n.includes("子会话"))).toBe(true);
  });

  it("子会话被清理后批次门槛才成立：心跳补一次重算把汇报投出去，不卡在忙碌态", async () => {
    // A 已终态并上报，B 还在跑 → 批次凑不齐，先攒着。
    const a = child({ id: "super-a", status: "completed", summary: "A 完成" });
    const b = child({ id: "super-b", status: "running" });
    manager.list = () => [a, b];
    p.queueSuperReport([{ session: a, report: READY_REPORT }]);
    await flush();
    expect(p.store.getState().superWaiting).toBe(true);
    expect(calls).toHaveLength(0);

    // B 被用户清理（不再出现，也不会再上报）→ 门槛成立，但没有任何 onReport
    // 会再来触发取批次；心跳必须补这一次重算。
    manager.list = () => [a];
    p.refreshSuperWaitHeartbeat();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("【汇报】");

    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();
    expect(p.store.getState().superWaiting).toBe(false);
  });

  it("来源子会话全被清理：无从投递的汇报被丢弃，忙碌态不残留", async () => {
    const a = child({ id: "super-a", status: "completed", summary: "A 完成" });
    const b = child({ id: "super-b", status: "running" });
    manager.list = () => [a, b];
    p.queueSuperReport([{ session: a, report: READY_REPORT }]);
    await flush();
    expect(p.store.getState().superWaiting).toBe(true);

    // 两个子会话都被清理掉了：A 的汇报还欠在缓冲里，但已经没有会话可投。
    manager.list = () => [];
    p.refreshSuperWaitHeartbeat();
    await flush();

    expect(calls).toHaveLength(0);
    expect(p.pendingSuperReportPrompts).toHaveLength(0);
    expect(p.store.getState().superWaiting).toBe(false);
  });
});
