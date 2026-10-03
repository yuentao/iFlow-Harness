import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ChatPanel, DisposedError } from "../src/panel/panel.js";
import { acpSessionFilePath } from "../src/acp/models-query.js";
import type { PanelServices } from "../src/panel/panel.js";
import type * as vscode from "vscode";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockAgent = path.join(here, "mock-acp-agent.mjs");

/**
 * Review A3: dispose() must cancel an in-flight connect handshake instead of
 * leaving the spawned node process alive until the child's own initialize
 * timeout (up to 120s). The mock agent's `hang_initialize` mode never answers
 * initialize, so the panel's own teardown is the only thing that can end the
 * handshake — the right order (kill first, then settle) makes that fast.
 */

function makeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? store.get(key) : defaultValue) as T,
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

/** Watcher doubles: the vscode stub has no watcher API, so the panel is handed these. */
function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

const panelOf = (panel: ChatPanel) =>
  panel as unknown as {
    connecting: Promise<void> | null;
    client: unknown;
    disposed: boolean;
    ensureClient: () => Promise<unknown>;
    store: { getState: () => { status: string; errorMessage: string | null } };
  };

describe("ChatPanel delete-user-message transaction", () => {
  let panel: ChatPanel;
  let iflowHome: string;

  beforeEach(async () => {
    iflowHome = await mkdtemp(path.join(os.tmpdir(), "iflow-delete-test-"));
    process.env.IFLOW_HOME = iflowHome;
    panel = new ChatPanel(makeContext(), { workspaceRoot: here, watchers: makeWatchers() });
  });

  afterEach(async () => {
    await panel.dispose();
    await rm(iflowHome, { recursive: true, force: true });
    // The panel's storageUri is this test dir — the successful-delete case
    // writes an empty-transcript tombstone under test/transcripts/.
    await rm(path.join(here, "transcripts"), { recursive: true, force: true });
    delete process.env.IFLOW_HOME;
  });

  function harness(loadSession: () => Promise<void> | void) {
    const p = panel as unknown as {
      client: unknown;
      store: { getState: () => any; userPrompt: (text: string) => void; sessionStarted: (meta: any) => void };
      deleteUserMessage: (id: string) => Promise<void>;
      sendPrompt: (text: string) => Promise<void>;
      historySyncBusy: boolean;
      ownTranscriptFilePath: (id: string) => string;
    };
    p.store.sessionStarted({ sessionId: "delete-session", currentModelId: "model-a", modes: { currentModeId: "default", availableModes: [] } });
    p.store.userPrompt("first");
    p.store.userPrompt("second");
    p.store.getState().status = "idle";
    p.client = {
      loadSession: vi.fn(async () => loadSession()),
      setMode: vi.fn(async () => ({ success: true })),
      setModel: vi.fn(async () => ({ success: true })),
    };
    return p;
  }

  async function seedCliHistory() {
    const file = acpSessionFilePath("delete-session");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ chatHistory: [
      { role: "user", parts: [{ text: "first" }] },
      { role: "model", parts: [{ text: "reply" }] },
      { role: "user", parts: [{ text: "second" }] },
    ] }), "utf8");
    return file;
  }

  it("retains the original transcript when the CLI reload fails and releases the lock", async () => {
    const p = harness(async () => { throw new Error("reload failed"); });
    const file = await seedCliHistory();
    const targetId = p.store.getState().blocks[0]!.id!;
    await p.deleteUserMessage(targetId);
    expect(p.store.getState().blocks).toHaveLength(2);
    expect(p.historySyncBusy).toBe(false);
    expect(p.store.getState().initializing).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8")).chatHistory).toHaveLength(3);
  });

  it("blocks a prompt while the CLI history reload is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const p = harness(() => gate);
    await seedCliHistory();
    const targetId = p.store.getState().blocks[0]!.id!;
    const deleting = p.deleteUserMessage(targetId);
    await vi.waitFor(() => expect(p.historySyncBusy).toBe(true));
    await p.sendPrompt("must not start");
    expect(p.store.getState().blocks).toHaveLength(2);
    release();
    await deleting;
  });

  it("persists an empty transcript after a successful deletion", async () => {
    const p = harness(() => undefined);
    await seedCliHistory();
    const targetId = p.store.getState().blocks[0]!.id!;
    await p.deleteUserMessage(targetId);
    expect(p.store.getState().blocks).toHaveLength(0);
    const persisted = JSON.parse(await readFile(p.ownTranscriptFilePath("delete-session"), "utf8"));
    expect(persisted.blocks).toEqual([]);
  });

  it("never persists an empty transcript on dispose (tombstone is delete-only)", async () => {
    // Regression (6d89c4f): the tombstone write must stay exclusive to the
    // delete path. A dispose flush of an EMPTY session would create a
    // transcript file, making the dead husk look restorable — prune keeps it,
    // restoreLastSession restores a broken empty shell.
    const p = harness(() => undefined);
    // Blocks were added then fully deleted WITHOUT the delete-message path
    // (simulates any other truncation) — dispose must not persist the husk.
    p.store.getState().blocks.length = 0;
    await panel.dispose();
    const file = p.ownTranscriptFilePath("delete-session");
    expect(existsSync(file)).toBe(false);
  });
});

describe("ChatPanel dispose vs in-flight connect (review A3)", () => {
  let panel: ChatPanel;

  beforeEach(() => {
    // hang_initialize: the child never answers initialize, so the handshake
    // can only end via the panel's teardown.
    process.env.ACP_MOCK_MODE = "hang_initialize";
    const services: PanelServices = {
      entryOverride: mockAgent,
      workspaceRoot: here,
      watchers: makeWatchers(),
    };
    panel = new ChatPanel(makeContext(), services);
  });

  afterEach(async () => {
    // Belt-and-braces: a failed test must not leak the mock agent's node process.
    try {
      await panel.dispose();
    } catch {
      // already disposed
    }
    delete process.env.ACP_MOCK_MODE;
  });

  it("kills the child and settles the handshake instead of hanging on initialize", async () => {
    const p = panelOf(panel);
    const connect = p.ensureClient();
    void connect.catch(() => {}); // keep the rejection handled while dispose() runs
    // Wait until the child is actually spawned (ensureClient is async).
    await vi.waitFor(() => expect(p.client).not.toBeNull(), { timeout: 5000 });
    expect(p.connecting).not.toBeNull();

    const t0 = Date.now();
    await panel.dispose();
    // The kill must be prompt — NOT left to run until the child's 120s
    // initialize timeout. 5s is generous against that.
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(p.connecting).toBeNull();
    expect(p.client).toBeNull();
    // The handshake rejected rather than resolving with a doomed client.
    await expect(connect).rejects.toThrow(DisposedError);
  }, 15000);

  it("refuses to start a new connect after dispose", async () => {
    const p = panelOf(panel);
    await panel.dispose();
    await expect(p.ensureClient()).rejects.toThrow(DisposedError);
    expect(p.client).toBeNull();
  });

  it("does not mark the store errored when the handshake bailed on dispose", async () => {
    const p = panelOf(panel);
    void p.ensureClient().catch(() => {});
    await vi.waitFor(() => expect(p.client).not.toBeNull(), { timeout: 5000 });
    expect(p.connecting).not.toBeNull();
    await panel.dispose();
    // The store is destroyed, so the handshake must skip markError/setAuth.
    expect(p.store.getState().errorMessage).toBeNull();
  }, 15000);
});
