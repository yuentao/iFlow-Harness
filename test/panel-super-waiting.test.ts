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
  client: unknown;
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
  onSessionUpdate: (n: unknown) => void;
  refreshSuperWaitHeartbeat: () => void;
  syncSuperWaitingState: () => void;
  updateStatusBar: (state: SessionState) => void;
  statusBar: { text: string; tooltip: string };
  autoTurnsStoppedFor: string | null;
  announceDeferredAutoTurns: () => void;
  clearDeferredAutoTurnsToast: () => void;
  handleToastAction: (actionId: string, toastId?: number) => void;
  queueSuperReport: (entries: Array<{ session: SuperSessionUi; report: SuperReport }>) => void;
  drainSuperReports: () => Promise<void>;
  pendingSuperReportPrompts: Array<{ mainSessionId: string | null; text: string }>;
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: SessionState) => void;
    appendNotice: (text: string) => void;
    sendToast: (...args: unknown[]) => number;
    dismissToast: (id: number) => void;
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
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    p.pendingSuperReportPrompts = [{ mainSessionId: "sw-session", text: "【汇报】修好登录跳转" }];
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
    expect(p.pendingSuperReportPrompts[0]?.text).toContain("修好登录跳转");
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

  it("逐个终态即汇报：已结束的那个先交，不必等还在跑的那个", async () => {
    const a = child({ id: "super-a", status: "completed", summary: "A 完成" });
    const b = child({ id: "super-b", status: "running" });
    manager.list = () => [a, b];
    p.queueSuperReport([{ session: a, report: READY_REPORT }]);
    await flush();
    // A 已终态 → 立刻交一次汇报（B 还在跑，不影响这一轮）。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("【汇报】");
    // 还有子会话在跑 → 面板保持忙碌态。
    expect(p.store.getState().superWaiting).toBe(true);

    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();
    expect(p.store.getState().superWaiting).toBe(true);

    // B 也结束了 → 再交一次汇报。
    const doneB = child({ id: "super-b", status: "completed", summary: "B 完成" });
    manager.list = () => [a, doneB];
    p.queueSuperReport([{ session: doneB, report: READY_REPORT }]);
    await flush();
    expect(calls).toHaveLength(2);

    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();
    // 全部终态且汇报都投出去了 → 忙碌态消失。
    expect(p.store.getState().superWaiting).toBe(false);
  });

  it("用户按停止后：排队的子会话汇报不会立刻接上，下一条消息后才继续", async () => {
    const done = child({ status: "completed", summary: "登录跳转已修好" });
    manager.list = () => [done];

    // 一轮用户回合正在跑。
    const turn = p.handleWebviewMessage({ type: "sendPrompt", text: "跑个长任务" });
    await flush();
    expect(p.store.getState().status).toBe("streaming");
    expect(calls).toHaveLength(1);

    // 期间有两条子会话汇报备好、排在队列里等主会话空闲。
    p.pendingSuperReportPrompts = [
      { mainSessionId: "sw-session", text: "【汇报】子会话 A 完成" },
      { mainSessionId: "sw-session", text: "【汇报】子会话 B 完成" },
    ];

    // 用户按停止：这一轮按 cancelled 收尾。
    await p.handleWebviewMessage({ type: "cancel" });
    calls[0]!.resolve({ stopReason: "cancelled" });
    await turn;
    await flush();
    await flush();
    await flush();

    // 关键：自动回合被压住 —— 面板停在 idle，不会在同一拍又变回「正在生成」；
    // 排队内容一条不丢（用户原话：点停止很难停下来，要点好几次）。
    expect(p.store.getState().status).toBe("idle");
    expect(p.store.getState().stopReason).toBe("cancelled");
    expect(calls).toHaveLength(1);
    expect(p.pendingSuperReportPrompts).toHaveLength(2);

    // 用户主动发下一条消息 = 解除压制。
    const next = p.handleWebviewMessage({ type: "sendPrompt", text: "继续推进" });
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt[0]!.text).toContain("继续推进");
    calls[1]!.resolve({ stopReason: "end_turn" });
    await next;
    await flush();
    await flush();

    // 回合结束后汇报才被投递（逐条即时汇报，顺序不变）。
    expect(calls).toHaveLength(3);
    expect(calls[2]!.prompt[0]!.text).toContain("子会话 A");
    // 在飞的那一条仍记在队列里（投递成功才出队）—— 剩下的继续排队。
    expect(p.pendingSuperReportPrompts.map((item) => item.text)).toEqual([
      "【汇报】子会话 A 完成",
      "【汇报】子会话 B 完成",
    ]);

    calls[2]!.resolve({ stopReason: "end_turn" });
    await flush();
    await flush();
    expect(calls[3]!.prompt[0]!.text).toContain("子会话 B");
    calls[3]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("停止的正是汇报回合本身：drain 循环不会立刻接上下一条汇报", async () => {
    const done = child({ status: "completed", summary: "登录跳转已修好" });
    manager.list = () => [done];
    p.pendingSuperReportPrompts = [
      { mainSessionId: "sw-session", text: "【汇报】子会话 A 完成" },
      { mainSessionId: "sw-session", text: "【汇报】子会话 B 完成" },
    ];

    // 主会话空闲 → drain 立刻投第一条汇报（hidden 回合，status streaming）。
    void p.drainSuperReports();
    await flush();
    expect(calls).toHaveLength(1);
    expect(p.store.getState().status).toBe("streaming");

    // 用户按停止 —— 停的就是这一条汇报回合。
    await p.handleWebviewMessage({ type: "cancel" });
    calls[0]!.resolve({ stopReason: "cancelled" });
    await flush();
    await flush();
    await flush();

    // 循环内的压制检查生效：第二条汇报留在队列里，不会在同一拍接上。
    expect(calls).toHaveLength(1);
    expect(p.store.getState().status).toBe("idle");
    expect(p.pendingSuperReportPrompts).toHaveLength(1);
    expect(p.pendingSuperReportPrompts[0]?.text).toContain("子会话 B");
  });

  it("来源子会话被清理：无从投递的汇报被丢弃，忙碌态不残留", async () => {
    // A 还在等人回答：它的 blocked 汇报先入缓冲（来源没终态 → 条目留在缓冲里）。
    const a = child({ id: "super-a", status: "awaiting_input", summary: "等回答" });
    const b = child({ id: "super-b", status: "running" });
    manager.list = () => [a, b];
    p.queueSuperReport([
      { session: a, report: { state: "blocked", summary: "等回答", at: 2000, humanAction: "等回答" } },
    ]);
    await flush();
    // 还没终态 → 不交付。
    expect(calls).toHaveLength(0);
    expect(p.store.getState().superWaiting).toBe(true);

    // 子会话被清理掉了：这份汇报再也没人能接 —— 如实丢掉，不能让面板卡在
    // 忙碌态。
    manager.list = () => [];
    p.refreshSuperWaitHeartbeat();
    await flush();

    expect(calls).toHaveLength(0);
    expect(p.pendingSuperReportPrompts).toHaveLength(0);
    expect(p.store.getState().superWaiting).toBe(false);
  });

  it("思考通道的委派围栏只进转录：不派发子会话、不报「无法解析」", () => {
    const toasts: string[] = [];
    vi.spyOn(p.store, "sendToast").mockImplementation(((...args: unknown[]) => {
      if (typeof args[1] === "string") toasts.push(args[1]);
      return 1;
    }) as PanelInternals["store"]["sendToast"]);

    const directive = [
      "```super-agent",
      '{"tasks":[{"title":"思考里误派发","task":"这不应该发生"}]}',
      "```",
    ].join("\n");
    const malformed = ["```super-agent", "{载荷不是合法 JSON}", "```"].join("\n");

    p.onSessionUpdate({
      sessionId: "sw-session",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: directive } },
    });
    p.onSessionUpdate({
      sessionId: "sw-session",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: malformed } },
    });

    // 思考流不参与委派扫描：既不派发，也不对写坏的围栏弹解析警告。
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(toasts.some((m) => m.includes("无法解析"))).toBe(false);
    // 但思考内容照常进转录（思考过程该显示还是显示，只是切成纯文本）。
    expect(
      p.store.getState().blocks.some((b) => b.kind === "thought" && b.text.includes("super-agent")),
    ).toBe(true);

    // 正文通道的扫描没被动过：同一份合法围栏仍会派发一次。
    p.onSessionUpdate({
      sessionId: "sw-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: directive } },
    });
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  describe("停止后的状态如实与出路", () => {
    it("汇报被压住：状态栏显示已停止与待处理数，不再谎称生成中", () => {
      const state: SessionState = {
        ...p.store.getState(),
        status: "idle",
        superWaiting: true,
        superHeld: true,
        superPendingCount: 2,
      };
      p.updateStatusBar(state);

      expect(p.statusBar.text).not.toContain("生成中");
      expect(p.statusBar.text).toContain("已停止");
      expect(p.statusBar.text).toContain("2 项待处理");
      expect(p.statusBar.tooltip).toContain("继续处理");
    });

    it("子会话真在跑或等回答：状态栏如实文案，都不是生成中", () => {
      const base: SessionState = {
        ...p.store.getState(),
        status: "idle",
        superWaiting: true,
        superHeld: false,
        superPendingCount: 0,
      };
      p.updateStatusBar({ ...base, superSessions: [child({ status: "running" })] });
      expect(p.statusBar.text).not.toContain("生成中");
      expect(p.statusBar.text).toContain("子会话进行中");

      p.updateStatusBar({ ...base, superSessions: [child({ status: "awaiting_input" })] });
      expect(p.statusBar.text).not.toContain("生成中");
      expect(p.statusBar.text).toContain("等待你处理");
    });

    it("syncSuperWaitingState 把 held/pendingCount 与 waiting 同源写进 store", () => {
      p.pendingSuperReportPrompts = [
        { mainSessionId: "sw-session", text: "A" },
        { mainSessionId: "other", text: "B" },
      ];
      p.autoTurnsStoppedFor = "sw-session";
      manager.list = () => [child({ status: "completed" })];
      p.syncSuperWaitingState();

      const state = p.store.getState();
      expect(state.superWaiting).toBe(true);
      expect(state.superHeld).toBe(true);
      // 只数当前主会话的，别的会话汇报不算进来。
      expect(state.superPendingCount).toBe(1);
    });

    it("停止时发常驻带动作提示；发下一条消息解除压制后提示消失", async () => {
      const sent: Array<{ message: string; opts?: Record<string, unknown> }> = [];
      const dismissed: number[] = [];
      vi.spyOn(p.store, "sendToast").mockImplementation(((...args: unknown[]) => {
        sent.push({ message: String(args[1]), opts: args[2] as Record<string, unknown> });
        return 42;
      }) as PanelInternals["store"]["sendToast"]);
      vi.spyOn(p.store, "dismissToast").mockImplementation(((id: number) => {
        dismissed.push(id);
      }) as PanelInternals["store"]["dismissToast"]);

      p.pendingSuperReportPrompts = [{ mainSessionId: "sw-session", text: "【汇报】A 完成" }];
      p.autoTurnsStoppedFor = "sw-session";
      p.announceDeferredAutoTurns();

      const deferred = sent.find((s) => s.message.includes("已停止"));
      expect(deferred).toBeTruthy();
      expect(deferred!.message).toContain("1 项");
      expect(deferred!.opts?.persistent).toBe(true);
      expect((deferred!.opts?.action as { actionId: string } | undefined)?.actionId).toBe(
        "resume-super-turns",
      );

      const turn = p.handleWebviewMessage({ type: "sendPrompt", text: "继续" });
      await flush();
      expect(dismissed).toContain(42);
      calls[0]!.resolve({ stopReason: "end_turn" });
      await turn;
      await flush();
    });

    it("点「继续处理」：释放压制、收掉提示并立刻恢复汇报投递", async () => {
      const dismissed: number[] = [];
      vi.spyOn(p.store, "dismissToast").mockImplementation(((id: number) => {
        dismissed.push(id);
      }) as PanelInternals["store"]["dismissToast"]);
      vi.spyOn(p.store, "sendToast").mockImplementation(
        (() => 77) as unknown as PanelInternals["store"]["sendToast"],
      );

      const done = child({ status: "completed", summary: "A 完成" });
      manager.list = () => [done];
      p.pendingSuperReportPrompts = [{ mainSessionId: "sw-session", text: "【汇报】A 完成" }];
      p.autoTurnsStoppedFor = "sw-session";
      p.announceDeferredAutoTurns();

      p.handleToastAction("resume-super-turns", 77);
      expect(dismissed).toContain(77);
      expect(p.autoTurnsStoppedFor).toBeNull();

      await flush();
      await flush();
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]!.prompt[0]!.text).toContain("A 完成");
      calls[0]!.resolve({ stopReason: "end_turn" });
      await flush();
    });

    it("压住态「新会话」放行；真等待态仍拒绝", async () => {
      // 守卫放行后要跑完整的新建会话流程：补齐 client 与宿主辅助方法的 mock。
      const client = {
        newSession: vi.fn(async () => ({
          sessionId: "sw-new-session",
          modes: { currentModeId: "default", availableModes: [{ id: "default" }] },
          _meta: { models: { currentModelId: "m1" }, availableCommands: [], availableSkills: [] },
        })),
        cancel: vi.fn(),
      };
      p.client = client;
      p.ensureClient = async () => client;
      const extra = p as unknown as Record<string, unknown>;
      extra.queryLiveModels = async () => [];
      extra.validateModelForPush = async () => null;
      extra.setModel = async () => {};
      extra.applyThinkLevel = async () => {};
      extra.workspaceModelId = () => null;
      extra.cleanupEmptySession = async () => {};
      extra.recordSession = async () => {};
      extra.restoreSuperSessions = async () => {};

      const done = child({ status: "completed", summary: "A 完成" });
      manager.list = () => [done];
      p.pendingSuperReportPrompts = [{ mainSessionId: "sw-session", text: "【汇报】A 完成" }];
      p.autoTurnsStoppedFor = "sw-session";

      const before = p.store.getState().sessionId;
      await p.handleWebviewMessage({ type: "newSession" });
      expect(p.store.getState().sessionId).toBe("sw-new-session");
      expect(p.store.getState().sessionId).not.toBe(before);

      // 真在等（没按停止）时依旧拒绝：会话不会被换掉。
      p.autoTurnsStoppedFor = null;
      p.pendingSuperReportPrompts = [{ mainSessionId: "sw-new-session", text: "【汇报】B 完成" }];
      await p.handleWebviewMessage({ type: "newSession" });
      expect(p.store.getState().sessionId).toBe("sw-new-session");
      expect(client.newSession).toHaveBeenCalledTimes(1);
    });
  });
});
