import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import { QUEUE_MAX } from "../shared/queue.js";
import type { QueuedPromptUi, SessionState } from "../shared/messages.js";

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

type PromptCall = {
  prompt: Array<{ type: string; text?: string }>;
  resolve: (v: { stopReason: string }) => void;
  reject: (e: unknown) => void;
};

type PanelState = Pick<
  SessionState,
  "sessionId" | "status" | "queue" | "queuePaused" | "blocks" | "initializing" | "replaying"
> & { activeSessionId: string | null };

type PanelInternals = {
  client: { cancel: (id: string) => void } | null;
  panelVisible: boolean;
  historySyncBusy: boolean;
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  postToWebview: (message: unknown) => void;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  maybeGenerateAiTitle: (id: string) => Promise<void>;
  enqueuePrompt: (
    text: string,
    images?: { data: string; mimeType: string }[],
    files?: { name: string; path: string }[],
    contexts?: unknown[],
  ) => void;
  store: {
    getState: () => PanelState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: unknown) => void;
    sendToast: (...args: unknown[]) => number;
  };
};

/** Let every pending microtask AND the queued macrotasks run. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * M2 P0-3 host queue wiring: Enter while streaming enqueues (no user block,
 * no CLI call); the settled turn dispatches the FIFO head; a failed turn
 * pauses with a toast; resume/sendNow/edit/clear act through queueAction;
 * wholesale state swaps clear the queue.
 */
describe("ChatPanel message queue (P0-3 wiring)", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let toasts: { level: string; message: string }[];

  beforeEach(async () => {
    // sendPrompt awaits the M3 workspace snapshot (a real git subprocess); this
    // file tests queue wiring only, so disable checkpoints to keep the prompt
    // landing within a single flush().
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-queue-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) =>
        new Promise<{ stopReason: string }>((resolve, reject) => {
          calls.push({ prompt, resolve, reject });
        }),
    ) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.maybeGenerateAiTitle = async () => {};
    toasts = [];
    vi.spyOn(p.store, "sendToast").mockImplementation(((level: string, message: string) => {
      toasts.push({ level, message });
      return 0;
    }) as PanelInternals["store"]["sendToast"]);
    p.store.sessionStarted({ sessionId: "q-session" });
    p.panelVisible = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const send = (text: string): Promise<void> => p.handleWebviewMessage({ type: "sendPrompt", text });
  const queue = (): QueuedPromptUi[] => p.store.getState().queue ?? [];

  it("Enter while streaming enqueues: no user block, no CLI call", async () => {
    const first = send("first turn");
    await flush();
    expect(p.store.getState().status).toBe("streaming");
    const blocksBefore = p.store.getState().blocks.length;

    await send("queued second");
    expect(queue().map((q) => q.text)).toEqual(["queued second"]);
    expect(p.store.getState().blocks.length).toBe(blocksBefore); // not appended
    expect(calls).toHaveLength(1); // CLI untouched
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    await flush();
  });

  it("the settled turn dispatches the FIFO head automatically", async () => {
    const first = send("first turn");
    await flush();
    await send("queued A");
    await send("queued B");
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    // dispatchQueue runs after promptCompleted — A goes out, B stays queued
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt[0]!.text).toContain("queued A");
    expect(queue().map((q) => q.text)).toEqual(["queued B"]);
    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.prompt[0]!.text).toContain("queued B");
    expect(queue()).toHaveLength(0);
  });

  it("a failed turn pauses the queue with a warning toast; resume continues", async () => {
    const first = send("first turn");
    await flush();
    await send("queued A");
    calls[0]!.reject(new Error("gateway down"));
    await first;
    await flush();
    expect(p.store.getState().queuePaused).toBe(true);
    expect(queue()).toHaveLength(1);
    expect(calls).toHaveLength(1); // nothing dispatched into the broken endpoint
    expect(toasts.some((t) => t.level === "warning" && t.message.includes("队列已暂停"))).toBe(true);

    await p.handleWebviewMessage({ type: "queueAction", action: "resume" });
    await flush();
    expect(p.store.getState().queuePaused).toBe(false);
    expect(calls).toHaveLength(2); // resume dispatches from the errored state
    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
    expect(queue()).toHaveLength(0);
  });

  it("sendNow marks the entry, cancels the live turn, and jumps the FIFO", async () => {
    const cancel = vi.fn();
    p.client = { cancel };
    const first = send("first turn");
    await flush();
    await send("queued A");
    await send("queued B");

    const bId = queue()[1]!.id;
    await p.handleWebviewMessage({ type: "queueAction", action: "sendNow", id: bId });
    expect(cancel).toHaveBeenCalledWith("q-session"); // Steer = Stop semantics

    calls[0]!.resolve({ stopReason: "cancelled" });
    await first;
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt[0]!.text).toContain("queued B"); // B before A
    expect(queue().map((q) => q.text)).toEqual(["queued A"]);
    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("edit pops the entry back into the composer via queueEdited", async () => {
    const posts: unknown[] = [];
    vi.spyOn(p, "postToWebview").mockImplementation((m) => posts.push(m));
    const first = send("first turn");
    await flush();
    await send("queued A");
    const aId = queue()[0]!.id;

    await p.handleWebviewMessage({ type: "queueAction", action: "edit", id: aId, requestId: 7 });
    const reply = posts.find((m) => (m as { type?: string }).type === "queueEdited") as {
      requestId: number;
      text: string;
    };
    expect(reply.requestId).toBe(7);
    expect(reply.text).toBe("queued A");
    expect(queue()).toHaveLength(0); // entry leaves the queue on edit
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
  });

  it("delete and move act on the queue projection", async () => {
    const first = send("first turn");
    await flush();
    await send("A");
    await send("B");
    await send("C");

    await p.handleWebviewMessage({ type: "queueAction", action: "move", id: queue()[2]!.id, delta: -1 });
    expect(queue().map((q) => q.text)).toEqual(["A", "C", "B"]);
    await p.handleWebviewMessage({ type: "queueAction", action: "delete", id: queue()[0]!.id });
    expect(queue().map((q) => q.text)).toEqual(["C", "B"]);

    calls[0]!.reject(new Error("stop test")); // settle the live turn as failed
    await first;
    await flush();
    await p.handleWebviewMessage({ type: "queueAction", action: "clear" });
    expect(queue()).toHaveLength(0);
  });

  it("a wholesale state swap (new session / restore / profile switch) clears the queue", async () => {
    const first = send("first turn");
    await flush();
    await send("queued A");
    expect(queue()).toHaveLength(1);
    // store.onStateReplaced → clearQueue (covers every wholesale replacement)
    p.store.replaceState({ ...p.store.getState(), sessionId: "other-session" });
    expect(queue()).toHaveLength(0);
    calls[0]!.reject(new Error("session replaced"));
    await first;
    await flush();
  });

  it("QUEUE_MAX overflow is refused with a warning toast", () => {
    for (let i = 0; i < QUEUE_MAX; i++) p.enqueuePrompt(`msg ${i}`);
    expect(queue()).toHaveLength(QUEUE_MAX);
    p.enqueuePrompt("overflow");
    expect(queue()).toHaveLength(QUEUE_MAX);
    expect(toasts.some((t) => t.level === "warning" && t.message.includes("队列已满"))).toBe(true);
  });

  it("replay-in-progress rejects enqueue (restore must not race the transcript)", async () => {
    const first = send("first turn");
    await flush();
    // beginReplay also reports status "streaming" — the enqueue gate must
    // reject it via the replaying flag instead of queueing into a restore.
    p.store.replaceState({ ...p.store.getState(), replaying: true });
    await send("during replay");
    expect(queue()).toHaveLength(0);
    calls[0]!.reject(new Error("stop test"));
    await first;
    await flush();
  });

  it("contexts assemble into the prompt prefix (titled fence, never slash-leading)", async () => {
    const turn = p.handleWebviewMessage({
      type: "sendPrompt",
      text: "解释这个报错",
      contexts: [
        { id: "c1", kind: "problems", label: "工作区诊断", detail: "2 条", content: "a.ts:\n  [错误] L3: boom" },
        { id: "c2", kind: "git", label: "工作区 Git", detail: "status + diff", content: "  M a.ts" },
      ],
    });
    await flush();
    expect(calls).toHaveLength(1);
    const sent = calls[0]!.prompt[0]!.text!;
    // card order preserved, each a titled fenced section ahead of the text
    expect(sent.indexOf("工作区诊断")).toBeLessThan(sent.indexOf("工作区 Git"));
    expect(sent.indexOf("工作区 Git")).toBeLessThan(sent.indexOf("解释这个报错"));
    expect(sent).toContain("```text\na.ts:\n  [错误] L3: boom\n```");
    expect(sent.startsWith("/")).toBe(false); // CLI slash-gate discipline
    calls[0]!.resolve({ stopReason: "end_turn" });
    await turn;
    await flush();
  });
});
