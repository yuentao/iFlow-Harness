import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { SessionUsageUi } from "../shared/messages.js";

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

type PanelInternals = {
  client: unknown;
  historySyncBusy: boolean;
  autoCompressInFlight: boolean;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  maybeAutoCompressOnIdle: (sessionId: string) => Promise<boolean>;
  store: {
    getState: () => {
      sessionId: string | null;
      status: string;
      usage?: SessionUsageUi | null;
      pendingApproval: unknown;
      pendingPlanExit: unknown;
      pendingQuestions: unknown;
    };
    sessionStarted: (meta: { sessionId: string }) => void;
    sendToast: (...args: unknown[]) => number;
    dismissToast: (id: number) => void;
  };
};

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function usage(window: number | null, used: number, estimated = false): SessionUsageUi {
  return {
    inputTokens: used,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: used,
    contextWindow: window,
    contextUsed: used,
    estimated,
  };
}

/**
 * Turn-end PROACTIVE compression (2026-10-11): the reactive overflow path in
 * promptWithRetry only fires when the gateway REJECTS a turn — a session that
 * creeps up on its window never trips it. maybeAutoCompressOnIdle closes the
 * gap at the idle boundary, guarded so a guessed (estimated) window — the hy3
 * 32K-fallback misreport — never compresses a healthy session.
 */
describe("turn-end proactive compression (maybeAutoCompressOnIdle)", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let compressCalls: unknown[][];
  let toasts: { level: string; message: string }[];
  let dismissed: number[];

  beforeEach(async () => {
    setConfigOverrides({ checkpoints: false, autoCompressOnIdle: true });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-autocompress-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    compressCalls = [];
    toasts = [];
    dismissed = [];
    const fakeClient = {};
    p.client = fakeClient;
    p.ensureClient = async () => fakeClient;
    p.persistActiveTranscript = async () => {};
    p.promptWithRetry = vi.fn(async (_c: unknown, _s: string, prompt: unknown) => {
      compressCalls.push([prompt]);
      return { stopReason: "end_turn" };
    }) as unknown as PanelInternals["promptWithRetry"];
    vi.spyOn(p.store, "sendToast").mockImplementation(((level: string, message: string) => {
      toasts.push({ level, message });
      return 7;
    }) as unknown as PanelInternals["store"]["sendToast"]);
    vi.spyOn(p.store, "dismissToast").mockImplementation(((id: number) => {
      dismissed.push(id);
    }) as unknown as PanelInternals["store"]["dismissToast"]);
    p.store.sessionStarted({ sessionId: "ac-session" });
    const st = p.store.getState();
    st.status = "idle";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const setUsage = (u: SessionUsageUi | null) => {
    (p.store.getState() as { usage?: SessionUsageUi | null }).usage = u;
  };

  it("compresses at ≥95% with a real window, driving /compress + pill lifecycle", async () => {
    setUsage(usage(1000, 970));
    const compressed = await p.maybeAutoCompressOnIdle("ac-session");
    expect(compressed).toBe(true);
    expect(compressCalls).toHaveLength(1);
    const prompt = compressCalls[0]![0] as Array<{ type: string; text?: string }>;
    expect(prompt[0]!.text).toBe("/compress");
    expect(toasts[0]!.level).toBe("info");
    expect(dismissed).toEqual([7]);
  });

  it("is opt-in: without the setting (shipped default off) no turn-end compression runs", async () => {
    // beforeEach enabled it — reset to the default (absent = false).
    setConfigOverrides({ checkpoints: false });
    setUsage(usage(1000, 990));
    await p.maybeAutoCompressOnIdle("ac-session");
    expect(compressCalls).toHaveLength(0);
    expect(toasts).toHaveLength(0);
  });

  it("stays silent below 95% (the 90% warning pill owns that band)", async () => {
    setUsage(usage(1000, 940));
    const compressed = await p.maybeAutoCompressOnIdle("ac-session");
    expect(compressed).toBe(false);
    expect(compressCalls).toHaveLength(0);
    expect(toasts).toHaveLength(0);
  });

  it("uses the configured threshold (iflow.autoCompressThresholdPercent)", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoCompressOnIdle: true,
      autoCompressThresholdPercent: 80,
    });
    setUsage(usage(1000, 850));
    expect(await p.maybeAutoCompressOnIdle("ac-session")).toBe(true);
    expect(compressCalls).toHaveLength(1);
  });

  it("stays silent below the configured threshold", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoCompressOnIdle: true,
      autoCompressThresholdPercent: 80,
    });
    setUsage(usage(1000, 700));
    expect(await p.maybeAutoCompressOnIdle("ac-session")).toBe(false);
    expect(compressCalls).toHaveLength(0);
    expect(toasts).toHaveLength(0);
  });

  it("estimated window NEVER compresses (the hy3 32K-fallback false-positive guard)", async () => {
    setUsage(usage(32768, 40000, true));
    await p.maybeAutoCompressOnIdle("ac-session");
    expect(compressCalls).toHaveLength(0);
    expect(toasts).toHaveLength(0);
  });

  it("skips while a card is pending (approval/question/plan own the session)", async () => {
    setUsage(usage(1000, 990));
    p.store.getState().pendingApproval = { id: "a1" };
    await p.maybeAutoCompressOnIdle("ac-session");
    expect(compressCalls).toHaveLength(0);
  });

  it("skips a non-idle session (streaming turn owns the CLI)", async () => {
    setUsage(usage(1000, 990));
    p.store.getState().status = "streaming";
    await p.maybeAutoCompressOnIdle("ac-session");
    expect(compressCalls).toHaveLength(0);
  });

  it("skips a session switch mid-flight", async () => {
    setUsage(usage(1000, 990));
    await p.maybeAutoCompressOnIdle("other-session");
    expect(compressCalls).toHaveLength(0);
  });

  it("re-entrancy guard: a compress turn already in flight blocks a second one", async () => {
    setUsage(usage(1000, 990));
    p.autoCompressInFlight = true;
    await p.maybeAutoCompressOnIdle("ac-session");
    expect(compressCalls).toHaveLength(0);
  });

  it("failed compress warns instead of erroring, and releases the guard", async () => {
    setUsage(usage(1000, 990));
    p.promptWithRetry = vi.fn(async () => {
      throw new Error("compress exploded");
    }) as unknown as PanelInternals["promptWithRetry"];
    await p.maybeAutoCompressOnIdle("ac-session");
    expect(toasts.some((t) => t.level === "warning" && t.message.includes("compress exploded"))).toBe(true);
    expect(dismissed).toEqual([7]);
    // Guard released: the next turn-end can try again.
    expect(p.autoCompressInFlight).toBe(false);
  });

  it("no usage / null window stays silent", async () => {
    setUsage(null);
    await p.maybeAutoCompressOnIdle("ac-session");
    setUsage(usage(null, 5000));
    await p.maybeAutoCompressOnIdle("ac-session");
    expect(compressCalls).toHaveLength(0);
  });

  it("flush is a no-op helper sanity check", async () => {
    await flush();
    expect(compressCalls).toHaveLength(0);
  });
});

/**
 * Wiring check: the hook sits on the settled-turn path, and the compress turn
 * lands BEFORE the next queued message dispatches (the queued prompt rides the
 * smaller context).
 */
describe("sendPrompt turn-end wiring → proactive compress → queue order", () => {
  let panel: ChatPanel;
  let p: PanelInternals & {
    handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
    panelVisible: boolean;
    enqueuePrompt: (text: string) => void;
  };
  let storageDir: string;
  let promptTexts: string[];

  beforeEach(async () => {
    setConfigOverrides({ checkpoints: false, autoCompressOnIdle: true });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-autocompress-e2e-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as typeof p;
    promptTexts = [];
    const fakeClient = {};
    p.client = fakeClient;
    p.ensureClient = async () => fakeClient;
    p.persistActiveTranscript = async () => {};
    (p as unknown as { touchActiveSession: () => Promise<void> }).touchActiveSession = async () => {};
    (p as unknown as {
      runTurnFollowup: (id: string, opts: { allowTitle: boolean; conversationTasks: boolean }) => Promise<void>;
    }).runTurnFollowup = async () => {};
    p.promptWithRetry = vi.fn(async (_c: unknown, _s: string, prompt: unknown) => {
      const blocks = prompt as Array<{ type: string; text?: string }>;
      promptTexts.push(blocks[0]?.text ?? "");
      return { stopReason: "end_turn" };
    }) as unknown as PanelInternals["promptWithRetry"];
    // promptCompleted's refreshSessionUsage recomputes usage from the
    // (tiny) test transcript and would wipe the seeded 97%. Restore it after
    // the FIRST settle (triggering the compress); every later settle models a
    // post-compression session (30%) so the chain stops after one compress.
    const settleOriginal = p.store.promptCompleted.bind(p.store);
    let settles = 0;
    vi.spyOn(p.store, "promptCompleted").mockImplementation(((stopReason: string) => {
      settles++;
      settleOriginal(stopReason);
      (p.store.getState() as { usage?: SessionUsageUi | null }).usage =
        settles === 1 ? usage(1000, 970) : usage(1000, 300);
    }) as unknown as typeof p.store.promptCompleted);
    p.store.sessionStarted({ sessionId: "wire-session" });
    p.panelVisible = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("settled turn auto-compresses at ≥95%, then the queued message rides the compressed context", async () => {
    const st = p.store.getState() as { status: string; usage?: SessionUsageUi | null };
    st.status = "idle";
    st.usage = usage(1000, 970);
    // Queue a follow-up BEFORE the turn settles (Steer semantics).
    p.enqueuePrompt("next question");
    await p.handleWebviewMessage({ type: "sendPrompt", text: "first question" });
    // sendPrompt is fired-and-forgotten by the message router; wait for the
    // whole chain (prompt → compress → queue dispatch) to settle.
    const deadline = Date.now() + 2000;
    while (promptTexts.length < 3 && Date.now() < deadline) await flush();
    expect(promptTexts).toEqual(["first question", "/compress", "next question"]);
  });
});

/**
 * Compression is housekeeping, not conversation: neither a user-typed
 * `/compress` turn nor a turn-end auto-compress may feed the conversation
 * tasks of the merged turn-end request (next-step chips / memory candidates).
 * The title task is not conversation-derived, so it stays allowed — it only
 * replaces a still-mechanical session label.
 */
describe("turn-end follow-up gating", () => {
  type GateInternals = {
    client: unknown;
    panelVisible: boolean;
    ensureClient: () => Promise<unknown>;
    persistActiveTranscript: () => Promise<void>;
    touchActiveSession: () => Promise<void>;
    runTurnFollowup: (
      sessionId: string,
      opts: { allowTitle: boolean; conversationTasks: boolean },
    ) => Promise<void>;
    promptWithRetry: (
      client: unknown,
      sessionId: string,
      prompt: unknown,
    ) => Promise<{ stopReason: string }>;
    maybeAutoCompressOnIdle: (sessionId: string) => Promise<boolean>;
    handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
    store: {
      getState: () => { status: string };
      sessionStarted: (meta: { sessionId: string }) => void;
    };
  };

  let panel: ChatPanel;
  let p: GateInternals;
  let storageDir: string;
  let promptTexts: string[];
  let followups: Array<{ sessionId: string; opts: { allowTitle: boolean; conversationTasks: boolean } }>;

  beforeEach(async () => {
    setConfigOverrides({ checkpoints: false, autoCompressOnIdle: true });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-followup-gate-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as GateInternals;
    promptTexts = [];
    followups = [];
    const fakeClient = {};
    p.client = fakeClient;
    p.ensureClient = async () => fakeClient;
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.runTurnFollowup = async (sessionId, opts) => {
      followups.push({ sessionId, opts });
    };
    p.promptWithRetry = vi.fn(async (_c: unknown, _s: string, prompt: unknown) => {
      const blocks = prompt as Array<{ type: string; text?: string }>;
      promptTexts.push(blocks[0]?.text ?? "");
      return { stopReason: "end_turn" };
    }) as unknown as GateInternals["promptWithRetry"];
    p.maybeAutoCompressOnIdle = vi.fn(async () => false) as unknown as GateInternals["maybeAutoCompressOnIdle"];
    p.store.sessionStarted({ sessionId: "followup-gate-session" });
    p.store.getState().status = "idle";
    p.panelVisible = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("keeps only the title task after a user-typed /compress turn", async () => {
    await p.handleWebviewMessage({ type: "sendPrompt", text: "/compress" });
    expect(promptTexts).toEqual(["/compress"]);
    expect(followups).toEqual([
      { sessionId: "followup-gate-session", opts: { allowTitle: true, conversationTasks: false } },
    ]);
  });

  it("keeps only the title task when the turn-end auto-compress ran", async () => {
    p.maybeAutoCompressOnIdle = vi.fn(async () => true) as unknown as GateInternals["maybeAutoCompressOnIdle"];
    await p.handleWebviewMessage({ type: "sendPrompt", text: "普通问题" });
    expect(followups).toEqual([
      { sessionId: "followup-gate-session", opts: { allowTitle: true, conversationTasks: false } },
    ]);
  });

  it("runs the whole batch after a normal turn", async () => {
    await p.handleWebviewMessage({ type: "sendPrompt", text: "普通问题" });
    expect(followups).toEqual([
      { sessionId: "followup-gate-session", opts: { allowTitle: true, conversationTasks: true } },
    ]);
  });
});

/**
 * A `/compress` turn may be bounded by `iflow.compressTimeoutSeconds` (0 = no
 * limit, the historical behaviour). When the ceiling fires, the local
 * watchdog abandoned the JSON-RPC request but the CLI turn keeps running —
 * the panel must cancel it explicitly, or the session keeps streaming a
 * compression nobody waits for.
 */
describe("compress turn ceiling (iflow.compressTimeoutSeconds)", () => {
  type CeilingInternals = {
    promptWithRetry: (
      client: unknown,
      sessionId: string,
      prompt: unknown,
    ) => Promise<{ stopReason: string }>;
  };

  let panel: ChatPanel;
  let p: CeilingInternals;
  let storageDir: string;

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false, compressTimeoutSeconds: 30 });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-compress-ceiling-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as CeilingInternals;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  /** Fake client that records the per-call timeout the panel passes down
   * (0 = the panel passed none, i.e. no wall-clock ceiling). */
  const fakeClient = (captured: number[], stopReason = "end_turn") => ({
    prompt: vi.fn(async (_request: unknown, timeoutMs?: number) => {
      captured.push(timeoutMs ?? 0);
      return { stopReason };
    }),
    cancel: vi.fn(),
  });

  it("passes the configured ceiling to a /compress turn", async () => {
    const captured: number[] = [];
    await p.promptWithRetry(fakeClient(captured), "ac-session", [{ type: "text", text: "/compress" }]);
    expect(captured).toEqual([30_000]);
  });

  it("leaves a regular turn unbounded", async () => {
    const captured: number[] = [];
    // "cancelled" skips the empty-response retry ladder (it only fires on
    // an `end_turn` without agent output) — the assertion is the timeout.
    await p.promptWithRetry(fakeClient(captured, "cancelled"), "ac-session", [{ type: "text", text: "普通问题" }]);
    expect(captured).toEqual([0]);
  });

  it("cancels the still-running CLI turn when the ceiling fires", async () => {
    const client = {
      prompt: vi.fn(async () => {
        throw { code: -32603, message: "Request timed out after 30000ms: session/prompt" };
      }),
      cancel: vi.fn(),
    };
    await expect(
      p.promptWithRetry(client, "ac-session", [{ type: "text", text: "/compress" }]),
    ).rejects.toThrow(/压缩超时/);
    expect(client.cancel).toHaveBeenCalledWith("ac-session");
  });
});
