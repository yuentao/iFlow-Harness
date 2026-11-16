/**
 * 主会话的 `session/new` / `session/load` 必须携带
 * `settings.disallowed_tools`：既剔除进程内 `task` 子代理，也剔除一切
 * 读取/探查、写入与执行类工具（主会话只做派发）。
 *
 * 用户指令：主会话只做派发，实现与探查工作全部交给 Super Agent 子会话。
 * 提示词已经写明这一点，但模型仍然优先调 `task`、仍然自己 read_file / 跑
 * vitest（2026-11-15 / 2026-11-16 用户实测截图），所以改成机械剔除（见
 * `src/panel/panel.ts` 的 `MAIN_SESSION_DISALLOWED_TOOLS` 注释里的 bundle
 * 证据：请求的 `settings.disallowed_tools` → Config 的 `excludeTools` →
 * `createToolRegistry()` 跳过注册同名 `static Name` 的类）。
 *
 * 覆盖面板侧**全部**会创建/重载主会话的路径；子会话（SuperAgentManager）
 * 刻意不带 settings —— 那条断言在 test/super-agent-manager.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel, MAIN_SESSION_DISALLOWED_TOOLS } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { acpSessionFilePath } from "../src/acp/models-query.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { SessionState } from "../shared/messages.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every main-session request must carry exactly this. */
const EXPECTED_SETTINGS = { disallowed_tools: [...MAIN_SESSION_DISALLOWED_TOOLS] };

/** 读/写/执行三类工具必须全部被剔除；规划与派发通道必须保留。 */
const REQUIRED_DISALLOWED = [
  "task",
  "read_file",
  "read_many_files",
  "glob",
  "search_file_content",
  "list_directory",
  "image_read",
  "web_fetch",
  "web_search",
  "ReadCommandOutput",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_hover",
  "write_file",
  "replace",
  "multi_edit",
  "xml_escape",
  "run_shell_command",
] as const;

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

type FakeClient = {
  getInitializeResult: () => unknown;
  newSession: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

type PanelInternals = {
  client: FakeClient | null;
  sessionCwd: string | null;
  ensureClient: () => Promise<unknown>;
  startNewSession: (options?: { bypassSuperWait?: boolean }) => Promise<void>;
  restoreSession: (sessionId: string) => Promise<boolean>;
  reloadSessionUnderCreds: (
    sessionId: string,
    creds: { apiKey: string; baseUrl: string; modelName?: string },
  ) => Promise<boolean>;
  deleteUserMessage: (blockId: string) => Promise<void>;
  superWaitingForReports: () => boolean;
  queryLiveModels: () => Promise<SessionState["models"]>;
  applyLiveModels: (...args: unknown[]) => void;
  validateModelForPush: (
    models: Promise<SessionState["models"]>,
    modelId: string,
    fallback: string | null,
  ) => Promise<string | null>;
  setModel: (modelId: string) => Promise<void>;
  applyThinkLevel: (client: unknown, sessionId: string, level: unknown) => Promise<void>;
  recordSession: (id: string, label: string | null) => Promise<void>;
  workspaceModelId: () => string | null;
  persistActiveTranscript: () => Promise<void>;
  cleanupEmptySession: (id: string | null) => Promise<void>;
  hasPersistedTranscript: (id: string) => boolean;
  loadPersistedTranscript: (
    id: string,
  ) => Promise<{ blocks: SessionState["blocks"]; firstUserText: string | null }>;
  loadCheckpointIndex: (id: string) => Promise<void>;
  finalizeCheckpointIndex: (remap: Map<string, string>) => void;
  restoreSuperSessions: (id: string) => Promise<void>;
  ownTranscriptFilePath: (id: string) => string;
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    userPrompt: (text: string) => void;
  };
};

/** Newest request argument of the given fake method. */
function lastRequest(fn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = fn.mock.calls;
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

describe("主会话 session settings · 剔除 task 与读写执行工具", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let iflowHome: string;
  let client: FakeClient;

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-sessiontools-storage-"));
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-sessiontools-home-"));
    process.env.IFLOW_HOME = iflowHome;
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;

    client = {
      getInitializeResult: () => ({ agentCapabilities: { loadSession: true } }),
      newSession: vi.fn(async () => ({
        sessionId: `main-${client.newSession.mock.calls.length}`,
        modes: { currentModeId: "default", availableModes: [{ id: "default" }] },
        _meta: { models: { currentModelId: "m1" }, availableCommands: [], availableSkills: [] },
      })),
      loadSession: vi.fn(async () => ({ sessionId: "main-loaded" })),
      setMode: vi.fn(async () => ({})),
      setModel: vi.fn(async () => ({})),
      cancel: vi.fn(),
    };
    p.client = client;
    p.ensureClient = async () => client;
    p.superWaitingForReports = () => false;
    p.queryLiveModels = async () => [];
    p.applyLiveModels = () => {};
    p.validateModelForPush = async () => null;
    p.setModel = async () => {};
    p.applyThinkLevel = async () => {};
    p.recordSession = async () => {};
    p.workspaceModelId = () => null;
    p.persistActiveTranscript = async () => {};
    p.cleanupEmptySession = async () => {};
    p.hasPersistedTranscript = () => true;
    p.loadPersistedTranscript = async () => ({
      blocks: [
        { kind: "user", id: "b1", text: "旧会话的第一句" },
        { kind: "text", id: "b2", text: "旧会话的回答" },
      ],
      firstUserText: "旧会话的第一句",
    });
    p.loadCheckpointIndex = async () => {};
    p.finalizeCheckpointIndex = () => {};
    p.restoreSuperSessions = async () => {};
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(iflowHome, { recursive: true, force: true });
    delete process.env.IFLOW_HOME;
  });

  it("startNewSession：session/new 带 settings.disallowed_tools=['task']", async () => {
    await p.startNewSession();

    expect(client.newSession).toHaveBeenCalledTimes(1);
    expect(lastRequest(client.newSession).settings).toEqual(EXPECTED_SETTINGS);
  });

  it("restoreSession：探针 session/new 与 session/load 都带 settings", async () => {
    const restored = await p.restoreSession("restored-session");
    expect(restored).toBe(true);

    expect(client.newSession).toHaveBeenCalledTimes(1);
    expect(lastRequest(client.newSession).settings).toEqual(EXPECTED_SETTINGS);
    expect(client.loadSession).toHaveBeenCalledTimes(1);
    expect(lastRequest(client.loadSession).settings).toEqual(EXPECTED_SETTINGS);
    expect(lastRequest(client.loadSession).sessionId).toBe("restored-session");
  });

  it("keep-session 切换 Profile：session/load 带 settings", async () => {
    const ok = await p.reloadSessionUnderCreds("keep-session", {
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      modelName: "m1",
    });
    expect(ok).toBe(true);

    expect(client.loadSession).toHaveBeenCalledTimes(1);
    expect(lastRequest(client.loadSession).settings).toEqual(EXPECTED_SETTINGS);
  });

  it("deleteUserMessage 截断后重载：session/load 带 settings", async () => {
    p.store.sessionStarted({ sessionId: "delete-session" });
    p.store.userPrompt("first");
    p.store.userPrompt("second");
    p.store.getState().status = "idle";
    // The CLI history must match the transcript exactly, otherwise the delete
    // refuses before touching the session.
    const file = acpSessionFilePath("delete-session");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        chatHistory: [
          { role: "user", parts: [{ text: "first" }] },
          { role: "model", parts: [{ text: "reply" }] },
          { role: "user", parts: [{ text: "second" }] },
        ],
      }),
      "utf8",
    );
    p.client = client;
    p.sessionCwd = here;

    const targetId = p.store.getState().blocks[0]!.id!;
    await p.deleteUserMessage(targetId);

    expect(client.loadSession).toHaveBeenCalledTimes(1);
    expect(lastRequest(client.loadSession).settings).toEqual(EXPECTED_SETTINGS);
  });

  it("deleteUserMessage 回滚重载：session/load 仍带 settings", async () => {
    p.store.sessionStarted({
      sessionId: "delete-session",
      currentModelId: "m1",
      modes: { currentModeId: "default", availableModes: [] },
    } as never);
    p.store.userPrompt("first");
    p.store.userPrompt("second");
    p.store.getState().status = "idle";
    const file = acpSessionFilePath("delete-session");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        chatHistory: [
          { role: "user", parts: [{ text: "first" }] },
          { role: "model", parts: [{ text: "reply" }] },
          { role: "user", parts: [{ text: "second" }] },
        ],
      }),
      "utf8",
    );
    p.client = client;
    p.sessionCwd = here;
    // The truncation reload succeeds; the follow-up bookkeeping (setMode)
    // throws so the catch path restores the original history and re-loads the
    // session — that second call is the rollback reload under test.
    client.setMode.mockImplementation(async () => {
      throw new Error("bookkeeping failed");
    });

    const targetId = p.store.getState().blocks[0]!.id!;
    await p.deleteUserMessage(targetId);

    expect(client.loadSession.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of client.loadSession.mock.calls) {
      expect((call[0] as Record<string, unknown>).settings).toEqual(EXPECTED_SETTINGS);
    }
  });

  it("禁止清单覆盖读/写/执行三类，同时保留规划、提问与派发通道", () => {
    const blocked: readonly string[] = MAIN_SESSION_DISALLOWED_TOOLS;
    for (const name of REQUIRED_DISALLOWED) {
      expect(blocked).toContain(name);
    }
    // 主会话自己的规划与需求澄清必须保留；super-agent 是唯一派发通道。
    expect(blocked).not.toContain("todo_write");
    expect(blocked).not.toContain("todo_read");
    expect(blocked).not.toContain("ask_user_question");
    expect(blocked).not.toContain("super-agent");
    // `grep` / `ls` 不是 CLI 的注册名（真名是 search_file_content /
    // list_directory），写进清单只会静默不生效。
    expect(blocked).not.toContain("grep");
    expect(blocked).not.toContain("ls");
  });
});
