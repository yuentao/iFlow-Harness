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

/**
 * PanelServices.osNotify test hook: whether the native toast transport "fires".
 * Default false → the in-IDE showInformationMessage fallback is exercised; true
 * covers the native path (macOS terminal-notifier / Windows SnoreToast). The
 * real transport would pop a system toast on the suite's machine, so it is
 * never spawned here — its wiring is pinned via this injection.
 */
let nativeFired = false;

/** Toast delivery is async (native attempt → fallback), so tests must drain
 * the microtask queue before asserting a toast landed. Fixed hop count beats
 * vitest-internal timer APIs for determinism. */
async function flushToastDelivery(): Promise<void> {
  for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
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
 * policy), and the removal of the mid-turn long-tool trigger (a tool terminal
 * is never the turn's terminal — screenshot 2026-10-15).
 */
describe("ChatPanel OS notifications (P0-5 wiring)", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let infoMessage: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    nativeFired = false;
    (vscode.window as unknown as { state: { focused: boolean } }).state.focused = false;
    infoMessage = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined as never);
    setConfigOverrides({ osNotifications: "all" });
    panel = new ChatPanel(makeContext(), { workspaceRoot: here, watchers: makeWatchers(), osNotify: async () => nativeFired });
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
    // Delivery is async (native-first → in-IDE fallback), so flush the
    // microtasks by unwinding the card BEFORE asserting the toast landed.
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
    await flushToastDelivery();
    expect(infoMessage).toHaveBeenCalledTimes(1);
    expect(String(infoMessage.mock.calls[0]![0])).toContain("npm test");
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
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
    await flushToastDelivery();
    expect(infoMessage).toHaveBeenCalledTimes(1);
    const msg = String(infoMessage.mock.calls[0]![0]);
    expect(msg).not.toContain("\n");
    expect(msg).toContain('python3 -c "print(1) print(1)');
    // 80-char summary + template wrapper stays a scannable single line.
    expect(msg.length).toBeLessThan(120);
  });

  it("keeps SubAgent approvals in the panel without sending an OS notification", async () => {
    const pending = p.requestPermissionFromUser({
      ...permissionRequest,
      toolCall: { ...permissionRequest.toolCall, agentId: "subagent-1" },
    });
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
    await flushToastDelivery();
    expect(infoMessage).not.toHaveBeenCalled();
  });

  it("keeps an approval silent when the SubAgent identity is only in the transcript", async () => {
    p.store.replaceState({
      ...p.store.getState(),
      blocks: [{
        kind: "subagent",
        id: "subagent-block",
        agentId: "subagent-1",
        taskToolCallId: "task-1",
        title: "SubAgent",
        status: "in_progress",
        agentType: null,
        entries: [{
          kind: "tool",
          id: "nested-tool",
          toolCallId: permissionRequest.toolCall.toolCallId,
          toolName: permissionRequest.toolCall.toolName,
          title: permissionRequest.toolCall.title,
          toolKind: "execute",
          status: "in_progress",
          output: "",
          locations: [],
          diff: null,
        }],
      }],
    });
    const pending = p.requestPermissionFromUser({
      ...permissionRequest,
      toolCall: { ...permissionRequest.toolCall, agentId: undefined },
    });
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
    await flushToastDelivery();
    expect(infoMessage).not.toHaveBeenCalled();
  });

  it("still notifies for a main-agent approval while its turn is streaming", async () => {
    p.store.userPrompt("正在生成");
    const pending = p.requestPermissionFromUser(permissionRequest);
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
    await flushToastDelivery();
    expect(infoMessage).toHaveBeenCalledTimes(1);
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
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
    await flushToastDelivery();
    expect(infoMessage).toHaveBeenCalledTimes(1);
  });

  it("throttles repeated approvals within the 5s window", async () => {
    const first = p.requestPermissionFromUser(permissionRequest);
    const second = p.requestPermissionFromUser({
      ...permissionRequest,
      toolCall: { ...permissionRequest.toolCall, toolCallId: "tool-2" },
    });
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await Promise.all([first, second]);
    await flushToastDelivery();
    expect(infoMessage).toHaveBeenCalledTimes(1);
  });

  it("drops the identical approval toast past the throttle but inside the content cooldown", async () => {
    // User screenshot 2026-10-15: an agent retrying the same tool re-fired the
    // byte-identical 「等待审批」 toast a dozen times, each >5s apart — the
    // 5s throttle never caught them. The content cooldown (60s) must.
    const first = p.requestPermissionFromUser(permissionRequest);
    vi.advanceTimersByTime(10_000); // past the 5s throttle, inside the 60s cooldown
    const second = p.requestPermissionFromUser({
      ...permissionRequest,
      toolCall: { ...permissionRequest.toolCall, toolCallId: "tool-9" },
    });
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await Promise.all([first, second]);
    await flushToastDelivery();
    expect(infoMessage).toHaveBeenCalledTimes(1);
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

  it("a long execute tool finishing mid-turn never notifies — its terminal is not the turn's", async () => {
    // User screenshot 2026-10-15: 「长任务已完成（运行 50 秒）：Shell」 while the
    // panel still showed 正在生成 — the 2026-10-13 fix only excluded `task`,
    // but ANY tool terminal lands mid-turn (the agent keeps going), so the
    // whole longTool trigger is gone. Real completion is turnDone only.
    p.onSessionUpdate(toolUpdate("in_progress", "npm run build", true));
    p.panelVisible = false;
    vi.advanceTimersByTime(31_000);
    p.onSessionUpdate(toolUpdate("completed"));
    await flushToastDelivery();
    expect(infoMessage).not.toHaveBeenCalled();
  });

  it("a failed mid-turn tool never notifies either", async () => {
    p.onSessionUpdate(toolUpdate("in_progress", "npm run build", true));
    vi.advanceTimersByTime(31_000);
    p.onSessionUpdate(toolUpdate("failed"));
    await flushToastDelivery();
    expect(infoMessage).not.toHaveBeenCalled();
  });

  it("a native toast suppresses the in-IDE duplicate (fallback is fallback-only)", async () => {
    nativeFired = true;
    const pending = p.requestPermissionFromUser(permissionRequest);
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
    await flushToastDelivery();
    expect(infoMessage).not.toHaveBeenCalled();
  });

  it("a failed turn notifies turnFailed when the user is away", async () => {
    // The failure chime alone is not a system-level cue — the errored turn
    // must announce itself like the blocking trio (default approvals tier).
    p.store.userPrompt("触发失败");
    p.store.promptCompleted("end_turn"); // idle gate for regenerate
    p.promptWithRetry = async () => {
      throw new Error("boom");
    };
    await p.regenerate();
    expect(infoMessage).toHaveBeenCalledTimes(1);
    expect(String(infoMessage.mock.calls[0]![0])).toContain("生成失败");
  });
});