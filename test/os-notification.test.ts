import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";
import { setConfigOverrides } from "./vscode-stub.js";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type { RequestPermissionRequest } from "../src/acp/protocol.js";
import type * as vscodeTypes from "vscode";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(): vscodeTypes.ExtensionContext {
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
    storageUri: { fsPath: here },
    globalStorageUri: { fsPath: here },
    storagePath: here,
    globalStoragePath: here,
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
  panelVisible: boolean;
  onSessionUpdate: (n: unknown) => void;
  requestPermissionFromUser: (req: RequestPermissionRequest) => Promise<unknown>;
  regenerate: () => Promise<void>;
  postSound: (kind: "done" | "error") => void;
  promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
  ensureClient: () => Promise<unknown>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  openEditorTab: () => void;
  store: {
    getState: () => { sessionId: string | null };
    sessionStarted: (meta: { sessionId: string }) => void;
    userPrompt: (text: string) => void;
    promptCompleted: (stopReason: string) => void;
    replaceState: (state: unknown) => void;
  };
};

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const permissionRequest: RequestPermissionRequest = {
  sessionId: "notify-session",
  toolCall: {
    toolCallId: "tool-1",
    toolName: "run_shell_command",
    title: "npm test",
    kind: "execute",
    locations: [],
  },
  options: [
    { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
    { optionId: "cancel", name: "Reject", kind: "reject_once" },
  ],
};

function toolUpdate(status: string, title?: string, initial = false): unknown {
  return {
    sessionId: "notify-session",
    update: {
      sessionUpdate: initial ? "tool_call" : "tool_call_update",
      toolCallId: "long-1",
      kind: "execute",
      status,
      ...(title !== undefined ? { title } : {}),
      content: [],
      locations: [],
    },
  };
}

/**
 * M1 P0-5 host wiring (roadmap: OS notifications gated on setting × panel
 * visibility × window focus × throttle, merged with the sound gate so one
 * event never announces itself twice). The pure gate itself is pinned in
 * notifications.test.ts; these cover what the gate alone cannot: the
 * approval-card trigger, the notification/sound exclusivity on turn
 * completion (the regenerate path shares the sendPrompt policy), and the
 * long-tool timer lifecycle (recorded regardless of visibility, cleared on
 * session switch).
 */
describe("ChatPanel OS notifications (P0-5 wiring)", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let infoMessage: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    (vscode.window as unknown as { state: { focused: boolean } }).state.focused = false;
    infoMessage = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined as never);
    setConfigOverrides({ osNotifications: "all" });
    panel = new ChatPanel(makeContext(), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    p.store.sessionStarted({ sessionId: "notify-session" });
    p.panelVisible = false;
    // Keep the turn-completion tests off the real CLI and off disk.
    p.ensureClient = async () => ({});
    p.promptWithRetry = async () => ({ stopReason: "end_turn" });
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await panel.dispose();
  });

  it("notifies when an approval card arrives while the panel is hidden; the button opens the panel", async () => {
    infoMessage.mockResolvedValue("打开面板" as never);
    const openSpy = vi.spyOn(p, "openEditorTab").mockImplementation(() => {});
    const pending = p.requestPermissionFromUser(permissionRequest);
    expect(infoMessage).toHaveBeenCalledTimes(1);
    expect(String(infoMessage.mock.calls[0]![0])).toContain("npm test");
    // Unwind the pending card via its timeout, then flush the button's .then.
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
    expect(openSpy).toHaveBeenCalled();
  });

  it("stays silent while the focused panel is visible (the card is already on screen)", async () => {
    (vscode.window as unknown as { state: { focused: boolean } }).state.focused = true;
    p.panelVisible = true;
    const pending = p.requestPermissionFromUser(permissionRequest);
    expect(infoMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
  });

  it("notifies when the panel is visible but its window is unfocused", async () => {
    p.panelVisible = true;
    const pending = p.requestPermissionFromUser(permissionRequest);
    expect(infoMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
  });

  it("throttles repeated approvals within the 5s window", async () => {
    const first = p.requestPermissionFromUser(permissionRequest);
    const second = p.requestPermissionFromUser({
      ...permissionRequest,
      toolCall: { ...permissionRequest.toolCall, toolCallId: "tool-2" },
    });
    expect(infoMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await Promise.all([first, second]);
  });

  it("regenerate completion notifies instead of chiming when the user is away", async () => {
    p.store.userPrompt("再试一次");
    p.store.promptCompleted("end_turn"); // back to idle — regenerate's gate
    const sound = vi.spyOn(p, "postSound");
    await p.regenerate();
    expect(infoMessage).toHaveBeenCalledTimes(1);
    expect(String(infoMessage.mock.calls[0]![0])).toContain("已完成本轮回复");
    // Notification and chime are mutually exclusive (one "user watching" gate).
    expect(sound).not.toHaveBeenCalled();
  });

  it("regenerate completion falls back to the chime when the gate blocks (window focused)", async () => {
    (vscode.window as unknown as { state: { focused: boolean } }).state.focused = true;
    p.store.userPrompt("再试一次");
    p.store.promptCompleted("end_turn");
    const sound = vi.spyOn(p, "postSound");
    await p.regenerate();
    expect(infoMessage).not.toHaveBeenCalled();
    expect(sound).toHaveBeenCalledWith("done");
  });

  it("a long tool that starts while the user watches still notifies after they switch away", async () => {
    p.panelVisible = true;
    p.onSessionUpdate(toolUpdate("in_progress", "npm run build", true));
    // The user switches to the editor mid-tool — recording must be
    // unconditional (2026-10 fix), the notification-time gate re-checks.
    p.panelVisible = false;
    vi.advanceTimersByTime(31_000);
    p.onSessionUpdate(toolUpdate("completed"));
    expect(infoMessage).toHaveBeenCalledTimes(1);
    expect(String(infoMessage.mock.calls[0]![0])).toContain("npm run build");
  });

  it("a quick tool never notifies", async () => {
    p.onSessionUpdate(toolUpdate("in_progress", "ls", true));
    vi.advanceTimersByTime(1_000);
    p.onSessionUpdate(toolUpdate("completed"));
    expect(infoMessage).not.toHaveBeenCalled();
  });

  it("session switch clears long-tool timers so a same-id tool in the new session cannot misfire", async () => {
    p.onSessionUpdate(toolUpdate("in_progress", "npm run build", true));
    // Session replaced (new session / restore / hot re-auth) — the wiring is
    // store.onStateReplaced → clearToolCaches.
    p.store.replaceState({ ...p.store.getState(), sessionId: "notify-session-2" });
    vi.advanceTimersByTime(31_000);
    p.onSessionUpdate({
      sessionId: "notify-session-2",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "long-1",
        kind: "execute",
        status: "completed",
        title: "npm run build",
        content: [],
        locations: [],
      },
    });
    expect(infoMessage).not.toHaveBeenCalled();
  });
});