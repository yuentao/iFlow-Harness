import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
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
  client: { cancel: (id: string) => void; cancelAgent?: (sessionId: string, agentId: string) => Promise<{ stopped?: boolean; reason?: string }> } | null;
  panelVisible: boolean;
  historySyncBusy: boolean;
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  postToWebview: (message: unknown) => void;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  maybeGenerateAiTitle: (id: string) => Promise<void>;
  completeInternalPrompt: (text: string, timeoutMs: number, idleMs: number) => Promise<string | null>;
  store: {
    getState: () => PanelState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: unknown) => void;
    sendToast: (...args: unknown[]) => number;
    appendRelayMessage: (text: string) => void;
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

  it("returns host-owned turn diffs with correlation and rejects stale sessions", async () => {
    const post = vi.spyOn(p, "postToWebview").mockImplementation(() => {});
    p.store.replaceState({ ...p.store.getState(), status: "idle", blocks: [
      { kind: "user", id: "u", text: "go" },
      { kind: "tool", toolCallId: "edit", title: "edit", status: "completed", diff: { path: "a", oldText: "a", newText: "b" } },
    ] });
    const request = { type: "requestTurnChanges", sessionId: "q-session", userBlockId: "u", requestId: "r" };
    await p.handleWebviewMessage(request);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "turnChanges", requestId: "r", userBlockId: "u", unavailable: false, records: [expect.objectContaining({ toolCallId: "edit" })] }));
    await p.handleWebviewMessage({ ...request, sessionId: "old" });
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ unavailable: true, records: [] }));
    const open = vi.fn();
    Object.assign(p, { openToolDiff: open });
    await p.handleWebviewMessage({ type: "openDiff", sessionId: "old", toolCallId: "edit" });
    expect(open).not.toHaveBeenCalled();
  });

  it("routes single-file undo with its turn anchor", async () => {
    const revert = vi.fn();
    Object.assign(p, { revertTurnFile: revert });
    await p.handleWebviewMessage({ type: "revertTurnFile", sessionId: "q-session", userBlockId: "u", key: "src/a.ts" });
    expect(revert).toHaveBeenCalledWith("q-session", "u", "src/a.ts");
  });

  it("Enter while streaming dispatches a child session: no queue, no CLI call", async () => {
    const first = send("first turn");
    await flush();
    expect(p.store.getState().status).toBe("streaming");
    const blocksBefore = p.store.getState().blocks.length;
    const spawn = vi.fn((_spec: { title: string; task: string }) => ({ id: "super-1" }));
    Object.assign(p, { getSuperAgent: () => ({ spawn }) });

    await send("delegate this");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ title: "delegate this", task: "delegate this" });
    expect(queue()).toHaveLength(0); // no local queue entry
    expect(p.store.getState().blocks.length).toBe(blocksBefore); // not appended
    expect(calls).toHaveLength(1); // CLI untouched
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    await flush();
  });

  it("child-session reports relay in parallel while the main turn streams", async () => {
    const first = send("first turn");
    await flush();
    expect(p.store.getState().status).toBe("streaming");
    let release: (v: string | null) => void = () => {};
    const complete = vi.fn(() => new Promise<string | null>((r) => { release = r; }));
    const append = vi.fn();
    Object.assign(p, {
      completeInternalPrompt: complete,
      superAgent: { reportPrompt: () => "[子会话状态上报] ok" },
    });
    p.store.appendRelayMessage = append;

    const internals = p as unknown as {
      queueSuperReport: (entries: unknown[]) => void;
    };
    internals.queueSuperReport([{ session: { id: "super-1", title: "t" }, report: { state: "done", summary: "ok" } }]);
    await flush();
    expect(complete).toHaveBeenCalledTimes(1); // started immediately, no idle wait
    expect(append).not.toHaveBeenCalled(); // still in flight

    release("汇报正文");
    await flush();
    expect(append).toHaveBeenCalledWith("汇报正文");
    expect(p.store.getState().status).toBe("streaming"); // main turn untouched

    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    await flush();
  });

  it("subagent stop routes to _iflow/agent/cancel without cancelling the turn", async () => {
    const cancelTurn = vi.fn();
    const cancelAgent = vi.fn(async (_sessionId: string, agentId: string) =>
      agentId === "child" ? { stopped: true } : { stopped: false, reason: "not_found" });
    p.client = { cancel: cancelTurn, cancelAgent };
    const blocks = [{
      kind: "subagent", agentId: "parent", taskToolCallId: "root", title: "root", agentType: null, status: "in_progress", entries: [{
        kind: "subagent", agentId: "child", taskToolCallId: "task-child", title: "child", agentType: null, status: "pending", entries: [],
      }],
    }];
    p.store.replaceState({ ...p.store.getState(), status: "streaming", blocks: structuredClone(blocks) });
    // gate: wrong session / unknown agent never reach the wire
    await p.handleWebviewMessage({ type: "stopSubagent", sessionId: "old-session", agentId: "child" });
    await p.handleWebviewMessage({ type: "stopSubagent", sessionId: "q-session", agentId: "missing" });
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(cancelTurn).not.toHaveBeenCalled();
    // confirmed stop: card flips to stopped, the TURN keeps running
    await p.handleWebviewMessage({ type: "stopSubagent", sessionId: "q-session", agentId: "child" });
    expect(cancelAgent).toHaveBeenCalledExactlyOnceWith("q-session", "child");
    expect(cancelTurn).not.toHaveBeenCalled();
    const stopped = (p.store.getState().blocks[0] as { entries: { agentId: string; stopped?: boolean; status: string }[] })
      .entries.find((e) => e.agentId === "child")!;
    expect(stopped.stopped).toBe(true);
    expect(stopped.status).toBe("failed");
    expect(p.store.getState().status).toBe("streaming");
    // not_found answers with an info toast, no card mutation
    p.store.replaceState({ ...p.store.getState(), blocks: structuredClone(blocks) });
    await p.handleWebviewMessage({ type: "stopSubagent", sessionId: "q-session", agentId: "parent" });
    expect(toasts.at(-1)?.message).toContain("该子代理已结束");
    // a terminal card is no longer a valid target
    p.store.replaceState({ ...p.store.getState(), status: "idle" });
    await p.handleWebviewMessage({ type: "stopSubagent", sessionId: "q-session", agentId: "child" });
    expect(cancelAgent).toHaveBeenCalledTimes(2);
    p.client = null;
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
