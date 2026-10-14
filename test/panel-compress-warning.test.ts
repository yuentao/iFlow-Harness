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
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : defaultValue),
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

type PromptCall = {
  prompt: Array<{ type: string; text?: string }>;
  resolve: (v: { stopReason: string }) => void;
};

type PanelInternals = {
  client: unknown;
  panelVisible: boolean;
  historySyncBusy: boolean;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  store: {
    getState: () => { status: string; compressing: boolean; sessionId: string };
    getUsageContext: () => { contextWindow: number; estimated: boolean; costPrice: null } | null;
    sessionStarted: (meta: { sessionId: string }) => void;
    userPrompt: (text: string) => number;
    promptCompleted: (stopReason: string, turnUsage?: unknown) => void;
    replaceTranscript: (blocks: unknown[]) => void;
    sendToast: (level: string, message: string, opts?: unknown) => number;
    dismissToast: (toastId: number) => void;
  };
};

/**
 * Regression for the 2026-10-14 report: clicking the warning pill's
 * 立即压缩 action used to (a) flash the pill back — dismissToast +
 * contextWarnActive=false ran first, then the compress turn's first push
 * re-armed the toast (ratio still pre-compression high) — and (b) never
 * rendered the 正在压缩 pill at all, because the manual `/compress` turn
 * ran entirely inside `idle` (no user prompt set status streaming).
 * Now: dismissal lives next to beginCompressTurn, evaluateContextWarning
 * is guarded while `compressing`, and the turn streams (status flips to
 * streaming via the reducer, closed by promptCompleted / endCompressTurn).
 */
describe("ChatPanel warning pill across manual compress (P0-6 action)", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let toasts: { level: string; message: string; opts?: unknown }[];
  let dismissSpy: ReturnType<typeof vi.spyOn>;

  const flushTasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(async () => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-compresswarn-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    toasts = [];
    const fakeClient = { dispose: () => {} };
    p.client = fakeClient;
    p.historySyncBusy = false;
    p.ensureClient = async () => fakeClient;
    // The fake `/compress` turn swaps in an empty transcript synchronously,
    // standing in for the compression fold (the real turn's CompressionBlock
    // lowers the occupancy estimate below the hysteresis exit).
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) => {
        p.store.replaceTranscript([]);
        return new Promise<{ stopReason: string }>((resolve) => {
          calls.push({ prompt, resolve });
        });
      },
    ) as unknown as PanelInternals["promptWithRetry"];
    vi.spyOn(p.store, "sendToast").mockImplementation(((level: string, message: string, opts?: unknown) => {
      toasts.push({ level, message, opts });
      return 0;
    }) as unknown as PanelInternals["store"]["sendToast"]);
    dismissSpy = vi.spyOn(p.store, "dismissToast").mockImplementation((() => {}) as unknown as PanelInternals["store"]["dismissToast"]);
    p.panelVisible = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const occupancyHigh = (): void => {
    // 200-token window + ~400-token transcript → ratio 2.0 ≥ 0.90 warn.
    p.store.getUsageContext = () => ({ contextWindow: 200, estimated: false, costPrice: null });
    p.store.sessionStarted({ sessionId: "cw-session" });
    p.store.userPrompt("word ".repeat(400));
    p.store.promptCompleted("end_turn", null);
  };

  const warningToasts = (): number =>
    toasts.filter((t) => t.level === "warning" && t.message === "上下文接近上限，建议压缩").length;

  it("occupancy ≥ 90% arms the warning pill with the compress action", async () => {
    occupancyHigh();
    await flushTasks();
    expect(warningToasts()).toBe(1);
    const warn = toasts.find((t) => t.level === "warning" && t.message === "上下文接近上限，建议压缩")!;
    const action = (warn.opts as { action?: { actionId: string } })?.action;
    expect(action?.actionId).toBe("compress");
  });

  it("立即压缩 click: dismiss once, stream the turn, never re-arm mid-compress", async () => {
    occupancyHigh();
    await flushTasks();
    expect(warningToasts()).toBe(1);

    void p.handleWebviewMessage({ type: "toastAction", actionId: "compress", toastId: 0 });
    await flushTasks();
    // The turn is live: status streams (the 正在压缩 pill renders) and the
    // compressing flag suppresses any warning re-arm for its duration.
    expect(p.store.getState().status).toBe("streaming");
    expect(p.store.getState().compressing).toBe(true);
    expect(warningToasts()).toBe(1); // no re-armed pill (the 2026-10-14 flicker)
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt[0].text).toBe("/compress");

    calls[0].resolve({ stopReason: "end_turn" });
    await flushTasks();
    expect(p.store.getState().status).toBe("idle");
    expect(p.store.getState().compressing).toBe(false);
    // The fold lowered usage → no third warning push; the dismissed pill is
    // gone for good.
    expect(warningToasts()).toBe(1);
    expect(dismissSpy.mock.calls).toEqual([[0]]);
  });
});