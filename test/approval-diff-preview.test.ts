import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type { RequestPermissionRequest } from "../src/acp/protocol.js";
import type { PendingApprovalUi } from "../shared/messages.js";
import type * as vscode from "vscode";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
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
  store: {
    getState: () => { pendingApproval: PendingApprovalUi | null };
  };
  requestPermissionFromUser: (req: RequestPermissionRequest) => Promise<unknown>;
};

function permissionRequest(
  toolCall: Partial<Omit<RequestPermissionRequest["toolCall"], "toolCallId">>,
): RequestPermissionRequest {
  return {
    sessionId: "diff-session",
    toolCall: {
      toolCallId: "tool-1",
      toolName: "write_file",
      title: "Write a.ts",
      kind: "edit",
      ...toolCall,
    },
    options: [
      { optionId: "proceed_once", name: "允许一次", kind: "allow_once" },
      { optionId: "proceed_always", name: "本次会话始终允许", kind: "allow_always" },
    ],
  };
}

/**
 * Approval diff preview (P0-1): the CLI's edit-tool permission requests carry
 * the pending change on `toolCall.content` BEFORE execution (probed, CLI
 * 0.5.19 fork bundle — `shouldConfirmExecute` pushes `{type:"diff", path,
 * oldText, newText}`). The host must forward it so the card shows WHAT will
 * be written; over-cap sides drop the preview entirely (a truncated diff is
 * a lying diff).
 */
describe("approval diff preview passthrough", () => {
  let panel: ChatPanel;
  let p: PanelInternals;

  beforeEach(() => {
    panel = new ChatPanel(makeContext(), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
  });

  async function shownApproval(
    toolCall: Partial<Omit<RequestPermissionRequest["toolCall"], "toolCallId">>,
  ): Promise<PendingApprovalUi | null> {
    void p.requestPermissionFromUser(permissionRequest(toolCall));
    await Promise.resolve();
    return p.store.getState().pendingApproval;
  }

  it("forwards the structured diff from the permission request", async () => {
    const approval = await shownApproval({
      locations: [{ path: "a.ts" }],
      content: [{ type: "diff", path: "a.ts", oldText: "const x = 1;", newText: "const x = 2;" }],
    });
    expect(approval?.diff).toEqual({ path: "a.ts", oldText: "const x = 1;", newText: "const x = 2;" });
  });

  it("leaves the preview null when the request carries no diff content", async () => {
    const approval = await shownApproval({ locations: [] });
    expect(approval?.diff ?? null).toBeNull();
  });

  it("drops previews whose side exceeds the size cap", async () => {
    const huge = "x".repeat(256 * 1024 + 1);
    const approval = await shownApproval({
      content: [{ type: "diff", path: "a.ts", oldText: null, newText: huge }],
    });
    expect(approval?.diff ?? null).toBeNull();
  });
});
