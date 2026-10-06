import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type { RequestPermissionRequest } from "../src/acp/protocol.js";
import type * as vscode from "vscode";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(): vscode.ExtensionContext {
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
  } as unknown as vscode.ExtensionContext;
}

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type PanelInternals = {
  client: { cancel: (sessionId: string) => void } | null;
  onSessionUpdate: (n: unknown) => void;
  store: {
    getState: () => { status: string; sessionId: string; errorMessage: string | null };
    sessionStarted: (meta: { sessionId: string }) => void;
    userPrompt: (text: string) => void;
    promptCompleted: (stopReason: string) => void;
  };
  requestPermissionFromUser: (req: RequestPermissionRequest) => Promise<unknown>;
};

const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const POST_REJECTION_IDLE_MS = 120_000;

const permissionRequest: RequestPermissionRequest = {
  sessionId: "timeout-session",
  toolCall: {
    toolCallId: "tool-1",
    toolName: "run_shell_command",
    title: "echo hi",
    kind: "execute",
    locations: [],
  },
  options: [
    { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
    { optionId: "cancel", name: "Reject", kind: "reject_once" },
  ],
};

/**
 * Regression (user-reported 2026-10-06, "审批超时自动拒绝之后一直卡在正在生成"):
 * the timeout path must (1) resolve the wire response FIRST — a throwing
 * UI-layer store call must never swallow it — and (2) arm a post-rejection
 * liveness watchdog so a wedged follow-up model request cannot strand the
 * panel on "generating" forever (the host prompt has no timeout by design,
 * pitfall #13). Wire repro (real CLI, delayed-cancelled responses) shows the
 * healthy path streams output within seconds — so the watchdog only fires on
 * a genuinely dead turn.
 */
describe("ChatPanel approval-timeout auto-reject", () => {
  let panel: ChatPanel;
  let p: PanelInternals;

  beforeEach(() => {
    vi.useFakeTimers();
    panel = new ChatPanel(makeContext(), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    p.client = { cancel: vi.fn() };
    p.store.sessionStarted({ sessionId: "timeout-session" });
    p.store.userPrompt("run something"); // status → streaming (the in-flight turn)
  });

  afterEach(async () => {
    vi.useRealTimers();
    await panel.dispose();
  });

  it("resolves the cancelled response on timeout and keeps the turn streaming", async () => {
    const pending = p.requestPermissionFromUser(permissionRequest);
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    // The turn is still in flight — the timeout must NOT flip the status.
    expect(p.store.getState().status).toBe("streaming");
  });

  it("cancels the dead turn when the post-rejection model request stays silent", async () => {
    const pending = p.requestPermissionFromUser(permissionRequest);
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
    // Zero session/update for the full liveness window → the CLI wedged after
    // our rejection: cancel the turn and surface the error (composer unlocks).
    vi.advanceTimersByTime(POST_REJECTION_IDLE_MS);
    expect(p.client!.cancel).toHaveBeenCalledWith("timeout-session");
    expect(p.store.getState().status).toBe("error");
    expect(p.store.getState().errorMessage).toContain("已自动中断本轮");
  });

  it("disarms the watchdog once the follow-up model turn produces output", async () => {
    const pending = p.requestPermissionFromUser(permissionRequest);
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    await pending;
    // The healthy path (wire-probed): the agent continues with visible output.
    p.onSessionUpdate({
      sessionId: "timeout-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "命令被取消了" } },
    });
    vi.advanceTimersByTime(POST_REJECTION_IDLE_MS);
    expect(p.client!.cancel).not.toHaveBeenCalled();
    expect(p.store.getState().status).toBe("streaming");
    // Turn end clears the watchdog permanently.
    p.store.promptCompleted("end_turn");
    expect(p.store.getState().status).toBe("idle");
    vi.advanceTimersByTime(POST_REJECTION_IDLE_MS);
    expect(p.store.getState().status).toBe("idle");
    expect(p.client!.cancel).not.toHaveBeenCalled();
  });
});
