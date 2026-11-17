/**
 * 面板侧的主会话注入（`iflow.qq.route = "main"`）。
 *
 * 这里不 spawn CLI：`sendPrompt` 被替换成假实现，只钉住注入这一层的语义 ——
 * 等空闲、传参正确（来源标记 / 气泡正文 / 静默忙）、只取本轮 assistant 文本、
 * 取消能立刻放手、真实 user 块带 origin 徽标。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type { QqMainInjectInput } from "../src/qq/service.js";
import type { QqTask } from "../shared/qq-task.js";
import type { QqTaskUi } from "../shared/messages.js";
import { beginUserPrompt } from "../shared/session-state.js";
import { initialSessionState } from "../shared/messages.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      (store.has(key) ? (store.get(key) as T) : defaultValue) as T,
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

type PanelInternals = {
  injectQqMainTurn: (input: QqMainInjectInput) => Promise<{
    injected: boolean;
    text?: string;
    stopReason?: string;
    failed?: boolean;
    reason?: string;
    canceled?: boolean;
  }>;
  cancelQqMainInjection: (taskId: string) => boolean;
  sendPrompt: (...args: unknown[]) => Promise<boolean>;
  store: {
    getState: () => {
      status: string;
      initializing: boolean;
      replaying: boolean;
      sessionId: string | null;
      blocks: Array<Record<string, unknown>>;
      stopReason: string | null;
      errorMessage: string | null;
    };
    userPrompt: (text: string, images?: string[], files?: unknown[], origin?: "qq") => number;
  };
};

const TASK: QqTask = {
  taskId: "T-main-1",
  idempotencyKey: "qqbot:m-main-1",
  source: { chatType: "private", chatId: "u1", senderId: "D754D2240C503C2ABE2B236DC1E78D11", msgId: "m-main-1" },
  target: { workspace: "/ws" },
  payload: { prompt: "把安装段改成内网镜像", attachments: [], contexts: [] },
  policy: { remotePolicy: "supervised", resultDetail: "standard" },
  status: "queued",
  channel: "main",
  createdAt: 1_000,
  updatedAt: 1_000,
  correlation: {},
};

interface InjectCall {
  text: string;
  displayText?: string;
  origin?: string;
  internal?: boolean;
  hidden?: boolean;
  quietBusy?: boolean;
  delegateOnBusy?: boolean;
  onTurnStarted?: () => void | Promise<void>;
}

function fakeSendPrompt(p: PanelInternals, calls: InjectCall[], behaviour: "start" | "reject" = "start") {
  return async (...args: unknown[]): Promise<boolean> => {
    const options = (args[4] ?? {}) as {
      origin?: string;
      displayText?: string;
      internal?: boolean;
      hidden?: boolean;
      quietBusy?: boolean;
      delegateOnBusy?: boolean;
      onTurnStarted?: () => void | Promise<void>;
    };
    calls.push({ text: String(args[0] ?? ""), ...options });
    if (behaviour === "reject") return false;
    p.store.userPrompt(
      options.displayText ?? String(args[0] ?? ""),
      undefined,
      undefined,
      options.origin === "qq" ? "qq" : undefined,
    );
    await options.onTurnStarted?.();
    // 模拟这一轮的 assistant 输出（思考块不算结果）。
    p.store.getState().blocks.push({ kind: "thought", text: "先想一想" });
    p.store.getState().blocks.push({ kind: "text", text: "已经改好了：安装段换成内网镜像" });
    p.store.getState().status = "idle";
    p.store.getState().stopReason = "end_turn";
    return true;
  };
}

describe("QQ 主会话注入（面板侧）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let iflowHome: string;

  beforeEach(async () => {
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-main-home-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-main-storage-"));
    setConfigOverrides({});
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    const state = p.store.getState();
    state.sessionId = "main-session";
    state.status = "idle";
    state.initializing = false;
    state.replaying = false;
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("空闲时立即注入：传来源标记与气泡正文，只取本轮 assistant 文本", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = fakeSendPrompt(p, calls);
    // 先放一段上一轮的 assistant 文本，确保结果不会把它算进来。
    p.store.getState().blocks.push({ kind: "text", text: "上一轮的回答" });

    const injected = vi.fn();
    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "[来自 QQ 用户 D754********8D11 的消息]\n\n把安装段改成内网镜像",
      displayText: "把安装段改成内网镜像",
      origin: "qq",
      onInjected: injected,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.origin).toBe("qq");
    expect(calls[0]!.displayText).toBe("把安装段改成内网镜像");
    expect(calls[0]!.internal).toBe(true);
    expect(calls[0]!.hidden).toBeUndefined(); // 必须是可见的用户气泡
    expect(calls[0]!.quietBusy).toBe(true);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(result.injected).toBe(true);
    expect(result.text).toBe("已经改好了：安装段换成内网镜像");
  });

  it("注入的 user 块带 origin=qq（转录徽标的数据来源）", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = fakeSendPrompt(p, calls);
    await p.injectQqMainTurn({
      task: TASK,
      text: "包裹后的正文",
      displayText: "对方发来的原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });
    const userBlock = p.store.getState().blocks.find((b) => b.kind === "user");
    expect(userBlock?.text).toBe("对方发来的原文");
    expect(userBlock?.origin).toBe("qq");
  });

  it("主会话忙时不注入；空闲后自动补上", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = fakeSendPrompt(p, calls);
    p.store.getState().status = "streaming";

    const pending = p.injectQqMainTurn({
      task: TASK,
      text: "包裹后的正文",
      displayText: "对方发来的原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 3_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toHaveLength(0);

    p.store.getState().status = "idle";
    const result = await pending;
    expect(calls).toHaveLength(1);
    expect(result.injected).toBe(true);
  });

  it("等待空闲时被取消：立即返回 canceled，且不发出任何一轮", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = fakeSendPrompt(p, calls);
    p.store.getState().status = "streaming";
    const controller = new AbortController();

    const pending = p.injectQqMainTurn({
      task: TASK,
      text: "包裹后的正文",
      displayText: "对方发来的原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(p.cancelQqMainInjection(TASK.taskId)).toBe(true);

    const result = await pending;
    expect(result.canceled).toBe(true);
    expect(calls).toHaveLength(0);
    // 取消后表项已清理：重复取消不再命中。
    expect(p.cancelQqMainInjection(TASK.taskId)).toBe(false);
  });

  it("sendPrompt 被别的回合抢走：回到等空闲重试，不把任务判失败", async () => {
    const calls: InjectCall[] = [];
    p.sendPrompt = async (...args: unknown[]) => {
      calls.push({ text: String(args[0] ?? "") });
      // 第一次被抢（返回 false，未开始），第二次正常跑完。
      if (calls.length === 1) return false;
      const options = (args[4] ?? {}) as { onTurnStarted?: () => Promise<void> | void };
      await options.onTurnStarted?.();
      p.store.getState().blocks.push({ kind: "text", text: "第二次真的跑完了" });
      p.store.getState().status = "idle";
      return true;
    };

    const result = await p.injectQqMainTurn({
      task: TASK,
      text: "包裹后的正文",
      displayText: "对方发来的原文",
      origin: "qq",
      onInjected: () => undefined,
      signal: new AbortController().signal,
      timeoutMs: 3_000,
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(result.injected).toBe(true);
    expect(result.text).toBe("第二次真的跑完了");
  });
});

// ---------------------------------------------------------------------------
// 转录块来源标记（shared reducer）
// ---------------------------------------------------------------------------

describe("beginUserPrompt 来源标记", () => {
  it("origin=qq 写进 user 块；缺省不写该键", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "外部消息", undefined, undefined, "qq");
    beginUserPrompt(state, "本地输入");
    const [external, local] = state.blocks;
    expect(external).toMatchObject({ kind: "user", text: "外部消息", origin: "qq" });
    expect(local).toMatchObject({ kind: "user", text: "本地输入" });
    expect((local as { origin?: string }).origin).toBeUndefined();
  });
});

// 类型层面：QqTaskUi.channel 必填，看板据此标注渠道。
void (null as unknown as QqTaskUi);
