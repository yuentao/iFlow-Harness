/**
 * 恢复进行中点「新会话」：恢复被放弃（可打断），以及恢复来不及打断时的
 * 排队意图。
 *
 * 用户原话（截图）：面板启动时若 `iflow.restoreLastSession` 生效，恢复历史
 * 会话期间点顶栏「新会话」→ 宿主硬拒绝并提示「正在恢复历史会话，请稍后再
 * 新建会话」，用户必须等恢复跑完再点一次。
 *
 * 三条要求：
 *  1. 恢复还在可中断点（写 store 之前）时，点「新会话」→ 恢复被放弃：
 *     不 sessionStarted、不写转录、不 applyLiveModels、不 restoreSuperSessions、
 *     不弹「已恢复会话」，状态复位为干净 idle，新会话照常建立。
 *  2. 恢复已经来不及打断（写 store 之后）时，点「新会话」→ 排队意图被记录，
 *     恢复 settle 之后自动新建会话（用户不必点第二次），并且只发一次
 *     `session/new`。
 *  3. 正常恢复路径不回归。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { Block, SessionState } from "../shared/messages.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
    update: () => Promise.resolve(),
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

/** A promise whose resolver is captured by the test. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const RESTORED_BLOCKS: Block[] = [
  { kind: "user", id: "b1", text: "旧会话的第一句" },
  { kind: "text", id: "b2", text: "旧会话的回答" },
];

type FakeClient = {
  getInitializeResult: () => unknown;
  newSession: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

type PanelInternals = {
  client: FakeClient | null;
  restoring: boolean;
  restoreSession: (sessionId: string) => Promise<boolean>;
  startNewSession: () => Promise<void>;
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  ensureClient: () => Promise<unknown>;
  hasPersistedTranscript: (id: string) => boolean;
  loadPersistedTranscript: (
    id: string,
  ) => Promise<{ blocks: SessionState["blocks"]; firstUserText: string | null }>;
  loadCheckpointIndex: (id: string) => Promise<void>;
  finalizeCheckpointIndex: (remap: Map<string, string>) => void;
  cleanupEmptySession: (id: string | null) => Promise<void>;
  recordSession: (id: string, label: string | null) => Promise<void>;
  persistActiveTranscript: (force?: boolean) => Promise<void>;
  restoreSuperSessions: (id: string) => Promise<void>;
  queryLiveModels: () => Promise<SessionState["models"]>;
  validateModelForPush: (
    models: Promise<SessionState["models"]>,
    modelId: string,
    fallback: string | null,
  ) => Promise<string | null>;
  setModel: (modelId: string) => Promise<void>;
  applyThinkLevel: (client: unknown, sessionId: string, level: unknown) => Promise<void>;
  workspaceModelId: () => string | null;
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: SessionState) => void;
    replaceTranscript: (blocks: SessionState["blocks"]) => void;
    appendNotice: (text: string) => void;
  };
};

describe("恢复进行中点「新会话」", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let notices: string[];
  let infos: string[];
  let client: FakeClient;

  beforeEach(() => {
    // checkpoint 会拉真实 git 子进程；这里只测状态机，关掉。
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-restore-abort-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    notices = [];
    infos = [];

    client = {
      getInitializeResult: () => ({ agentCapabilities: { loadSession: true } }),
      // Every call returns a DISTINCT id, so a test can tell the restore's
      // probe session from the session the 新会话 flow creates.
      newSession: vi.fn(async () => ({
        sessionId: `probe-${client.newSession.mock.calls.length}`,
        modes: { currentModeId: "default", availableModes: [{ id: "default" }] },
        _meta: { models: { currentModelId: "m1" }, availableCommands: [], availableSkills: [] },
      })),
      loadSession: vi.fn(async () => ({ sessionId: "restored-session" })),
      cancel: vi.fn(),
    };
    p.client = client;
    p.ensureClient = async () => client;
    p.hasPersistedTranscript = () => true;
    p.loadPersistedTranscript = async () => ({
      blocks: RESTORED_BLOCKS.map((b) => ({ ...b })),
      firstUserText: "旧会话的第一句",
    });
    p.loadCheckpointIndex = async () => {};
    p.finalizeCheckpointIndex = () => {};
    p.cleanupEmptySession = async () => {};
    p.recordSession = async () => {};
    p.persistActiveTranscript = async () => {};
    p.restoreSuperSessions = async () => {};
    p.queryLiveModels = async () => [];
    p.validateModelForPush = async () => null;
    p.setModel = async () => {};
    p.applyThinkLevel = async () => {};
    p.workspaceModelId = () => null;

    vi.spyOn(p.store, "appendNotice").mockImplementation(((text: string) => {
      notices.push(text);
    }) as PanelInternals["store"]["appendNotice"]);
    vi.spyOn(vscode.window, "showInformationMessage").mockImplementation((async (message: string) => {
      infos.push(message);
      return undefined;
    }) as unknown as typeof vscode.window.showInformationMessage);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  it("恢复还在可中断点时：恢复被放弃，新会话照常建立", async () => {
    const recordSession = vi.spyOn(p, "recordSession");
    const restoreSuperSessions = vi.spyOn(p, "restoreSuperSessions");
    const replaceTranscript = vi.spyOn(p.store, "replaceTranscript");

    // 探针 session/new 挂住 → 恢复停在第一个检查点之前。
    const probe = deferred<{ sessionId: string; modes: unknown; _meta: unknown }>();
    client.newSession.mockImplementationOnce(() => probe.promise);

    const restore = p.restoreSession("restored-session");
    await flush();
    expect(p.restoring).toBe(true);

    // 用户点「新会话」。
    const newSession = p.handleWebviewMessage({ type: "newSession" });
    await flush();

    // 探针返回 → 恢复在检查点发现中断 → 放弃。
    probe.resolve({
      sessionId: "probe-1",
      modes: { currentModeId: "default", availableModes: [{ id: "default" }] },
      _meta: { models: { currentModelId: "m1" }, availableCommands: [], availableSkills: [] },
    });
    const restored = await restore;
    await newSession;
    await flush();

    // 恢复被放弃：没有加载、没有写转录、没有「已恢复会话」。
    expect(restored).toBe(false);
    expect(client.loadSession).not.toHaveBeenCalled();
    expect(replaceTranscript).not.toHaveBeenCalled();
    expect(restoreSuperSessions).not.toHaveBeenCalled();
    expect(recordSession).not.toHaveBeenCalledWith("restored-session", expect.anything());
    expect(p.store.getState().replaying).toBe(false);
    expect(p.store.getState().status).toBe("idle");
    expect(infos.some((m) => m.includes("已恢复会话"))).toBe(false);
    expect(notices.some((n) => n.includes("已取消正在进行的恢复"))).toBe(true);
    expect(notices.some((n) => n.includes("请稍后再新建会话"))).toBe(false);

    // 新会话照常建立：探针之外只多发了一次 session/new（不双发）。
    expect(client.newSession).toHaveBeenCalledTimes(2);
    expect(p.store.getState().sessionId).toBe("probe-2");
    expect(recordSession).toHaveBeenCalledWith("probe-2", null);
  });

  it("恢复来不及打断时：排队意图被记录，恢复 settle 后自动新建会话", async () => {
    // 恢复一路跑到写 store 之后，卡在 cleanupEmptySession（= 太晚打断）。
    const cleanup = deferred<void>();
    p.cleanupEmptySession = async () => cleanup.promise;

    const restore = p.restoreSession("restored-session");
    await flush();
    // 恢复已经写完 store（走完了最后一个检查点）。
    expect(p.store.getState().sessionId).toBe("restored-session");

    // 用户点「新会话」——此时恢复已来不及放弃。
    const newSession = p.handleWebviewMessage({ type: "newSession" });
    await flush();
    // 还没 settle：用户不必再点一次，意图已经排队。
    expect(notices.some((n) => n.includes("恢复完成后将自动新建会话"))).toBe(false);

    cleanup.resolve();
    const restored = await restore;
    await newSession;
    await flush();

    // 恢复正常完成（它已经写完 store 了）。
    expect(restored).toBe(true);
    expect(infos.some((m) => m.includes("已恢复会话"))).toBe(true);
    // 排队意图兑现：恢复 settle 后自动新建。
    expect(notices.some((n) => n.includes("恢复完成后将自动新建会话"))).toBe(true);
    // 只发了一次 session/new 给新会话（探针那次不算）。
    expect(client.newSession).toHaveBeenCalledTimes(2);
  });

  it("正常恢复：不回归（写转录 + 恢复子会话 + 「已恢复会话」）", async () => {
    const replaceTranscript = vi.spyOn(p.store, "replaceTranscript");
    const recordSession = vi.spyOn(p, "recordSession");
    const restoreSuperSessions = vi.spyOn(p, "restoreSuperSessions");

    const restored = await p.restoreSession("restored-session");
    await flush();

    expect(restored).toBe(true);
    expect(replaceTranscript).toHaveBeenCalledTimes(1);
    expect(p.store.getState().sessionId).toBe("restored-session");
    expect(recordSession).toHaveBeenCalledWith("restored-session", "旧会话的第一句");
    expect(restoreSuperSessions).toHaveBeenCalledWith("restored-session");
    expect(infos.some((m) => m.includes("已恢复会话"))).toBe(true);
    expect(p.restoring).toBe(false);
  });
});
