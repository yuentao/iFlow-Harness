/**
 * 底部输入区「远程接续」开关（宿主侧，语义已按用户澄清反转）：
 *
 * - start：远程继续干活 —— QQ 消息照常注入主会话、agent 继续执行，只冻结本地
 *   干预入口；把会话从「已断开」集合移除（重新接上）、发常驻只读 toast、回推
 *   qqTakeoverState active=true；不设任何注入门，也不取消在跑的注入。
 * - stop：本地恢复 + 断开远程 —— 在本次接管的 sessionId 上设「不再接收 QQ 注入」
 *   的门、取消在跑的注入回合、撤掉 toast、回推 active=false。
 * - 只有「已断开远程接管」的会话才拦截 QQ 注入（机器人仍服务其它会话）。
 * - 断开门不持久化：只在会话切换 / 重建（newSession / restore / dispose）时清；
 *   webview 重连不清，避免同一 panel 进程里已断开的会话意外恢复注入。
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
  injectQqMainTurn: (input: unknown) => Promise<{ injected: boolean; reason?: string }>;
  isQqRemoteDetachedFor: (sessionId: string | null) => boolean;
  cancelAllQqMainInjections: () => void;
  clearQqRemoteDetachedSessions: () => void;
  waitForQqMainFree: (signal: AbortSignal, deadline: number) => Promise<"free" | "canceled" | "timeout">;
  runStartNewSession: (options?: unknown) => Promise<void>;
  pushQqState: () => void;
  store: {
    getState: () => { sessionId: string | null; [key: string]: unknown };
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: unknown) => void;
    sendToast: (level: string, message: string, opts?: unknown) => number;
    dismissToast: (id: number) => void;
  };
  postToWebview: (msg: unknown) => void;
  qqTakeoverActive: boolean;
  qqTakeoverSessionId: string | null;
  qqTakeoverToastId: number | null;
  qqRemoteDetachedSessions: Set<string>;
  /** 当前跑在主会话上的 QQ 注入任务 id（接管态完成提示据此跳过重复投递）。 */
  qqInjectedTaskId: string | null;
  /** 完成提示的统一出口（本文件用它验证「接管态改投 QQ」）。 */
  announceCue: (event: string, text: string, kind: "done" | "child") => void;
  // 完成提示 / QQ 转发两条路径（本文件新增用例要同时接通）。
  superAgent: unknown;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: unknown,
  ) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  notifyOsDecision: (event: string, text: string) => unknown;
  postSound: (kind: "done" | "error" | "child") => void;
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
  deliverQqMainFinalAnswer: (
    sessionId: string | null,
    text: string,
    stopReason: string,
    onlyTaskIds?: ReadonlySet<string>,
  ) => Promise<void>;
  appendQqArchiveEvent: (
    type: string,
    taskId?: string,
    detail?: Record<string, unknown>,
  ) => Promise<void>;
  qqMainFinalAwaiters: Map<string, string>;
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

describe("ChatPanel 远程接续开关", () => {
  let panel: ChatPanel;
  let p: Internals;
  let iflowHome: string;
  let storageDir: string;

  beforeEach(async () => {
    iflowHome = await mkdtemp(path.join(os.tmpdir(), "iflow-takeover-home-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-takeover-store-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as Internals;
    const realGetState = p.store.getState.bind(p.store);
    vi.spyOn(p.store, "getState").mockImplementation(() => ({ ...realGetState(), sessionId: "s1" }) as never);
    vi.spyOn(p, "postToWebview").mockImplementation(() => {});
    vi.spyOn(p, "pushQqState").mockImplementation(() => {});
  });

  afterEach(async () => {
    await panel.dispose();
    await rm(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    delete process.env.IFLOW_HOME;
    vi.restoreAllMocks();
  });

  it("start 接上远程 + 冻结本地 + 发常驻只读 toast + 回推 active=true（不设注入门）", async () => {
    const toast = vi.spyOn(p.store, "sendToast");
    const cancel = vi.spyOn(p, "cancelAllQqMainInjections");
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });

    expect(p.qqTakeoverActive).toBe(true);
    expect(p.qqTakeoverSessionId).toBe("s1");
    // start 不设断开门：QQ 注入照常放行。
    expect(p.isQqRemoteDetachedFor("s1")).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("info", "远程接管中…", { persistent: true, displayOnly: true });
    expect(p.postToWebview).toHaveBeenCalledWith({ type: "qqTakeoverState", active: true });
  });

  it("stop 才断开远程：设断开门 + 取消在跑注入 + dismiss toast + 回推 active=false", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    const toastId = p.qqTakeoverToastId!;
    const cancel = vi.spyOn(p, "cancelAllQqMainInjections");
    const dismiss = vi.spyOn(p.store, "dismissToast");

    await p.handleWebviewMessage({ type: "qqTakeover", action: "stop" });

    expect(cancel).toHaveBeenCalledTimes(1);
    // 断开门只落在本次接管的会话上（其它会话不受影响）。
    expect(p.isQqRemoteDetachedFor("s1")).toBe(true);
    expect(p.isQqRemoteDetachedFor("other-session")).toBe(false);
    expect(p.qqTakeoverActive).toBe(false);
    expect(p.qqTakeoverSessionId).toBeNull();
    expect(dismiss).toHaveBeenCalledWith(toastId);
    expect(p.postToWebview).toHaveBeenCalledWith({ type: "qqTakeoverState", active: false });
  });

  it("接管期间本机看板动作被宿主拒绝，关闭接管后恢复", async () => {
    const cleanup = vi.fn(async (_id: string) => ({ ok: true }));
    p.superAgent = { list: () => [], cleanup };
    const toast = vi.spyOn(p.store, "sendToast");

    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    await p.handleWebviewMessage({
      type: "superAgent",
      action: "cleanup",
      sessionId: "super-1",
    });

    // UI 层的 inert 之外，宿主也必须拒绝：不执行任何 manager 调用，且给出原因。
    expect(cleanup).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("warning", "远程接管中，本机的超流体操作已冻结");

    // 关闭接管后同一动作恢复执行（门是接管态的，不是永久封禁）。
    await p.handleWebviewMessage({ type: "qqTakeover", action: "stop" });
    await p.handleWebviewMessage({
      type: "superAgent",
      action: "cleanup",
      sessionId: "super-1",
    });
    expect(cleanup).toHaveBeenCalledWith("super-1", { keepBranch: undefined });
  });

  it("start 后 QQ 注入照常执行（不再暂停）", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    // 让注入走到「等空闲」阶段就超时返回，以证明它没有被远程接续门短路。
    const waitFree = vi.spyOn(p, "waitForQqMainFree").mockResolvedValue("timeout");

    const result = await p.injectQqMainTurn({
      task: { taskId: "t1", policy: { remotePolicy: "trusted" } },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });

    expect(waitFree).toHaveBeenCalled();
    expect(result.injected).toBe(false);
    expect(result.reason).toContain("主会话长时间未空闲");
    expect(result.reason).not.toContain("远程接续");
    expect(result.reason).not.toContain("断开");
  });

  it("stop 后该会话断开：QQ 注入被拦截（机器人仍服务其它会话）", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    await p.handleWebviewMessage({ type: "qqTakeover", action: "stop" });

    // 最小输入即可：断开门在方法最前面短路，不会读取 task 的其它字段。
    const result = await p.injectQqMainTurn({ task: { taskId: "t1" } });
    expect(result.injected).toBe(false);
    expect(result.reason).toContain("断开");

    // 门是会话级的：切到别的会话时同一方法不会因这条门被挡住（这里只验证判定）。
    expect(p.isQqRemoteDetachedFor("another-session")).toBe(false);
  });

  it("再次 start 重新接上远程：移除该会话的断开门，注入恢复放行", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    await p.handleWebviewMessage({ type: "qqTakeover", action: "stop" });
    expect(p.isQqRemoteDetachedFor("s1")).toBe(true);

    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    expect(p.isQqRemoteDetachedFor("s1")).toBe(false);
    expect(p.qqTakeoverActive).toBe(true);
  });

  it("webview 重连（ready）清除本地冻结态 + 撤掉常驻 toast", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    const toastId = p.qqTakeoverToastId!;
    const dismiss = vi.spyOn(p.store, "dismissToast");
    vi.spyOn(p.store, "resync").mockImplementation(() => {});
    vi.spyOn(p.store, "pushSnapshot").mockImplementation(() => {});

    await p.handleWebviewMessage({ type: "ready" });

    expect(p.qqTakeoverActive).toBe(false);
    expect(p.qqTakeoverSessionId).toBeNull();
    expect(dismiss).toHaveBeenCalledWith(toastId);
    expect(p.postToWebview).toHaveBeenCalledWith({ type: "qqTakeoverState", active: false });
  });

  it("webview 重连（ready）保留断开门，避免已断开会话恢复注入", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    await p.handleWebviewMessage({ type: "qqTakeover", action: "stop" });
    expect(p.isQqRemoteDetachedFor("s1")).toBe(true);
    vi.spyOn(p.store, "resync").mockImplementation(() => {});
    vi.spyOn(p.store, "pushSnapshot").mockImplementation(() => {});

    await p.handleWebviewMessage({ type: "ready" });

    // 冻结态随重连清除，但断开门保留（同一 panel 进程里远程关系仍在）。
    expect(p.qqTakeoverActive).toBe(false);
    expect(p.isQqRemoteDetachedFor("s1")).toBe(true);
  });

  it("会话切换（newSession）清断开门，不遗留永久收不到 QQ 的会话", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    await p.handleWebviewMessage({ type: "qqTakeover", action: "stop" });
    expect(p.isQqRemoteDetachedFor("s1")).toBe(true);
    // 新建会话的 CLI 部分是重活，这里只要验证进入流程时断开门被清掉。
    vi.spyOn(p, "runStartNewSession").mockResolvedValue();

    await p.handleWebviewMessage({ type: "newSession" });

    expect(p.isQqRemoteDetachedFor("s1")).toBe(false);
    expect(p.qqRemoteDetachedSessions.size).toBe(0);
  });

  it("dispose 清断开门，重启后不遗留", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    await p.handleWebviewMessage({ type: "qqTakeover", action: "stop" });
    expect(p.isQqRemoteDetachedFor("s1")).toBe(true);

    await panel.dispose();

    expect(p.qqTakeoverActive).toBe(false);
    expect(p.qqTakeoverSessionId).toBeNull();
    expect(p.isQqRemoteDetachedFor("s1")).toBe(false);
    expect(p.qqRemoteDetachedSessions.size).toBe(0);
  });

  it("接管态：本机完成提示静音，但 QQ 最终答复仍投递（不误伤转发）", async () => {
    // 真实的 sendPrompt 汇总轮收尾同时经过两条路径：
    //   ① QQ 转发 deliverQqMainFinalAnswer —— 接管态下必须照常投递；
    //   ② 本机完成提示 announceCue → notifyOsDecision + postSound —— 必须静音。
    // 两条都接通，专门挡住「在 sendPrompt 收尾外层 return」这种误伤转发的实现。
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    const complete = vi.fn(async () => {});
    p.qq = { service: { completeMainFinalAnswer: complete } };
    p.qqMainFinalAwaiters.set("task-qq", "s1");
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
    p.store.replaceState({ ...p.store.getState(), status: "idle" });

    const notify = vi.spyOn(p, "notifyOsDecision");
    const sound = vi.spyOn(p, "postSound");
    const deliver = vi.spyOn(p, "deliverQqMainFinalAnswer");

    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });

    const started = p.sendPrompt("【汇报】任务完成", undefined, undefined, undefined, {
      hidden: true,
      reportTurn: true,
      finalReport: true,
    });
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    pending[0]?.({ stopReason: "end_turn" });
    await started;

    // 转发未被误伤：真实投递到 QQ 服务。
    expect(deliver).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-qq" }));
    // 本机完成提示静音（真实经过 announceCue 出口）。
    expect(notify).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
  });

  /**
   * 回归（2026-11-20 用户实测）：「任务进行中才开启远程接续，此后 QQ 上一条
   * 通知都收不到」。
   *
   * 根因：接管态下 announceCue 直接 return，本机静音了，但「QQ 转发」只覆盖
   * QQ 任务自己的回执 —— 本地发起的任务没有任务归属，提示就此彻底消失。
   * 现在同一条完成提示改投绑定者私聊，本机仍然不发 toast / 不响铃。
   */
  it("接管态：一轮进行中开启接续后，回合收尾提示改投 QQ（本机静音）", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    const notifyBoundUser = vi.fn(async () => true);
    p.qq = { service: { notifyBoundUser } };
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
    p.store.replaceState({ ...p.store.getState(), status: "idle" });

    const notify = vi.spyOn(p, "notifyOsDecision");
    const sound = vi.spyOn(p, "postSound");

    // 一轮进行中：此时还没有任何 QQ 任务 / 投递通道。
    const started = p.sendPrompt("把剩下的活干完");
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(pending).toHaveLength(1);

    // 中途开启远程接续。
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });

    // 回合收尾 → 产生一条完成提示。
    pending[0]!({ stopReason: "end_turn" });
    await started;

    // 提示从那一刻起改走 QQ。
    expect(notifyBoundUser).toHaveBeenCalledTimes(1);
    expect(notifyBoundUser).toHaveBeenCalledWith("iFlow 已完成本轮回复");
    // 本机仍静音（不弹 OS 通知、不响铃）。
    expect(notify).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
  });

  it("未开启接续：完成提示仍走本机，不投 QQ（反向用例）", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    const notifyBoundUser = vi.fn(async () => true);
    p.qq = { service: { notifyBoundUser } };
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
    p.store.replaceState({ ...p.store.getState(), status: "idle" });

    const notify = vi.spyOn(p, "notifyOsDecision");

    const started = p.sendPrompt("把剩下的活干完");
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    pending[0]!({ stopReason: "end_turn" });
    await started;

    // 开关关着：本机照常走 OS 通知闸门，绝不往 QQ 发。
    expect(notify).toHaveBeenCalledWith("turnDone", "iFlow 已完成本轮回复");
    expect(notifyBoundUser).not.toHaveBeenCalled();
  });

  it("接管态：QQ 注入回合自身不额外投递完成提示（任务通道已有回执）", () => {
    const notifyBoundUser = vi.fn(async () => true);
    p.qq = { service: { notifyBoundUser } };
    p.qqTakeoverActive = true;
    p.qqInjectedTaskId = "task-qq";

    p.announceCue("turnDone", "iFlow 已完成本轮回复", "done");

    expect(notifyBoundUser).not.toHaveBeenCalled();
  });

  /**
   * 回归（2026-11-20 QQ 用户实测）：「只收到『主会话已汇报超流体结果』的提醒，
   * 完全不知道具体结果」。
   *
   * 根因：汇报正文只走 QQ 任务通道（deliverQqMainFinalAnswer），本地发起的任务
   * 没有 awaiter → 无处投递；be79be5 补的完成提示改投又只带一句状态文案。
   * 现在无 awaiter 时把正文并入一条 QQ 消息投给绑定者。
   */
  it("接管态：本地发起任务的最终汇报正文（非状态语）投递到 QQ", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    const notifyBoundUser = vi.fn(async () => true);
    p.qq = { service: { notifyBoundUser } };
    p.qqMainFinalAwaiters.clear();
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

    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    const notify = vi.spyOn(p, "notifyOsDecision");
    const sound = vi.spyOn(p, "postSound");

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
    pending[0]?.({ stopReason: "end_turn" });
    await started;

    expect(notifyBoundUser).toHaveBeenCalledTimes(1);
    const delivered = notifyBoundUser.mock.calls[0]?.[0] as string;
    // 状态抬头仍在，但必须带上具体正文，不再只有一句元信息。
    expect(delivered).toContain("主会话已汇报超流体结果");
    expect(delivered).toContain(fallback);
    expect(delivered).toContain("完整结果请在面板查看");
    // 本机仍静音：提示只走 QQ。
    expect(notify).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
  });

  it("接管态：最终汇报优先发主会话转述正文，超长截断并保留开头", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    const notifyBoundUser = vi.fn(async () => true);
    p.qq = { service: { notifyBoundUser } };
    p.qqMainFinalAwaiters.clear();
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

    p.qqTakeoverActive = true;
    const fallback = "子会话汇报兜底正文不应出现";
    const started = p.sendPrompt("【汇报】超流体完成", undefined, undefined, undefined, {
      hidden: true,
      reportTurn: true,
      finalReport: true,
      finalFallbackText: fallback,
    });
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    // 主 Agent 这一轮的转述流式进入转录（锚点在回合开始时已取，故它能被识别为本轮新增）。
    p.store.getState().blocks.push({
      kind: "text",
      id: "b-turn",
      text: `主会话转述：${"A".repeat(2000)}尾部标记`,
    } as never);
    pending[0]?.({ stopReason: "end_turn" });
    await started;

    expect(notifyBoundUser).toHaveBeenCalledTimes(1);
    const delivered = notifyBoundUser.mock.calls[0]?.[0] as string;
    expect(delivered).toContain("主会话转述：");
    expect(delivered).not.toContain(fallback); // 转述优先于兜底
    expect(delivered).not.toContain("尾部标记"); // 超长已截断
    expect(delivered).toContain("完整结果请在面板查看");
  });

  /**
   * 可观测性回归（2026-11-22）：中间人开启接续后的补投决策必须落归档事件，
   * 下次复现「QQ 只收到短提醒」时能一眼区分是补投被跳过还是根本没走到收尾块。
   * QQ 注入回合自带回执通道，正文补投被内部 guard 跳过，属于「合法跳过」，
   * 此时应记录 takeover_report_forward_skipped 及其判定上下文。
   */
  it("接管态 + QQ 注入回合：跳过正文补投时记录 takeover_report_forward_skipped 归档事件", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    p.qq = { service: { notifyBoundUser: vi.fn(async () => true) } };
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    // QQ 注入回合 + 该 session 已登记 awaiter → 补投条件不成立、takeoverReportSent=false。
    p.qqInjectedTaskId = "task-qq";
    p.qqMainFinalAwaiters.set("task-qq", "s1");
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

    const archive = vi.spyOn(p, "appendQqArchiveEvent").mockResolvedValue(undefined);

    const fallback = "子会话汇报正文：修好登录跳转";
    const started = p.sendPrompt("【汇报】超流体完成", undefined, undefined, undefined, {
      hidden: true,
      reportTurn: true,
      finalReport: true,
      finalFallbackText: fallback,
    });
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    pending[0]?.({ stopReason: "end_turn" });
    await started;

    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledWith(
      "takeover_report_forward_skipped",
      undefined,
      expect.objectContaining({
        awaitedHere: true,
        takeoverActive: true,
        injectedTaskId: "task-qq",
        promptSessionId: "s1",
        answerChars: expect.any(Number),
        fallbackChars: expect.any(Number),
        // deliverQqMainFinalAnswer 投递时已消费 awaiter（qq-host.ts delete），
        // 归档时列表为空；awaitedHere=true 是投递前采样，才是诊断根因的关键。
        awaitingTaskIds: [],
        stopReason: "end_turn",
      }),
    );
  });
});