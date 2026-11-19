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
  } as unknown as vscodeTypes.ExtensionContext;
}

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type FakeClient = {
  setMode: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

type PanelInternals = {
  client: FakeClient | null;
  panelVisible: boolean;
  /**
   * 新语义：只有 CLI 手里真的持有这一轮的 `session/prompt` 时才发
   * `session/cancel`（没在飞时那个通知是无效的，CLI 会以
   * "Not currently generating" 拒绝）。测试显式模拟「请求在飞」。
   */
  promptRequestSessionId: string | null;
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  maybeGenerateAiTitle: (id: string) => Promise<void>;
  handleRemovedPlanExit: (req: { sessionId: string; plan: string }) => { approved: boolean; reason?: string };
  log: { lines: { level: string; message: string }[] };
  store: {
    getState: () => {
      sessionId: string | null;
      modes: { currentModeId: string } | null;
      pendingApproval: unknown;
      pendingQuestions: unknown;
      [key: string]: unknown;
    };
    sessionStarted: (meta: unknown) => void;
  };
};

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const MODES = {
  currentModeId: "yolo",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "smart", name: "Smart", kind: "smart" },
    { id: "yolo", name: "YOLO" },
  ],
};

/**
 * Mode drift guard: the CLI never notifies mode changes, so the panel must
 * re-assert its authoritative mode before a turn (and never push one when the
 * turn's request has not gone out yet).
 */
describe("ChatPanel mode sync", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let client: FakeClient;
  let order: string[];

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-mode-sync-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    order = [];
    client = {
      setMode: vi.fn(async (_sessionId: string, modeId: string) => {
        order.push(`setMode:${modeId}`);
        return { success: true, currentModeId: modeId };
      }),
      cancel: vi.fn(() => {
        order.push("cancel");
      }),
    };
    p.client = client;
    p.ensureClient = async () => client;
    p.promptWithRetry = vi.fn(async () => {
      order.push("prompt");
      return { stopReason: "end_turn" };
    }) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.maybeGenerateAiTitle = async () => {};
    p.store.sessionStarted({ sessionId: "s-mode", modes: MODES });
    p.panelVisible = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("re-asserts the fixed smart mode before the prompt goes out (ignores a drifted store value)", async () => {
    await p.handleWebviewMessage({ type: "sendPrompt", text: "write something" });
    expect(order).toEqual(["setMode:smart", "prompt"]);
  });

  it("pushes the same fixed mode on every prompt (same-value push is a CLI-side no-op)", async () => {
    await p.handleWebviewMessage({ type: "sendPrompt", text: "one" });
    await p.handleWebviewMessage({ type: "sendPrompt", text: "two" });
    expect(order).toEqual(["setMode:smart", "prompt", "setMode:smart", "prompt"]);
  });

  it("pushes smart after a session starts and syncs the store echo", async () => {
    const fresh = {
      setMode: vi.fn(async () => ({ success: true, currentModeId: "smart" })),
    };
    await (
      p as unknown as {
        applyMainSessionMode: (client: unknown, sessionId: string) => Promise<void>;
      }
    ).applyMainSessionMode(fresh, "s-mode");
    expect(fresh.setMode).toHaveBeenCalledWith("s-mode", "smart");
    expect(p.store.getState().modes?.currentModeId).toBe("smart");
  });

  it("auto-approves a stale _iflow/plan/exit instead of showing a card (Plan mode removed)", () => {
    // Defensive: the CLI bundle still ships permission_mode=plan and the
    // exit_plan_mode tool, so an old archived session or an external
    // ~/.iflow/settings.json approvalMode=plan can still produce this request.
    // It must never block the agent behind a card that no longer exists.
    const response = p.handleRemovedPlanExit({ sessionId: "s-mode", plan: "1. do the thing" });
    expect(response).toEqual({ approved: true, reason: "计划模式已移除，自动继续" });
    const state = p.store.getState();
    expect(state.pendingApproval).toBeNull();
    expect(state.pendingQuestions).toBeNull();
    // No plan-exit slot survives on the state shape.
    expect((state as unknown as { pendingPlanExit?: unknown }).pendingPlanExit).toBeUndefined();
    expect(p.log.lines.some((line) => line.level === "warn" && line.message.includes("plan mode removed"))).toBe(true);
  });

  it("does not push the mode on a Stop", async () => {
    p.promptRequestSessionId = "s-mode";
    await p.handleWebviewMessage({ type: "cancel" });
    await flush();
    expect(client.setMode).not.toHaveBeenCalled();
    expect(client.cancel).toHaveBeenCalledWith("s-mode");
  });

  it("sends no session/cancel when the turn's request has not gone out yet", async () => {
    // The host flips the status to streaming before the request is issued
    // (checkpoint snapshot); a cancel there is a no-op in the CLI and used to
    // be silently lost. The click now settles the turn locally instead.
    await p.handleWebviewMessage({ type: "cancel" });
    await flush();
    expect(client.cancel).not.toHaveBeenCalled();
  });
});
