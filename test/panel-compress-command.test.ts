import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { ContextRefUi } from "../shared/messages.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: () => Promise.resolve(),
    keys: () => [...store.keys()],
    delete: () => Promise.resolve(),
  };
  return {
    subscriptions: [],
    secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve() },
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

type PromptBlock = { type: string; text?: string };

type PanelInternals = {
  client: unknown;
  panelVisible: boolean;
  historySyncBusy: boolean;
  cancelSeen: boolean;
  cancelSeenFlag: boolean;
  ensureClient: () => Promise<unknown>;
  ensureSuperAgentForDispatch: () => Promise<unknown>;
  promptWithRetry: (client: unknown, sessionId: string, prompt: PromptBlock[]) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  runTurnFollowup: (sessionId: string, opts: unknown) => Promise<void>;
  maybeAutoCompressOnIdle: (sessionId: string) => Promise<boolean>;
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  pendingDelegatedUserTurns: unknown[];
  store: {
    getState: () => { status: string; sessionId: string | null; compressing: boolean };
    sessionStarted: (meta: { sessionId: string }) => void;
    userPrompt: (text: string) => number;
    promptCompleted: (stopReason: string, usage?: unknown) => void;
    sendToast: (...args: unknown[]) => number;
    dismissToast: (id: number) => void;
  };
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await flush();
}

/**
 * slash 命令归属 + 压缩按钮落地。
 *
 * 根因：宿主把看板摘要拼在用户正文前面，CLI 只在 `prompt[0].text.trim()`
 * 以 "/" 开头时才走命令分支 —— `/compress`、`/compact` 与自定义命令因此
 * 全部退化成普通正文；主会话忙时更糟：整条消息（含 "/" 原文）会被 spawn
 * 成子会话，回合末还用 `[补投用户消息]` 散文补投。
 */
describe("slash 归属与主会话压缩", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptBlock[][];
  let toasts: { level: string; message: string }[];

  beforeEach(async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-slash-compress-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    toasts = [];
    const fakeClient = { dispose: () => {} };
    p.client = fakeClient;
    p.ensureClient = async () => fakeClient;
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.runTurnFollowup = async () => {};
    p.maybeAutoCompressOnIdle = async () => false;
    p.promptWithRetry = vi.fn(async (_c: unknown, _s: string, prompt: PromptBlock[]) => {
      calls.push(prompt);
      return { stopReason: "end_turn" };
    }) as unknown as PanelInternals["promptWithRetry"];
    vi.spyOn(p.store, "sendToast").mockImplementation(((level: string, message: string) => {
      toasts.push({ level, message });
      return 0;
    }) as unknown as PanelInternals["store"]["sendToast"]);
    p.store.sessionStarted({ sessionId: "slash-session" });
    p.store.getState().status = "idle";
    p.panelVisible = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** 让转录里出现一条 user 块，再把状态收回到 idle（模拟「有内容可压」）。 */
  const seedUserTurn = (): void => {
    p.store.userPrompt("hello");
    p.store.promptCompleted("end_turn", null);
    p.store.getState().status = "idle";
  };

  it("① idle 发 /compress：prompt[0] 是命令，看板摘要排在后续块", async () => {
    await p.handleWebviewMessage({ type: "sendPrompt", text: "/compress" });
    await waitFor(() => calls.length === 1);
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!;
    expect(prompt[0]).toEqual({ type: "text", text: "/compress" });
    expect(prompt[1]?.type).toBe("text");
    expect(prompt[1]?.text?.startsWith("[子会话看板]")).toBe(true);
  });

  it("② 带上下文时：上下文块排在命令之后", async () => {
    const ctx: ContextRefUi = {
      id: "ctx-1",
      kind: "code",
      label: "src/a.ts",
      detail: "L1",
      content: "export const answer = 42;",
    };
    await p.handleWebviewMessage({ type: "sendPrompt", text: "/compress", contexts: [ctx] });
    await waitFor(() => calls.length === 1);
    const prompt = calls[0]!;
    expect(prompt[0]).toEqual({ type: "text", text: "/compress" });
    const rest = prompt.slice(1).map((b) => b.text ?? "").join("\n\n");
    expect(rest.startsWith("[子会话看板]")).toBe(true);
    expect(rest).toContain("export const answer = 42;");
  });

  it("③ streaming 时的 /compress 不 spawn 子会话，只提示本轮结束后再压缩", async () => {
    const spawn = vi.fn();
    const ensureDispatch = vi.fn(async () => ({ spawn }));
    p.ensureSuperAgentForDispatch = ensureDispatch as unknown as PanelInternals["ensureSuperAgentForDispatch"];
    p.store.getState().status = "streaming";

    await p.handleWebviewMessage({ type: "sendPrompt", text: "/compress" });

    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(p.pendingDelegatedUserTurns).toHaveLength(0);
    expect(toasts).toEqual([{ level: "warning", message: "主会话正在生成，等本轮结束后再压缩" }]);
    expect(calls).toHaveLength(0);
  });

  it("④ /compact、/summarize 与 /compress 同口径（不 spawn、同一提示）", async () => {
    const spawn = vi.fn();
    p.ensureSuperAgentForDispatch = (async () => ({ spawn })) as unknown as PanelInternals["ensureSuperAgentForDispatch"];
    p.store.getState().status = "streaming";

    await p.handleWebviewMessage({ type: "sendPrompt", text: "/compact" });
    await p.handleWebviewMessage({ type: "sendPrompt", text: "  /summarize keep decisions" });

    expect(spawn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(toasts.map((t) => t.message)).toEqual([
      "主会话正在生成，等本轮结束后再压缩",
      "主会话正在生成，等本轮结束后再压缩",
    ]);
  });

  it("⑤ cancelSeen=true（上一轮 Stop）后 compressNow 仍能发出一轮", async () => {
    seedUserTurn();
    p.cancelSeen = true;

    await p.handleWebviewMessage({ type: "compressNow" });
    await waitFor(() => calls.length === 1);

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual({ type: "text", text: "/compress" });
    expect(p.cancelSeen).toBe(false);
  });

  it("⑥ 连发两条 compressNow 只发一轮", async () => {
    seedUserTurn();
    let release!: (v: { stopReason: string }) => void;
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: PromptBlock[]) =>
        new Promise<{ stopReason: string }>((resolve) => {
          calls.push(prompt);
          release = resolve;
        }),
    ) as unknown as PanelInternals["promptWithRetry"];

    // 两个请求在同一 tick 内进来：第一个占锁（同步），第二个直接返回。
    await p.handleWebviewMessage({ type: "compressNow" });
    await p.handleWebviewMessage({ type: "compressNow" });
    await flush();
    expect(calls).toHaveLength(1);

    release({ stopReason: "end_turn" });
    await waitFor(() => p.store.getState().status === "idle");
    expect(calls).toHaveLength(1);
  });
});