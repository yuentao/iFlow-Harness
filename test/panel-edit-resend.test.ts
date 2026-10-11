import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { Block, CheckpointUi } from "../shared/messages.js";

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
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  confirmAndRestoreCheckpointFiles: (sessionId: string, entry: CheckpointUi) => Promise<boolean>;
  store: {
    getState: () => { blocks: Block[]; status: string; checkpoints?: CheckpointUi[] };
    sessionStarted: (meta: { sessionId: string }) => void;
    setCheckpoints: (list: CheckpointUi[]) => void;
    sendToast: (...args: unknown[]) => number;
    appendNotice: (text: string) => void;
  };
};

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * M4 P1-9 — edit & resend orchestration: truncate the edited turn and its
 * tail (transcript-only when no CLI client is attached), then re-send the
 * edited text through the normal prompt pipeline. Refused/empty/gated inputs
 * never truncate and never send.
 */
describe("ChatPanel edit & resend (P1-9 wiring)", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let toasts: { level: string; message: string }[];
  let notices: string[];

  beforeEach(async () => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-editresend-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) =>
        new Promise<{ stopReason: string }>((resolve) => {
          calls.push({ prompt, resolve });
        }),
    ) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.confirmAndRestoreCheckpointFiles = async () => true;
    // No client attached → deleteUserMessage takes the transcript-only path
    // (no CLI session file to rewrite).
    p.client = null;
    toasts = [];
    notices = [];
    vi.spyOn(p.store, "sendToast").mockImplementation(((level: string, message: string) => {
      toasts.push({ level, message });
      return 0;
    }) as PanelInternals["store"]["sendToast"]);
    vi.spyOn(p.store, "appendNotice").mockImplementation(((text: string) => {
      notices.push(text);
    }) as PanelInternals["store"]["appendNotice"]);
    p.store.sessionStarted({ sessionId: "er-session" });
    p.panelVisible = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const send = (text: string): Promise<void> => p.handleWebviewMessage({ type: "sendPrompt", text });
  const userTexts = (): string[] =>
    p.store.getState().blocks.filter((b) => b.kind === "user").map((b) => (b as Extract<Block, { kind: "user" }>).text);
  const firstUserId = (): string => {
    const b = p.store.getState().blocks.find((x) => x.kind === "user");
    return b!.id!;
  };

  it("edits an old turn: truncates it and everything after, resends the edited text", async () => {
    const first = send("first turn");
    await flush();
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    const second = send("second turn");
    await flush();
    calls[1]!.resolve({ stopReason: "end_turn" });
    await second;
    await flush();
    expect(userTexts()).toEqual(["first turn", "second turn"]);

    const targetId = firstUserId();
    // editAndResend awaits the re-sent turn end-to-end — fire without await
    // (the prompt promise stays pending until we settle it below).
    void p.handleWebviewMessage({ type: "editAndResend", blockId: targetId, text: "  edited first  " });
    await flush();

    // The edited turn REPLACED the old tail: exactly one user block, the
    // trimmed edited text, and it went out through the prompt pipeline.
    expect(userTexts()).toEqual(["edited first"]);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.prompt[0]!.text).toContain("edited first");
    calls[2]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("resends with a checkpoint restore first when the snapshot is complete", async () => {
    const first = send("first turn");
    await flush();
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    const targetId = firstUserId();
    p.store.setCheckpoints([
      { userBlockId: targetId, turnIndex: 0, createdAt: Date.now(), partial: false, sha: "deadbeef", label: "first turn" },
    ]);
    const restoreSpy = vi.spyOn(p, "confirmAndRestoreCheckpointFiles");

    void p.handleWebviewMessage({ type: "editAndResend", blockId: targetId, text: "edited" });
    await flush();

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(0); // no degrade warning when a snapshot exists
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt[0]!.text).toContain("edited");
    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("cancelled file restore aborts before any truncation", async () => {
    const first = send("first turn");
    await flush();
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    const targetId = firstUserId();
    p.store.setCheckpoints([
      { userBlockId: targetId, turnIndex: 0, createdAt: Date.now(), partial: false, sha: "deadbeef", label: "first turn" },
    ]);
    p.confirmAndRestoreCheckpointFiles = async () => false;

    await p.handleWebviewMessage({ type: "editAndResend", blockId: targetId, text: "edited" });
    await flush();

    expect(userTexts()).toEqual(["first turn"]); // transcript untouched
    expect(calls).toHaveLength(1); // nothing re-sent
  });

  it("missing/partial checkpoint degrades to truncate-and-resend with a warning toast", async () => {
    const first = send("first turn");
    await flush();
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;

    void p.handleWebviewMessage({ type: "editAndResend", blockId: firstUserId(), text: "edited" });
    await flush();

    expect(toasts.some((t) => t.level === "warning" && t.message.includes("仅截断对话后重发"))).toBe(true);
    expect(userTexts()).toEqual(["edited"]);
    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("empty edited text refuses: no truncation, no send", async () => {
    const first = send("first turn");
    await flush();
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;

    await p.handleWebviewMessage({ type: "editAndResend", blockId: firstUserId(), text: "   " });
    await flush();

    expect(userTexts()).toEqual(["first turn"]);
    expect(calls).toHaveLength(1);
    expect(notices.some((n) => n.includes("编辑后的消息为空"))).toBe(true);
  });

  it("gated while streaming: refuses with a notice", async () => {
    const first = send("first turn");
    await flush();
    // first turn still streaming…
    const second = send("second turn"); // → queued, status stays streaming
    await flush();
    void second;

    await p.handleWebviewMessage({ type: "editAndResend", blockId: firstUserId(), text: "edited" });
    expect(notices.some((n) => n.includes("请先完成当前操作"))).toBe(true);
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    await flush();
    // The queued second turn auto-dispatched — settle it so the test exits
    // with no dangling prompt promise.
    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
  });
});
