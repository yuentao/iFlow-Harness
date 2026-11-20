/**
 * 主会话的 `session/new` / `session/load` 必须携带两道门控：
 * ① `settings.allowed_tools`（白名单，主门控）——不在清单里的内置工具根本不会
 *    被 `createToolRegistry()` 注册；
 * ② `settings.disallowed_tools`（第二层）——显式写明永不交给主会话的内置工具。
 *
 * 用户指令：主会话只做派发，实现与探查工作全部交给 Super Agent 子会话。
 * 提示词已经写明这一点，但模型仍然优先调 `task`、仍然自己 read_file / 跑
 * vitest（2026-11-15 / 2026-11-16 用户实测截图），所以改成机械剔除。
 *
 * 2026-11-17 的补充（用户实测）：机械剔除只列举了内置工具，主会话仍能调用
 * **MCP 工具**（`new_page` / `take_screenshot` / `evaluate_script`）。MCP 工具名
 * 是每个用户自己装的服务器决定的，既列不全也会误挡，所以改成结构性方案：
 * 白名单只放派发与交互所需的 5 个内置工具，MCP 服务器则在主会话的 CLI 进程
 * 层面整体移除（`buildAcpCommand` 的 `disableMcpServers`，见
 * test/panel-spawn-env.test.ts 的 argv 断言）。**任何 MCP 工具名都不进本文件，
 * 也不进 src。**
 *
 * 清单里的精确性要点，改注释时别丢：① `multi_edit` 在当前 CLI 版本只是声明、
 * 并未注册，属防御性条目，不能当作「已挡住它」的证据；② `lsp_goto_definition`
 * / `lsp_find_references` / `lsp_hover` 的注册点被 `this.lspManager &&` 包裹，
 * 而 `lspManager` 在 Config 构造函数里无条件创建，所以实际恒注册；
 * ③ `grep` / `ls` 不是 CLI 的注册名（搜索/列目录叫 `search_file_content` /
 * `list_directory`），写进清单只会静默不生效。
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
import {
  ChatPanel,
  MAIN_SESSION_ALLOWED_TOOLS,
  MAIN_SESSION_DISALLOWED_TOOLS,
  mainSessionSettings,
} from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { acpSessionFilePath } from "../src/acp/models-query.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { SessionState } from "../shared/messages.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every main-session request must carry exactly this. */
const EXPECTED_SETTINGS = {
  allowed_tools: [...MAIN_SESSION_ALLOWED_TOOLS],
  disallowed_tools: [...MAIN_SESSION_DISALLOWED_TOOLS],
};

/**
 * 白名单是主门控：不在清单里的内置工具**根本不会被注册**（`coreTools` 参与
 * `createToolRegistry()` 的注册判定），因此「主会话拿不到 MCP 工具」这一结论
 * 不依赖任何 MCP 工具名——清单只描述「内置工具的允许集合」，用户新装一个
 * MCP 服务器无需改这里一行代码。
 */
const EXPECTED_ALLOWED = [
  "super-agent",
  "todo_write",
  "todo_read",
  "ask_user_question",
] as const;

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
  "save_memory",
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
  mcpStatus?: ReturnType<typeof vi.fn>;
};

type PanelInternals = {
  client: FakeClient | null;
  sessionCwd: string | null;
  ensureClient: () => Promise<unknown>;
  insertInjectedContextCard: (since: number) => Promise<void>;
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
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  it("白名单精确等于「派发 + 待办 + 提问」，多一项都要显式讨论", () => {
    expect([...MAIN_SESSION_ALLOWED_TOOLS].sort()).toEqual([...EXPECTED_ALLOWED].sort());
    // 派发通道必须在白名单里，否则主会话一个任务都派不出去。
    expect(MAIN_SESSION_ALLOWED_TOOLS).toContain("super-agent");
    for (const name of ["todo_write", "todo_read", "ask_user_question"]) {
      expect(MAIN_SESSION_ALLOWED_TOOLS).toContain(name);
    }
    // 计划模式已移除：exit_plan_mode 不再保留在主会话（也不再出现在白名单里）。
    expect(MAIN_SESSION_ALLOWED_TOOLS).not.toContain("exit_plan_mode");
  });

  it("两份清单都不含 MCP 工具名，settings 形状也不随用户 MCP 配置变化", () => {
    // 典型 playwright-mcp 工具名：换个用户就是另一套名字，所以一个都不能进
    // 清单——封堵靠「只有允许的才注册」+ 进程级 MCP 移除，不靠列举。
    for (const name of ["new_page", "take_screenshot", "evaluate_script", "browser_close"]) {
      expect(MAIN_SESSION_ALLOWED_TOOLS).not.toContain(name);
      expect(MAIN_SESSION_DISALLOWED_TOOLS).not.toContain(name);
    }
    // 主会话 settings 里没有 mcpServers：会话级 `mcpServers` 只会**合并**到
    // 用户已配置的服务器之上（传空数组删不掉任何东西），所以 MCP 由 spawn
    // 参数处理，settings 里也不该出现任何服务器名/工具名。
    const settings = mainSessionSettings();
    expect(settings.mcpServers).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain("new_page");
  });

  it("自动注入卡不再查询 mcp-status，也不带入任何 MCP 条目", async () => {
    // 主会话的 CLI 进程在 spawn 时就移除了全部 MCP 服务器（buildAcpCommand 的
    // disableMcpServers），因此这个「模型实际看到什么」的卡片里根本不该有 MCP
    // 条目——把用户配置里因进程级禁用而未连接的服务器报成「N 个未连接」是误导
    // （2026-11-18 用户实测截图）。
    fs.writeFileSync(
      path.join(storageDir, "context-report.json"),
      JSON.stringify({ version: 2, systemPrompt: "You are a helpful assistant." }),
      "utf8",
    );
    const servers = Object.fromEntries(
      ["apipost-mcp", "firecrawl", "exa", "figma", "playwright-mcp"].map((name) => [
        name,
        { status: "disconnected", tools: [], toolCount: 0, promptCount: 0, prompts: [] },
      ]),
    );
    const mcpStatus = vi.fn(async () => ({ available: true, servers }));
    client.mcpStatus = mcpStatus;
    p.persistActiveTranscript = async () => {};
    p.store.sessionStarted({ sessionId: "injected-mcp" });

    await p.insertInjectedContextCard(0);

    expect(mcpStatus).not.toHaveBeenCalled();
    const injected = p.store.getState().blocks.find((b) => b.kind === "injected") as
      | Extract<SessionState["blocks"][number], { kind: "injected" }>
      | undefined;
    expect(injected).toBeDefined();
    expect(injected!.items.length).toBeGreaterThan(0);
    expect(injected!.items.some((i) => i.kind === "mcp")).toBe(false);
    expect(injected!.notice).not.toContain("MCP 服务器未连接");
  });

  it("新建会话流程中投影为 starting，结束后回到 null", async () => {
    let seen: string | null | undefined;
    p.cleanupEmptySession = async () => {
      // The pre-session window is exactly where the old UI had zero feedback.
      seen = p.store.getState().newSessionPhase;
    };

    await p.startNewSession();

    expect(seen).toBe("starting");
    expect(p.store.getState().newSessionPhase ?? null).toBeNull();
    expect(client.newSession).toHaveBeenCalledTimes(1);
  });

  it("进行中重复点击直接忽略：只发一次 session/new", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.newSession.mockImplementation(async () => {
      await gate;
      return {
        sessionId: "main-gated",
        modes: { currentModeId: "default", availableModes: [{ id: "default" }] },
        _meta: { models: { currentModelId: "m1" }, availableCommands: [], availableSkills: [] },
      };
    });

    const first = p.startNewSession();
    // The first run is registered synchronously (before its first await).
    const second = p.startNewSession();
    release();
    await Promise.all([first, second]);

    expect(client.newSession).toHaveBeenCalledTimes(1);
    expect(p.store.getState().newSessionPhase ?? null).toBeNull();
  });

  it("失败可见：投影回到 null，错误横幅拿到真实报错", async () => {
    client.newSession.mockImplementation(async () => {
      throw new Error("session/new rejected");
    });

    await expect(p.startNewSession()).rejects.toThrow("session/new rejected");

    expect(p.store.getState().newSessionPhase ?? null).toBeNull();
    expect(p.store.getState().errorMessage).toContain("session/new rejected");
  });
});

/**
 * 静态守卫：门控是「每个 session 创建点都要带」的逐点契约，行为测试只能覆盖
 * 当前存在的那几条路径。将来有人新增一个 `client.newSession` / `loadSession`
 * 调用却忘了 `settings`，运行时不会报错——CLI 会静默把全部工具交回模型。
 * 这里直接扫描源码字面量，把「漏传」变成红灯。
 *
 * 容忍多行与展开写法：只要求同一个调用对象的括号范围内出现
 * `settings: mainSessionSettings()`。
 */
describe("主会话 session settings · 静态守卫（每个创建点都必须带门控）", () => {
  const panelSource = fs.readFileSync(path.join(here, "..", "src", "panel", "panel.ts"), "utf8");
  // 阶段 4：恢复探针 / session/load 两个创建点下沉到 SessionRestoreService，
  // 守卫必须跟着覆盖新模块，不能因为文件换了就漏守。
  const sessionRestoreSource = fs.readFileSync(path.join(here, "..", "src", "panel", "session-restore.ts"), "utf8");

  /** 从 `(` 开始按括号配对取到调用实参的原始文本（跳过字符串与行注释）。 */
  function argumentSlice(source: string, openParenIndex: number): string {
    let depth = 0;
    let quote: string | null = null;
    for (let i = openParenIndex; i < source.length; i += 1) {
      const ch = source[i]!;
      const prev = i > 0 ? source[i - 1] : "";
      if (quote) {
        if (ch === quote && prev !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "/" && source[i + 1] === "/") {
        const newline = source.indexOf("\n", i);
        if (newline < 0) break;
        i = newline;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(openParenIndex, i + 1);
      }
    }
    throw new Error(`unbalanced call at ${openParenIndex}`);
  }

  function sessionCalls(source: string): Array<{ callee: string; line: number; args: string }> {
    const pattern = /client\.(newSession|loadSession)\s*\(/g;
    const calls: Array<{ callee: string; line: number; args: string }> = [];
    for (const match of source.matchAll(pattern)) {
      const callee = `client.${match[1]}`;
      const openParen = match.index! + match[0].length - 1;
      calls.push({
        callee,
        line: source.slice(0, match.index!).split("\n").length,
        args: argumentSlice(source, openParen),
      });
    }
    return calls;
  }

  it("每个 client.newSession/loadSession 都带主会话 settings 门控（panel + session-restore）", () => {
    // 六个创建点：新建、恢复探针、恢复加载、Profile 热切换、删除消息截断重载、
    // 回滚重载；前三者的一部分现居 session-restore.ts。少于此数说明正则或
    // 文件路径出了问题，不能让「零命中」伪装成通过。
    const calls = [
      ...sessionCalls(panelSource).map((c) => ({ ...c, file: "panel.ts" })),
      ...sessionCalls(sessionRestoreSource).map((c) => ({ ...c, file: "session-restore.ts" })),
    ];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    const offenders = calls
      .filter((call) => !/settings\s*:\s*(?:mainSessionSettings|this\.deps\.getMainSessionSettings)\(\s*\)/.test(call.args))
      .map((call) => `${call.callee} at ${call.file}:${call.line}`);
    expect(offenders).toEqual([]);
  });

  it("禁止清单含读/写/执行与 task，保留规划、提问与派发通道", () => {
    for (const name of ["run_shell_command", "read_file", "write_file", "task"]) {
      expect(MAIN_SESSION_DISALLOWED_TOOLS).toContain(name);
    }
    for (const name of ["super-agent", "todo_write", "todo_read", "ask_user_question"]) {
      expect(MAIN_SESSION_DISALLOWED_TOOLS).not.toContain(name);
    }
  });
});
