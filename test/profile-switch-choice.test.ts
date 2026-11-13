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
      activeSessionId: string | null;
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
  deleteProfile: (name: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  workspaceModelId: (profileName?: string) => string | null;
  resolveWorkspaceHandshakeCreds: () => Promise<{
    baseUrl: string;
    apiKey: string;
    modelName: string;
  } | null>;
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
    // retireStaleOAuthCreds / settings paths resolve the iflow home through
    // IFLOW_HOME (the test seam) — point it at
    // a temp dir so tests never touch the real home.
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

  it("asks before re-authenticating when a transcript exists but sessionId is still null", async () => {
    await seedProfile();
    p.client = makeFakeClient();
    // Visible conversation while the panel is connecting/restoring: the ACP
    // session id is not assigned yet. The switch must not silently re-auth.
    p.store.userPrompt("hello");
    p.store.getState().status = "idle";
    p.queryLiveModels = async () => [];
    p.refreshSessionList = async () => [];

    const switching = p.activateProfile("B");
    const id = await openDialog("B");
    expect(p.client!.authenticate).not.toHaveBeenCalled();

    await answer(id, false);
    await switching;

    expect(p.client!.authenticate).toHaveBeenCalledTimes(1);
    expect(p.client!.newSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the visible transcript via activeSessionId when no live session exists yet", async () => {
    await seedProfile();
    p.client = makeFakeClient();
    p.store.userPrompt("hello");
    p.store.getState().activeSessionId = "keep-session";
    p.store.getState().status = "idle";
    p.queryLiveModels = async () => [];
    p.refreshSessionList = async () => [];

    const switching = p.activateProfile("B");
    const id = await openDialog("B");
    expect(p.client!.authenticate).not.toHaveBeenCalled();

    await answer(id, true);
    await switching;

    expect(p.client!.authenticate).toHaveBeenCalledTimes(1);
    expect(p.client!.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "keep-session" }),
    );
    expect(p.client!.newSession).not.toHaveBeenCalled();
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

  // --- Per-workspace active-profile memory ---------------------------------
  // The SecretStorage active pointer is global (shared across windows), so
  // each workspace keeps its own record of the last activated profile and
  // restores it on the next handshake (resolveWorkspaceHandshakeCreds).

  function workspaceGet(key: string): string | undefined {
    return (
      panel as unknown as { context: { workspaceState: { get: (k: string) => unknown } } }
    ).context.workspaceState.get(key) as string | undefined;
  }

  async function workspaceSet(key: string, value: string | undefined): Promise<void> {
    await (
      panel as unknown as { context: { workspaceState: { update: (k: string, v: unknown) => Promise<void> } } }
    ).context.workspaceState.update(key, value);
  }

  async function secretGet(key: string): Promise<string | undefined> {
    return (
      panel as unknown as { context: { secrets: { get: (k: string) => Promise<string | undefined> } } }
    ).context.secrets.get(key);
  }

  it("remembers the activated profile in the workspace record", async () => {
    await seedProfile();
    p.client = makeFakeClient();
    p.queryLiveModels = async () => [];
    p.refreshSessionList = async () => [];

    await p.activateProfile("B");

    expect(workspaceGet("iflow.workspaceActiveProfile")).toBe("B");
  });

  it("workspace record beats the global slot without rewriting shared credentials", async () => {
    await seedProfile(); // extension profile B
    await workspaceSet("iflow.workspaceActiveProfile", "B");
    // Global slot points at a DIFFERENT config (another window's last switch).
    const secrets = (
      panel as unknown as { context: { secrets: { store: (k: string, v: string) => Promise<void> } } }
    ).context.secrets;
    const otherCreds = { baseUrl: "https://other.example.com/v1", apiKey: "sk-other", modelName: "other-model" };
    await secrets.store("iflow.openai-compatible", JSON.stringify(otherCreds));
    await secrets.store("iflow.active-profile", "Other");

    const creds = await p.resolveWorkspaceHandshakeCreds();

    expect(creds).toEqual(CREDS);
    // The workspace resolver is read-only: another window's global slot is
    // preserved instead of being overwritten by this panel.
    expect(JSON.parse((await secretGet("iflow.openai-compatible"))!)).toEqual(otherCreds);
    expect(await secretGet("iflow.active-profile")).toBe("Other");
  });

  it("workspace record resolves CLI-sourced profiles from settings.json", async () => {
    const cliProfile = { baseUrl: "https://cli.example.com/v1", apiKey: "sk-cli-9999", modelName: "cli-model" };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(iflowHome, "settings.json"),
      JSON.stringify({ apiProfiles: { C: cliProfile } }),
      "utf8",
    );
    await workspaceSet("iflow.workspaceActiveProfile", "C");

    expect(await p.resolveWorkspaceHandshakeCreds()).toEqual(cliProfile);
  });

  it("keeps two windows on independent workspace profiles", async () => {
    const sharedSecrets = (panel as unknown as { context: { secrets: vscode.SecretStorage } }).context.secrets;
    const secondStorage = await mkdtemp(path.join(os.tmpdir(), "iflow-switch-storage-2-"));
    const secondPanel = new ChatPanel(makeContext(secondStorage), { workspaceRoot: here, watchers: makeWatchers() });
    const second = secondPanel as unknown as PanelInternals;
    try {
      const profiles = {
        A: { baseUrl: "https://a.example.com/v1", apiKey: "sk-a", modelName: "model-a" },
        B: CREDS,
      };
      await sharedSecrets.store("iflow.profiles", JSON.stringify(profiles));
      const secondSecrets = (secondPanel as unknown as { context: { secrets: vscode.SecretStorage } }).context.secrets;
      await secondSecrets.store("iflow.profiles", JSON.stringify(profiles));
      await workspaceSet("iflow.workspaceActiveProfile", "A");
      await (secondPanel as unknown as { context: { workspaceState: { update: (k: string, v: unknown) => Promise<void> } } }).context.workspaceState.update(
        "iflow.workspaceActiveProfile",
        "B",
      );

      expect(await p.resolveWorkspaceHandshakeCreds()).toEqual(profiles.A);
      expect(await second.resolveWorkspaceHandshakeCreds()).toEqual(profiles.B);
      expect(await p.resolveWorkspaceHandshakeCreds()).toEqual(profiles.A);
    } finally {
      await secondPanel.dispose();
      await rm(secondStorage, { recursive: true, force: true });
    }
  });

  it("a stale workspace record (profile deleted) falls back to null", async () => {
    await workspaceSet("iflow.workspaceActiveProfile", "Gone");
    expect(await p.resolveWorkspaceHandshakeCreds()).toBeNull();
  });

  it("deleting the remembered profile clears the workspace record", async () => {
    await seedProfile();
    await workspaceSet("iflow.workspaceActiveProfile", "B");

    await p.deleteProfile("B");

    expect(workspaceGet("iflow.workspaceActiveProfile")).toBeUndefined();
  });

  it("remembers the selected model for the active workspace profile", async () => {
    await seedProfile();
    await workspaceSet("iflow.workspaceActiveProfile", "B");
    p.client = makeFakeClient();
    p.client.setModel.mockImplementation(async (_sessionId: string, modelId: string) => ({
      success: true,
      currentModelId: modelId,
    }));
    p.store.sessionStarted({ sessionId: "model-session" });

    await p.setModel("Qwen3.8-Flash-Next");

    expect(p.workspaceModelId("B")).toBe("Qwen3.8-Flash-Next");
    expect(workspaceGet("iflow.workspaceActiveModel")).toEqual({ B: "Qwen3.8-Flash-Next" });
  });
});

/**
 * Saving an EDITED profile is not a profile switch:
 *  - the profile list is a strict upsert (renaming must not leave the old row),
 *  - editing the currently active profile must re-authenticate hot and reload
 *    the SAME session (keepSession) — the CLI keeps running and the transcript
 *    survives, instead of the cold "connecting / new session" panel reset.
 */
describe("ChatPanel saveAuth: 编辑配置的严格 upsert 与热更新", () => {
  type SavedProfile = { baseUrl: string; apiKey: string; modelName: string };

  type SaveAuthPanel = {
    client: FakeClient | null;
    discardedSessionIds: Set<string>;
    handleWebviewMessage: (msg: WebviewToHost) => Promise<void>;
    queryLiveModels: () => Promise<{ id: string; name: string }[]>;
    refreshSessionList: () => Promise<unknown>;
    startNewSession: (options?: { bypassSuperWait?: boolean }) => Promise<void>;
    reconnectWithCredentials: (
      creds: { baseUrl: string; apiKey: string; modelName: string },
      keepSession?: boolean,
    ) => Promise<void>;
    store: {
      getState: () => {
        sessionId: string | null;
        activeSessionId: string | null;
        blocks: unknown[];
        status: string;
      };
      sessionStarted: (meta: { sessionId: string }) => void;
      userPrompt: (text: string) => void;
      sessionMeta: (meta: { sessionId?: string | null; currentModelId?: string | null }) => void;
    };
  };

  let panel: ChatPanel;
  let p: SaveAuthPanel;
  let iflowHome: string;
  let storageDir: string;

  beforeEach(async () => {
    // readCliSettings / retireStaleOAuthCreds resolve through IFLOW_HOME —
    // point it at a temp dir so no test touches the real home.
    iflowHome = await mkdtemp(path.join(os.tmpdir(), "iflow-save-auth-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-save-auth-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as SaveAuthPanel;
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    await panel.dispose();
    await rm(iflowHome, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.IFLOW_HOME;
    vi.restoreAllMocks();
  });

  function secrets(): vscode.SecretStorage {
    return (panel as unknown as { context: { secrets: vscode.SecretStorage } }).context.secrets;
  }
  function workspace(): vscode.Memento {
    return (panel as unknown as { context: { workspaceState: vscode.Memento } }).context.workspaceState;
  }
  async function seedProfiles(map: Record<string, SavedProfile>): Promise<void> {
    await secrets().store("iflow.profiles", JSON.stringify(map));
  }
  async function readProfiles(): Promise<Record<string, SavedProfile>> {
    const raw = await secrets().get("iflow.profiles");
    return raw ? (JSON.parse(raw) as Record<string, SavedProfile>) : {};
  }
  function activeName(): string | undefined {
    return workspace().get<string>("iflow.workspaceActiveProfile");
  }
  function seedLiveSession(sessionId = "keep-session"): void {
    p.client = makeFakeClient();
    p.store.sessionStarted({ sessionId });
    p.store.userPrompt("hello");
    p.store.getState().status = "idle";
  }
  function stubReconnect(): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async () => {});
    p.reconnectWithCredentials = fn as unknown as SaveAuthPanel["reconnectWithCredentials"];
    return fn;
  }

  const PROFILE_A: SavedProfile = {
    baseUrl: "https://a.example.com/v1",
    apiKey: "sk-a-1111",
    modelName: "model-a",
  };

  it("同名校验：连续两次保存同名配置后列表只有一条，且内容为最后一次", async () => {
    const reconnect = stubReconnect();

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: "https://a.example.com/v1",
      apiKey: "sk-first",
      modelName: "model-a",
      profileName: "A",
    });
    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: "https://a.example.com/v1",
      apiKey: "sk-second",
      modelName: "model-a2",
      profileName: "A",
    });

    const profiles = await readProfiles();
    expect(Object.keys(profiles)).toEqual(["A"]);
    expect(profiles.A).toEqual({
      baseUrl: "https://a.example.com/v1",
      apiKey: "sk-second",
      modelName: "model-a2",
    });
    expect(activeName()).toBe("A");
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it("改名：replaceName=A、新名 B → 旧键被删除，只剩 B，指针指向 B 且保留原 Key", async () => {
    await seedProfiles({ A: PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    const reconnect = stubReconnect();

    // apiKey: null = 留空保持不变（宿主复用当前配置的 key）。
    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: "https://b.example.com/v1",
      apiKey: null,
      modelName: "model-b",
      profileName: "B",
      replaceName: "A",
    });

    const profiles = await readProfiles();
    expect(Object.keys(profiles)).toEqual(["B"]);
    expect(profiles.B).toEqual({
      baseUrl: "https://b.example.com/v1",
      apiKey: "sk-a-1111",
      modelName: "model-b",
    });
    expect(activeName()).toBe("B");
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("名称为空回退成模型名时同样不留旧键（清空名称的编辑）", async () => {
    await seedProfiles({ 本地网关: PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "本地网关");
    stubReconnect();

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: PROFILE_A.baseUrl,
      apiKey: null,
      modelName: "gemini-4-argon",
      profileName: null,
      replaceName: "本地网关",
    });

    const profiles = await readProfiles();
    expect(Object.keys(profiles)).toEqual(["gemini-4-argon"]);
    expect(activeName()).toBe("gemini-4-argon");
  });

  it("改名当前激活配置时仍按当前配置处理（reconnect 收到 keepSession=true）", async () => {
    await seedProfiles({ A: PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    seedLiveSession();
    const reconnect = stubReconnect();

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: PROFILE_A.baseUrl,
      apiKey: "sk-a-2222",
      modelName: "model-a",
      profileName: "B",
      replaceName: "A",
    });

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect.mock.calls[0]![1]).toBe(true);
  });

  it("非当前配置（新增/非激活）保存仍走原来的冷路径", async () => {
    await seedProfiles({ A: PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    seedLiveSession();
    const reconnect = stubReconnect();

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: "https://c.example.com/v1",
      apiKey: "sk-c",
      modelName: "model-c",
      profileName: "C",
    });

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect.mock.calls[0]![1]).toBe(false);
  });

  it("编辑当前配置：热路径原地重载同一会话 —— 不 dispose、不新建会话、转录不丢", async () => {
    await seedProfiles({ A: PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    seedLiveSession("keep-session");
    p.queryLiveModels = async () => [{ id: "model-a", name: "model-a" }];
    p.refreshSessionList = async () => [];
    const blocksBefore = p.store.getState().blocks;
    const client = p.client!;

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: PROFILE_A.baseUrl,
      apiKey: "sk-a-3333",
      modelName: "model-a",
      profileName: "A",
      replaceName: "A",
    });

    // The CLI process is NOT killed and no new session is started.
    expect(client.dispose).not.toHaveBeenCalled();
    expect(client.newSession).not.toHaveBeenCalled();
    // Hot re-auth + in-place session/load of the SAME conversation.
    expect(client.authenticate).toHaveBeenCalledTimes(1);
    expect(client.authenticate.mock.calls[0]![0]).toMatchObject({
      methodInfo: { apiKey: "sk-a-3333", baseUrl: PROFILE_A.baseUrl, modelName: "model-a" },
    });
    expect(client.loadSession).toHaveBeenCalledTimes(1);
    expect(client.loadSession.mock.calls[0]![0]).toMatchObject({ sessionId: "keep-session" });
    // Seamless: the transcript array object was never replaced, status never
    // dropped to "connecting" (no splash), pointer unchanged.
    expect(p.store.getState().blocks).toBe(blocksBefore);
    expect(p.store.getState().status).toBe("idle");
    expect(p.store.getState().sessionId).toBe("keep-session");
    expect(activeName()).toBe("A");
    expect(p.discardedSessionIds.has("keep-session")).toBe(false);
  });

  it("热路径 reload 失败 → 降级不抛异常，旧会话被丢弃并可见地转新会话", async () => {
    await seedProfiles({ A: PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    seedLiveSession("keep-session");
    p.client!.loadSession.mockRejectedValueOnce(new Error("load refused"));
    p.refreshSessionList = async () => [];
    // Isolate the degrade decision: the real startNewSession would need a full
    // handshake; the point here is that the panel visibly abandons the session.
    p.startNewSession = vi.fn(async () => {});

    await expect(
      p.handleWebviewMessage({
        type: "saveAuth",
        baseUrl: PROFILE_A.baseUrl,
        apiKey: "sk-a-4444",
        modelName: "model-a",
        profileName: "A",
        replaceName: "A",
      }),
    ).resolves.toBeUndefined();

    expect(p.client!.loadSession).toHaveBeenCalledTimes(1);
    expect(p.discardedSessionIds.has("keep-session")).toBe(true);
    expect(p.startNewSession).toHaveBeenCalledTimes(1);
    // The old conversation is cleared — the fallback is visible, not silent.
    expect(p.store.getState().blocks).toEqual([]);
    expect(p.store.getState().sessionId).toBeNull();
    expect(activeName()).toBe("A");
  });

  // --- 保存语义修正（空 Key 归属 / 改名冲突 / 凭据身份 / 非当前配置零重连）---

  const PROFILE_B: SavedProfile = {
    baseUrl: "https://b.example.com/v1",
    apiKey: "sk-b-9999",
    modelName: "model-b",
  };

  it("编辑非当前配置且 Key 留空：沿用被编辑配置自己的 Key，不混入当前配置的 Key", async () => {
    await seedProfiles({ A: PROFILE_A, B: PROFILE_B });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    seedLiveSession("live");
    const reconnect = stubReconnect();

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: PROFILE_B.baseUrl,
      apiKey: null,
      modelName: "model-b2",
      profileName: "B",
      replaceName: "B",
    });

    const profiles = await readProfiles();
    expect(profiles.A).toEqual(PROFILE_A);
    expect(profiles.B).toEqual({ ...PROFILE_B, modelName: "model-b2" });
    // 非当前配置的编辑不切换激活配置、不重连。
    expect(reconnect).not.toHaveBeenCalled();
    expect(activeName()).toBe("A");
  });

  it("编辑态 Key 无处可取（配置不存在且无旧 Key）：报错且不写入任何配置", async () => {
    await seedProfiles({ A: PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    const reconnect = stubReconnect();

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: "https://ghost.example.com/v1",
      apiKey: null,
      modelName: "ghost",
      profileName: "Ghost",
      replaceName: "Ghost",
    });

    expect(p.store.getState().status).toBe("error");
    expect(await readProfiles()).toEqual({ A: PROFILE_A });
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("改名撞上已存在的配置名：拒绝写入，不删除任何键、不覆盖对方凭据", async () => {
    await seedProfiles({ A: PROFILE_A, B: PROFILE_B });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    const reconnect = stubReconnect();

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: PROFILE_A.baseUrl,
      apiKey: "sk-overwrite",
      modelName: PROFILE_A.modelName,
      profileName: "B",
      replaceName: "A",
    });

    expect(await readProfiles()).toEqual({ A: PROFILE_A, B: PROFILE_B });
    expect(reconnect).not.toHaveBeenCalled();
    expect(activeName()).toBe("A");
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("已存在同名 API 配置"),
    );
  });

  it("新建配置（无 replaceName）默认名恰好等于当前激活名：不得当成「编辑当前」走热路径", async () => {
    await seedProfiles({ "model-a": PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "model-a");
    seedLiveSession("live");
    const reconnect = stubReconnect();

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: PROFILE_A.baseUrl,
      apiKey: "sk-brand-new",
      modelName: "model-a", // 默认名 = 模型名 = 当前激活名
      profileName: null,
    });

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect.mock.calls[0]![1]).toBeFalsy();
  });

  it("编辑当前配置（sessionId 仍为 null 的恢复窗口）：热路径用 activeSessionId 重载并回写 store", async () => {
    await seedProfiles({ A: PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    p.client = makeFakeClient();
    p.store.userPrompt("hello");
    const state = p.store.getState();
    state.sessionId = null;
    state.activeSessionId = "restoring-session";
    state.status = "idle";
    const client = p.client!;
    p.queryLiveModels = async () => [{ id: "model-a", name: "model-a" }];
    const blocksBefore = state.blocks;

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: PROFILE_A.baseUrl,
      apiKey: "sk-a-5555",
      modelName: PROFILE_A.modelName,
      profileName: "A",
      replaceName: "A",
    });

    expect(client.authenticate).toHaveBeenCalledTimes(1);
    expect(client.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "restoring-session" }),
    );
    expect(client.dispose).not.toHaveBeenCalled();
    expect(client.newSession).not.toHaveBeenCalled();
    // 重载成功后同步 store 的会话 id；被保留的会话不进 discarded。
    expect(p.store.getState().sessionId).toBe("restoring-session");
    expect(p.discardedSessionIds.has("restoring-session")).toBe(false);
    expect(state.blocks).toBe(blocksBefore);
    expect(state.status).toBe("idle");
  });

  it("热重载成功后：未保留的其它 live 会话记入 discarded，旧事件不漏进新状态", async () => {
    await seedProfiles({ A: PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    p.client = makeFakeClient();
    p.client.loadSession.mockImplementation(async () => {
      // 重载期间 store 切到了别的 live 会话（防御分支：它未被保留）。
      p.store.sessionMeta({ sessionId: "late-live" });
      return { sessionId: "keep-target" };
    });
    p.store.userPrompt("hello");
    const state = p.store.getState();
    state.sessionId = null;
    state.activeSessionId = "keep-target";
    state.status = "idle";
    p.queryLiveModels = async () => [{ id: "model-a", name: "model-a" }];

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: PROFILE_A.baseUrl,
      apiKey: "sk-a-6666",
      modelName: PROFILE_A.modelName,
      profileName: "A",
      replaceName: "A",
    });

    expect(p.store.getState().sessionId).toBe("keep-target");
    expect(p.discardedSessionIds.has("late-live")).toBe(true);
    expect(p.discardedSessionIds.has("keep-target")).toBe(false);
  });

  it("编辑非当前配置：不触发任何重连（client 零调用），激活指针不变", async () => {
    await seedProfiles({ A: PROFILE_A, B: PROFILE_B });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    seedLiveSession("live");
    const client = p.client!;

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: "https://b2.example.com/v1",
      apiKey: "sk-b2",
      modelName: "model-b2",
      profileName: "B",
      replaceName: "B",
    });

    for (const fn of [
      client.authenticate,
      client.loadSession,
      client.newSession,
      client.cancel,
      client.setModel,
      client.setMode,
      client.dispose,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(activeName()).toBe("A");
    expect((await readProfiles()).B).toEqual({
      baseUrl: "https://b2.example.com/v1",
      apiKey: "sk-b2",
      modelName: "model-b2",
    });
  });

  it("无 workspace 记录但实际运行凭据与某配置一致：按凭据身份识别为当前配置（热路径）", async () => {
    await seedProfiles({ Named: PROFILE_A });
    // 握手同源的全局凭据槽 = 该配置内容；workspace 指针为空（不能用名字猜）。
    await secrets().store("iflow.openai-compatible", JSON.stringify(PROFILE_A));
    p.client = makeFakeClient();
    p.store.sessionStarted({ sessionId: "live" });
    p.store.userPrompt("hello");
    p.store.getState().status = "idle";
    p.queryLiveModels = async () => [{ id: "model-a", name: "model-a" }];
    const client = p.client!;

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: PROFILE_A.baseUrl,
      apiKey: "sk-a-7777",
      modelName: PROFILE_A.modelName,
      profileName: "Named",
      replaceName: "Named",
    });

    expect(client.authenticate).toHaveBeenCalledTimes(1);
    expect(client.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "live" }));
    expect(client.dispose).not.toHaveBeenCalled();
    expect(client.newSession).not.toHaveBeenCalled();
    expect(activeName()).toBe("Named");
  });

  it("恢复/连接中编辑当前配置：只保存并刷新列表，不断连，如实提示本次连接仍用旧凭据", async () => {
    await seedProfiles({ A: PROFILE_A });
    await workspace().update("iflow.workspaceActiveProfile", "A");
    p.client = makeFakeClient();
    (p as unknown as { restoring: boolean }).restoring = true;
    const client = p.client!;

    await p.handleWebviewMessage({
      type: "saveAuth",
      baseUrl: PROFILE_A.baseUrl,
      apiKey: "sk-a-8888",
      modelName: PROFILE_A.modelName,
      profileName: "A",
      replaceName: "A",
    });

    expect(client.authenticate).not.toHaveBeenCalled();
    expect(client.dispose).not.toHaveBeenCalled();
    expect((await readProfiles()).A.apiKey).toBe("sk-a-8888");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("本次连接仍在用旧凭据"),
    );
    expect(activeName()).toBe("A");
  });
});