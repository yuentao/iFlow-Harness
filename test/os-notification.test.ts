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

function toolUpdate(status: string, title?: string, initial = false, toolName?: string): unknown {
  return {
    sessionId: "notify-session",
    update: {
      sessionUpdate: initial ? "tool_call" : "tool_call_update",
      toolCallId: "long-1",
      kind: "execute",
      status,
      ...(title !== undefined ? { title } : {}),
      ...(toolName !== undefined ? { toolName } : {}),
      content: [],
      locations: [],
    },
  };
}

/**
 * M1 P0-5 host wiring (roadmap: OS notifications gated on setting × panel
 * visibility × window focus × throttle). The pure gate itself is pinned in
 * notifications.test.ts; these cover what the gate alone cannot: the
 * approval-card trigger, the completion-cue policy on turn end (the chime is
 * universal — only `iflow.soundFeedback` gates it — while the turnDone toast
 * is additive per its own gate; the regenerate path shares the sendPrompt
 * policy), and the long-tool timer lifecycle (recorded regardless of
 * visibility, cleared on session switch).
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

  it("approval toast collapses a multi-line command title to one short line", async () => {
    // User report 2026-10-13: run_shell_command's title IS the whole command —
    // a 40-line python script flooded the native toast verbatim.
    const script = `python3 -c "${"print(1)\n".repeat(30)}"`;
    const pending = p.requestPermissionFromUser({
      ...permissionRequest,
      toolCall: { ...permissionRequest.toolCall, title: script },
    });
    expect(infoMessage).toHaveBeenCalledTimes(1);
    const msg = String(infoMessage.mock.calls[0]![0]);
    expect(msg).not.toContain("\n");
    expect(msg).toContain('python3 -c "print(1) print(1)');
    // 80-char summary + template wrapper stays a scannable single line.
    expect(msg.length).toBeLessThan(120);
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
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

  it("regenerate completion notifies AND chimes when the user is away (cues are additive)", async () => {
    p.store.userPrompt("再试一次");
    p.store.promptCompleted("end_turn"); // back to idle — regenerate's gate
    const sound = vi.spyOn(p, "postSound");
    await p.regenerate();
    expect(infoMessage).toHaveBeenCalledTimes(1);
    expect(String(infoMessage.mock.calls[0]![0])).toContain("已完成本轮回复");
    // The chime is universal again (2026-10-13 restore): the toast no longer
    // suppresses it — an away user gets both channels.
    expect(sound).toHaveBeenCalledWith("done");
  });

  it("regenerate completion chimes without a toast while its window stays focused", async () => {
    (vscode.window as unknown as { state: { focused: boolean } }).state.focused = true;
    p.store.userPrompt("再试一次");
    p.store.promptCompleted("end_turn");
    const sound = vi.spyOn(p, "postSound");
    await p.regenerate();
    expect(infoMessage).not.toHaveBeenCalled();
    expect(sound).toHaveBeenCalledWith("done");
  });

  it("regenerate completion chimes while the user watches the focused visible panel", async () => {
    // User report 2026-10-13: the completion chime "vanished" — the watching
    // gate silenced exactly this state, which is where users sit at turn end.
    (vscode.window as unknown as { state: { focused: boolean } }).state.focused = true;
    p.panelVisible = true;
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

  it("the SubAgent-spawning task tool never notifies — its terminal lands mid-turn", async () => {
    // User report 2026-10-13: 「长任务已完成（运行 306 秒）：Task」 fired while
    // the panel still showed 正在生成 — the subagent landing is NOT the user's
    // task finishing; the parent agent keeps generating afterwards.
    p.onSessionUpdate(toolUpdate("in_progress", "Task", true, "Task"));
    vi.advanceTimersByTime(31_000);
    p.onSessionUpdate(toolUpdate("completed", undefined, false, "Task"));
    expect(infoMessage).not.toHaveBeenCalled();
  });

  it("a failed long tool is announced as failed, not completed", async () => {
    p.onSessionUpdate(toolUpdate("in_progress", "npm run build", true));
    vi.advanceTimersByTime(31_000);
    p.onSessionUpdate(toolUpdate("failed"));
    expect(infoMessage).toHaveBeenCalledTimes(1);
    expect(String(infoMessage.mock.calls[0]![0])).toContain("长任务失败");
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