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
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  maybeGenerateAiTitle: (id: string) => Promise<void>;
  requestPlanExitFromUser: (req: { sessionId: string; plan: string }) => Promise<{ approved: boolean }>;
  store: {
    getState: () => { sessionId: string | null; modes: { currentModeId: string } | null };
    sessionStarted: (meta: unknown) => void;
  };
};

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const MODES = {
  currentModeId: "plan",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan", kind: "plan" },
  ],
};

/**
 * Mode drift guard: the CLI never notifies mode changes, so the panel must
 * re-assert its authoritative mode before a turn and right after a user Stop
 * cancels a pending Plan-exit card (session 439fd54b: the composer kept
 * showing 计划 while the CLI had left Plan mode and the agent could write).
 */
describe("ChatPanel plan-mode sync", () => {
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
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("re-asserts the panel mode before the prompt goes out", async () => {
    await p.handleWebviewMessage({ type: "sendPrompt", text: "write something" });
    expect(order).toEqual(["setMode:plan", "prompt"]);
  });

  it("re-asserts the mode after Stop cancels a pending Plan-exit card", async () => {
    const pending = p.requestPlanExitFromUser({ sessionId: "s-mode", plan: "do the thing" });
    await flush();
    expect(order).toEqual([]);

    await p.handleWebviewMessage({ type: "cancel" });
    await flush();

    await expect(pending).resolves.toMatchObject({ approved: false });
    // The CLI is told to stay in Plan mode AFTER the interrupt — the drift
    // that let the agent write files behind a 计划 composer.
    expect(client.setMode).toHaveBeenLastCalledWith("s-mode", "plan");
    expect(order).toEqual(["cancel", "setMode:plan"]);
  });

  it("does not push the mode on a Stop with no Plan card pending", async () => {
    await p.handleWebviewMessage({ type: "cancel" });
    await flush();
    expect(client.setMode).not.toHaveBeenCalled();
    expect(client.cancel).toHaveBeenCalledWith("s-mode");
  });
});
