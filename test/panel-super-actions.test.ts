/**
 * 子会话管理动作（`super-agent-actions`）的宿主侧行为。
 *
 * 两件事在这里被钉住：
 *
 *  1. **可观测**：动作块没被执行时必须留下痕迹。旧实现里「主会话发了一个
 *     cancel，子会话还在跑」是**零日志零 toast**的静默失败 —— 故障只能靠
 *     用户复述「我发过啊」。回合收尾时必须复核并留一条警告。
 *
 *  2. **回执**：动作执行结果要回注给主会话（一次 hidden prompt）。主会话的
 *     看板摘要是**每轮开篇冻结**的，同一轮里它看不到自己刚发的动作生效没有
 *     —— 没有回执它就会重复发同一个动作（真实故障：cancel 一个早已结束的
 *     子会话，看板没变化，又发一次）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type { SuperCancelOutcome } from "../src/panel/super-agent.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { SessionState } from "../shared/messages.js";

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
  /** 主会话助手文本里的动作块扫描（宿主侧入口）。 */
  scanSuperActions: (content: unknown) => void;
  /** 看板按钮发出的 superAgent 消息走这条宿主路由。 */
  handleSuperAgentAction: (msg: {
    type: "superAgent";
    action: "cancel" | "cancelAll" | "respond" | "cleanup" | "merge" | "transcript" | "retry";
    sessionId?: string;
    answers?: Record<string, string | string[]>;
    keepBranch?: boolean;
  }) => Promise<void>;
  /** 主会话动作执行入口（内置工具 / 围栏动作块都走它）。 */
  runSuperActions: (actions: readonly {
    action: "cancel" | "retry" | "cleanup" | "answer";
    sessionId: string;
  }[]) => Promise<void>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  notifyOs: (event: string, text: string) => boolean;
  postSound: (kind: "done" | "error") => void;
  log: { lines: { level: string; message: string }[] };
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: SessionState) => void;
    sendToast: (...args: unknown[]) => number;
  };
};

describe("Super Agent · 管理动作的宿主侧行为", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];

  beforeEach(() => {
    // checkpoint 会拉真实 git 子进程；回合末跟进的网关调用也必须关掉。
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superactions-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    p.superAgent = { list: () => [], reportPrompt: () => "" };
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) =>
        new Promise<{ stopReason: string }>((resolve) => {
          calls.push({ prompt, resolve });
        }),
    ) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.store.sessionStarted({ sessionId: "actions-session" });
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

  /** 等条件成立（最多若干轮宏任务）。 */
  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !predicate(); i += 1) await flush();
  }

  /** 等回合真正跑到 promptWithRetry（中间有几个 await 窗口）。 */
  async function waitForPrompt(): Promise<PromptCall> {
    await waitFor(() => calls.length > 0);
    const call = calls[0];
    if (!call) throw new Error("prompt never started");
    return call;
  }

  it("回合结束后动作围栏仍未闭合：必须留下带内容的警告日志（不再是零痕迹）", async () => {
    // 围栏开了没收（模型漏了收栏），载荷也只写了一半 —— 这个动作块不会被执行。
    p.scanSuperActions({
      type: "text",
      text: [
        "```super-agent-actions",
        '{"actions":[{"action":"cancel","sessionId":"super-1"}',
      ].join("\n"),
    });

    const started = p.sendPrompt("继续");
    const call = await waitForPrompt();
    call.resolve({ stopReason: "end_turn" });
    await started;

    const warns = p.log.lines.filter((line) => line.level === "warn");
    // 痕迹必须点名「没闭合、没执行」。
    expect(warns.some((line) => line.message.includes("never closed"))).toBe(true);
    // 痕迹必须带内容（没收完的正文），不能只是一句空话。
    expect(warns.some((line) => line.message.includes("cancel"))).toBe(true);
  });

  it("动作执行结果回注给主会话（hidden prompt），幂等重复不算未生效", async () => {
    const cancel = vi.fn(async (_id: string) => ({
      ok: true,
      reason: "already-terminal" as const,
      status: "completed",
    }));
    p.superAgent = { list: () => [], reportPrompt: () => "", cancel };
    const sendPrompt = vi.fn(async () => true);
    p.sendPrompt = sendPrompt as unknown as PanelInternals["sendPrompt"];

    p.scanSuperActions({
      type: "text",
      text: [
        "```super-agent-actions",
        '{"actions":[{"action":"cancel","sessionId":"super-1"}]}',
        "```",
      ].join("\n"),
    });
    await waitFor(() => cancel.mock.calls.length > 0);
    expect(cancel).toHaveBeenCalledWith("super-1");

    // 回执是一次 hidden prompt（转录里不出现用户气泡）。
    await waitFor(
      () =>
        sendPrompt.mock.calls.some(
          (call) => typeof call[0] === "string" && call[0].includes("[子会话动作回执]"),
        ),
    );
    const receipt = sendPrompt.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("[子会话动作回执]"),
    );
    expect(receipt).toBeTruthy();
    expect((receipt?.[4] as { hidden?: boolean } | undefined)?.hidden).toBe(true);
    // 幂等重复（目标已是终态）必须说成「已生效」，不能报成「未生效」。
    const line =
      String(receipt?.[0])
        .split("\n")
        .find((item) => item.includes("super-1")) ?? "";
    expect(line).toContain("already applied (idempotent)");
    expect(line).not.toContain("NOT applied");
  });

  /** 直接驱动看板「单个中断」宿主路由，并抓取 store 发出的 toast。 */
  async function runCancelAction(
    outcome: SuperCancelOutcome,
  ): Promise<{ cancel: ReturnType<typeof vi.fn>; toasts: { level: string; message: string }[] }> {
    const cancel = vi.fn(async (_id: string) => outcome);
    p.superAgent = { list: () => [], reportPrompt: () => "", cancel };
    const toasts: { level: string; message: string }[] = [];
    vi.spyOn(p.store, "sendToast").mockImplementation(((
      level: string,
      message: string,
    ) => {
      toasts.push({ level, message });
      return 1;
    }) as unknown as PanelInternals["store"]["sendToast"]);

    await p.handleSuperAgentAction({
      type: "superAgent",
      action: "cancel",
      sessionId: "super-1",
    });
    return { cancel, toasts };
  }

  it("看板单个中断（成功）：仍调用 cancel 并发出 info toast 回执", async () => {
    const { cancel, toasts } = await runCancelAction({
      ok: true,
      reason: "cancelled",
      status: "cancelled",
    });
    // 状态推送链走 manager.cancel（其内 apply(cancelled)+emit），确认路由仍到它。
    expect(cancel).toHaveBeenCalledWith("super-1");
    expect(toasts).toEqual([{ level: "info", message: "已中断子会话" }]);
  });

  it("看板单个中断（已终态）：如实提示「无需中断」，不是失败也不是静默", async () => {
    const { cancel, toasts } = await runCancelAction({
      ok: true,
      reason: "already-terminal",
      status: "completed",
    });
    expect(cancel).toHaveBeenCalledWith("super-1");
    expect(toasts).toEqual([{ level: "info", message: "这个子会话已经结束了，不用再中断" }]);
  });

  it("看板单个中断（目标不存在）：发出 warning 回执", async () => {
    const { toasts } = await runCancelAction({ ok: false, reason: "not-found" });
    expect(toasts).toEqual([{ level: "warning", message: "该子会话不存在或已被清理" }]);
  });

  it("主会话 cancel 抄错 id（not-found）：给用户一条带 id 的可见 warning（不再只有 hidden 回执）", async () => {
    // 实测故障：主 Agent 从冻结的看板摘要里抄 id，抄到一个不存在/已清理的 id，
    // cancel 报 not-found —— 旧实现只把回执 hidden 投给主会话，用户完全看不到，
    // 表现为「点了中断没反应」。这里要求额外一条用户可见的明确提示。
    const cancel = vi.fn(async (_id: string) => ({ ok: false, reason: "not-found" as const }));
    p.superAgent = { list: () => [], reportPrompt: () => "", cancel };
    const toasts: { level: string; message: string }[] = [];
    vi.spyOn(p.store, "sendToast").mockImplementation(((level: string, message: string) => {
      toasts.push({ level, message });
      return 1;
    }) as unknown as PanelInternals["store"]["sendToast"]);
    p.sendPrompt = vi.fn(async () => true) as unknown as PanelInternals["sendPrompt"];

    await p.runSuperActions([{ action: "cancel", sessionId: "super-wrong-id" }]);

    expect(cancel).toHaveBeenCalledWith("super-wrong-id");
    const visible = toasts.find(
      (toast) => toast.level === "warning" && toast.message.includes("super-wrong-id"),
    );
    expect(visible).toBeTruthy();
    expect(visible!.message).toContain("中断失败");
  });
});
