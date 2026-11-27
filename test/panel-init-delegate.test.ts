import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";

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
type SpawnCall = { title: string; task: string };

type PanelInternals = {
  client: unknown;
  panelVisible: boolean;
  historySyncBusy: boolean;
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
    getState: () => { status: string; sessionId: string | null; compressing: boolean; replaying?: boolean };
    sessionStarted: (meta: { sessionId: string }) => void;
    userPrompt: (text: string) => number;
    promptCompleted: (stopReason: string, usage?: unknown) => void;
    sendToast: (...args: unknown[]) => number;
  };
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * `/init` 直接委派的产品例外：宿主拦截并 spawn 子会话，主会话 CLI 不收到原文；
 * 同时守住 /compress 与通用 slash（含路径式文本）的既有归属。
 */
describe("/init 直接委派超流体", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptBlock[][];
  let toasts: { level: string; message: string }[];
  let spawn: ReturnType<typeof vi.fn>;
  let ensureDispatch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-init-delegate-"));
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
    spawn = vi.fn();
    ensureDispatch = vi.fn(async () => ({ spawn }));
    p.ensureSuperAgentForDispatch = ensureDispatch as unknown as PanelInternals["ensureSuperAgentForDispatch"];
    vi.spyOn(p.store, "sendToast").mockImplementation(((level: string, message: string) => {
      toasts.push({ level, message });
      return 0;
    }) as unknown as PanelInternals["store"]["sendToast"]);
    p.store.sessionStarted({ sessionId: "init-session" });
    p.store.getState().status = "idle";
    p.panelVisible = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const spawnCalls = (): SpawnCall[] =>
    spawn.mock.calls.map((c: unknown[]) => c[0] as SpawnCall);

  it("① idle 发 /init：spawn 被调、task 含展开意图，主会话 CLI 不被误发", async () => {
    await p.handleWebviewMessage({ type: "sendPrompt", text: "/init" });

    expect(ensureDispatch).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const spec = spawnCalls()[0]!;
    expect(spec.task).toContain("Run the /init workflow");
    expect(spec.task).toContain("AGENTS.md");
    expect(spec.task).toContain("Original user input: /init");
    // 主会话 CLI 完全不参与：既没有 prompt，也没有补投回灌。
    expect(calls).toHaveLength(0);
    expect(p.pendingDelegatedUserTurns).toHaveLength(0);
  });

  it("② /init 带参数仍委派，原始输入原样写入 task", async () => {
    await p.handleWebviewMessage({ type: "sendPrompt", text: "  /init project overview  " });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawnCalls()[0]!.task).toContain("Original user input: /init project overview");
    expect(calls).toHaveLength(0);
  });

  it("③ streaming 发 /init：仍可委派，不被通用 slash 早退吞掉", async () => {
    p.store.getState().status = "streaming";

    await p.handleWebviewMessage({ type: "sendPrompt", text: "/init" });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawnCalls()[0]!.task).toContain("Run the /init workflow");
    expect(calls).toHaveLength(0);
    // 忙时给的是「已派发」提示，不是「命令请本轮结束后重发」。
    expect(toasts.map((t) => t.message)).toEqual([
      "主会话正在生成，已把这条消息派发为超流体「/init」",
    ]);
    expect(p.pendingDelegatedUserTurns).toHaveLength(0);
  });

  it("④ 回放/历史同步中拒绝 /init，不 spawn", async () => {
    p.store.getState().replaying = true;

    await p.handleWebviewMessage({ type: "sendPrompt", text: "/init" });

    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(toasts.map((t) => t.message)).toEqual(["主会话正在生成，命令请本轮结束后重发"]);
  });

  it("⑤ 回归：/compress 在 idle 仍进主会话 prompt[0]，streaming 仍不 spawn", async () => {
    await p.handleWebviewMessage({ type: "sendPrompt", text: "/compress" });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual({ type: "text", text: "/compress" });
    expect(spawn).not.toHaveBeenCalled();

    calls.length = 0;
    p.store.getState().status = "streaming";
    await p.handleWebviewMessage({ type: "sendPrompt", text: "/compress" });
    expect(spawn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(toasts.map((t) => t.message)).toEqual(["主会话正在生成，等本轮结束后再压缩"]);
  });

  it("⑥ 回归：/usr/bin/node 等路径式 slash 不被误判为 /init，仍走通用拦截", async () => {
    p.store.getState().status = "streaming";
    await p.handleWebviewMessage({ type: "sendPrompt", text: "/usr/bin/node" });

    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(toasts.map((t) => t.message)).toEqual(["主会话正在生成，命令请本轮结束后重发"]);
  });

  it("⑦ /initialize 等非 /init 命令不触发委派", async () => {
    await p.handleWebviewMessage({ type: "sendPrompt", text: "/initialize" });
    await flush();

    expect(spawn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});
