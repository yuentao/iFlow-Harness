import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type { WebviewToHost } from "../shared/messages.js";
import * as vscode from "vscode";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Profile-switch choice dialog (user directive 2026-10-06, custom-modal
 * rework): switching API profiles with a live conversation open must ask —
 * via a CUSTOM webview modal (PendingProfileSwitchUi), not the native
 * showWarningMessage — whether to start a new session or keep the current
 * conversation. "Keep" reloads the SAME session in place via session/load
 * under the new credentials — seamlessly: the transcript object is never
 * replaced (no clear, no replay, no splash). "New" keeps the pre-existing
 * clear-and-start-new flow. Cancelling the dialog (keepSession: null) cancels
 * the ENTIRE switch (no secret writes, no reconnect). Without a live session
 * the switch is just the initial connect — no dialog.
 */

function makeContext(storageDir: string): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      (store.has(key) ? store.get(key) : defaultValue) as T,
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
      get: (key: string) => Promise.resolve(store.get(key) as string | undefined),
      store: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        store.delete(key);
        return Promise.resolve();
      },
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
  } as unknown as vscode.ExtensionContext;
}

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type FakeClient = {
  authenticate: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getInitializeResult: () => unknown;
};

type PanelInternals = {
  client: FakeClient | null;
  connecting: Promise<void> | null;
  discardedSessionIds: Set<string>;
  restartRestoreId: string | null;
  historySyncBusy: boolean;
  pendingSwitchModel: string | null;
  pendingProfileSwitches: Map<string, { resolve: (keepSession: boolean | null) => void }>;
  handleWebviewMessage: (msg: WebviewToHost) => Promise<void>;
  store: {
    getState: () => {
      sessionId: string | null;
      blocks: unknown[];
      status: string;
      currentModelId: string | null;
      pendingProfileSwitch: { id: string; profileName: string } | null;
    };
    sessionStarted: (meta: { sessionId: string }) => void;
    userPrompt: (text: string) => void;
  };
  queryLiveModels: () => Promise<{ id: string; name: string }[]>;
  refreshSessionList: () => Promise<unknown>;
  activateProfile: (name: string) => Promise<void>;
};

const CREDS = { baseUrl: "https://gw.example.com/v1", apiKey: "sk-test-1234", modelName: "model-b" };

function makeFakeClient(): FakeClient {
  return {
    authenticate: vi.fn(async () => ({})),
    loadSession: vi.fn(async () => ({ sessionId: "keep-session" })),
    newSession: vi.fn(async () => ({ sessionId: "fresh-session", modes: undefined, _meta: undefined })),
    cancel: vi.fn(),
    setModel: vi.fn(async () => ({ success: true, currentModelId: "model-b" })),
    setMode: vi.fn(async () => ({ success: true })),
    dispose: vi.fn(async () => {}),
    getInitializeResult: () => ({ agentCapabilities: { loadSession: true } }),
  };
}

describe("ChatPanel profile-switch session choice (custom modal)", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let iflowHome: string;
  let storageDir: string;

  beforeEach(async () => {
    // updateCurrentApiProfile / retireStaleOAuthCreds resolve ~/.iflow through
    // IFLOW_HOME — point it at a temp dir so tests never touch the real home.
    iflowHome = await mkdtemp(path.join(os.tmpdir(), "iflow-switch-test-"));
    process.env.IFLOW_HOME = iflowHome;
    // Dedicated storage dir: the transcript files this test's sessions seed
    // must not land in the shared test/transcripts dir (parallel workers race
    // there — panel-dispose.test.ts owns that path).
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-switch-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    // The profile must resolve (activateProfile reads it before the dialog).
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    // dispose() cancels any still-open dialog (resolves its switch as
    // cancelled) so a test that left the dialog unanswered cannot hang.
    await panel.dispose();
    await rm(iflowHome, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.IFLOW_HOME;
    vi.restoreAllMocks();
  });

  function seedLiveSession() {
    p.client = makeFakeClient();
    p.store.sessionStarted({ sessionId: "keep-session" });
    p.store.userPrompt("hello");
    p.store.getState().status = "idle";
  }

  async function seedProfile() {
    const secrets = (panel as unknown as { context: { secrets: { store: (k: string, v: string) => Promise<void> } } }).context.secrets;
    await secrets.store("iflow.profiles", JSON.stringify({ B: CREDS }));
  }

  /** Wait for the custom switch dialog to surface in the store; return its id. */
  async function openDialog(profileName: string): Promise<string> {
    await vi.waitFor(() => {
      const card = p.store.getState().pendingProfileSwitch;
      if (!card || card.profileName !== profileName) throw new Error("switch dialog not open yet");
    });
    return p.store.getState().pendingProfileSwitch!.id;
  }

  /** Simulate the webview answering the dialog (keepSession: null = cancel). */
  function answer(id: string, keepSession: boolean | null): Promise<void> {
    return p.handleWebviewMessage({ type: "respondProfileSwitch", id, keepSession });
  }

  it("keep-session choice reloads the SAME session in place without touching the transcript", async () => {
    seedLiveSession();
    await seedProfile();
    const blocksBefore = p.store.getState().blocks;
    const switching = p.activateProfile("B");
    const id = await openDialog("B");
    // Nothing happens while the dialog is open — the switch waits for the user.
    expect(p.client!.authenticate).not.toHaveBeenCalled();

    await answer(id, true);
    await switching;

    const client = p.client!;
    expect(client.authenticate).toHaveBeenCalledTimes(1);
    // session/load with the SAME id — not a new session.
    expect(client.loadSession).toHaveBeenCalledTimes(1);
    expect(client.loadSession.mock.calls[0]![0]).toMatchObject({ sessionId: "keep-session" });
    expect(client.newSession).not.toHaveBeenCalled();
    // Seamless: the transcript array object was never replaced.
    expect(p.store.getState().blocks).toBe(blocksBefore);
    expect(p.store.getState().sessionId).toBe("keep-session");
    // The dialog closed itself.
    expect(p.store.getState().pendingProfileSwitch).toBeNull();
    // The live session is NOT abandoned → no discard entry.
    expect(p.discardedSessionIds.has("keep-session")).toBe(false);
    // The in-flight gate is released again after the reload.
    expect(p.historySyncBusy).toBe(false);
    expect(p.restartRestoreId).toBeNull();
  });

  it("new-session choice clears transcript and starts a fresh session", async () => {
    seedLiveSession();
    await seedProfile();
    const blocksBefore = p.store.getState().blocks;
    p.queryLiveModels = async () => [];
    p.refreshSessionList = async () => [];
    const switching = p.activateProfile("B");
    const id = await openDialog("B");

    await answer(id, false);
    await switching;

    const client = p.client!;
    expect(client.authenticate).toHaveBeenCalledTimes(1);
    expect(client.loadSession).not.toHaveBeenCalled();
    expect(client.newSession).toHaveBeenCalledTimes(1);
    expect(p.discardedSessionIds.has("keep-session")).toBe(true);
    expect(p.store.getState().blocks).not.toBe(blocksBefore);
    expect(p.store.getState().sessionId).toBe("fresh-session");
  });

  it("cancel (dismiss) cancels the entire switch: no secrets write, no reconnect", async () => {
    seedLiveSession();
    await seedProfile();
    const storedSpy = vi.spyOn(
      (panel as unknown as { context: { secrets: { store: (k: string, v: string) => Promise<void> } } }).context.secrets,
      "store",
    );
    const blocksBefore = p.store.getState().blocks;
    const switching = p.activateProfile("B");
    const id = await openDialog("B");

    await answer(id, null);
    await switching;

    const client = p.client!;
    expect(client.authenticate).not.toHaveBeenCalled();
    expect(client.loadSession).not.toHaveBeenCalled();
    expect(client.newSession).not.toHaveBeenCalled();
    expect(storedSpy).not.toHaveBeenCalled();
    expect(p.store.getState().blocks).toBe(blocksBefore);
    expect(p.store.getState().sessionId).toBe("keep-session");
    expect(p.store.getState().pendingProfileSwitch).toBeNull();
  });

  it("without a live session no dialog is shown and the switch proceeds", async () => {
    await seedProfile();
    p.client = makeFakeClient();
    p.queryLiveModels = async () => [];
    p.refreshSessionList = async () => [];

    await p.activateProfile("B");

    // No dialog surfaced — the switch ran straight through.
    expect(p.store.getState().pendingProfileSwitch).toBeNull();
    expect(p.client!.authenticate).toHaveBeenCalledTimes(1);
    expect(p.client!.newSession).toHaveBeenCalledTimes(1);
  });

  it("a failed keep-session reload degrades visibly to the new-session flow", async () => {
    seedLiveSession();
    await seedProfile();
    p.client!.loadSession.mockRejectedValueOnce(new Error("load refused"));
    p.queryLiveModels = async () => [];
    p.refreshSessionList = async () => [];
    const switching = p.activateProfile("B");
    const id = await openDialog("B");

    await answer(id, true);
    await switching;

    const client = p.client!;
    expect(client.loadSession).toHaveBeenCalledTimes(1);
    // Fallback: the abandoned session is discarded and a fresh one starts.
    expect(client.newSession).toHaveBeenCalledTimes(1);
    expect(p.discardedSessionIds.has("keep-session")).toBe(true);
    expect(p.store.getState().sessionId).toBe("fresh-session");
  });

  it("a second switch while a dialog is open cancels the first (no orphaned promise)", async () => {
    seedLiveSession();
    await seedProfile();
    const firstSwitch = p.activateProfile("B");
    const firstId = await openDialog("B");

    // The webview's optimistic chip expires after 10s, re-enabling the profile
    // dropdown — a second switch must cancel the first dialog, not stack.
    const secondSwitch = p.activateProfile("B");
    await vi.waitFor(() => {
      // The first dialog's promise resolved (cancelled) → map holds only the new one.
      if (p.pendingProfileSwitches.has(firstId)) throw new Error("first dialog not cancelled");
    });
    const secondId = p.store.getState().pendingProfileSwitch!.id;
    expect(secondId).not.toBe(firstId);

    await answer(secondId, false);
    await Promise.all([firstSwitch, secondSwitch]);

    // The first switch was abandoned (never authenticated); the second ran.
    expect(p.client!.authenticate).toHaveBeenCalledTimes(1);
    expect(p.client!.newSession).toHaveBeenCalledTimes(1);
  });
});