/**
 * 子会话汇报的**归属**与**投递时机**（宿主侧）。
 *
 * 三件事：
 *  1. 汇报不能跨会话串台：用户在会话 A 开着的时候，会话 B 的子会话收尾，
 *     它的汇报不能作为一次真实 prompt 投进 A —— 那会把别的会话的结果插进
 *     A 的上下文（模型读到自己没有的孩子，转录里也冒出别的会话的结论）。
 *  2. 等待提示与 pendingCount 只统计**当前主会话**的子会话。
 *  3. 用户回合优先：汇报回合不能插进用户回合的准备窗口（状态还没翻成
 *     streaming 之前的那几个 await），必须排到用户回合之后。
 *
 * 外加一条：委派扫描的缓冲必须有界（长会话里不能线性增长），且裁剪不能把
 * 没收口的委派块切���半截载荷。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import { MAX_SUPER_SCAN_BUFFER_CHARS } from "../shared/super-agent.js";
import type { SessionState } from "../shared/messages.js";
import type { SuperReport, SuperSessionUi } from "../shared/super-agent.js";

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

type PromptCall = {
  prompt: Array<{ type: string; text?: string }>;
  resolve: (v: { stopReason: string }) => void;
};

/** 子会话 id → 面板看到的看板投影。 */
function child(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "super-1",
    title: "修好登录跳转",
    task: "修好 src/auth.ts",
    status: "running",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    ...overrides,
  };
}

const READY_REPORT: SuperReport = { state: "ready", summary: "登录跳转已修好", at: 2000 };

type FakeManager = {
  list: (mainSessionId?: string | null) => SuperSessionUi[];
  reportPrompt: (entries: Array<{ session: SuperSessionUi }>) => string;
  spawn: ReturnType<typeof vi.fn>;
};

/**
 * 宿主看到的子会话管理器。
 *
 * `list` **按归属**返回：面板必须自己按归属过滤，所以这里给的是真实的
 * 「全部活子会话」——面板拿到之后自己判断谁属于当前主会话。
 */
function makeManager(children: SuperSessionUi[]): FakeManager {
  return {
    list: () => children,
    reportPrompt: (entries) => entries.map((e) => `【汇报】${e.session.title}`).join("\n"),
    spawn: vi.fn(() => ({ id: "super-spawned" })),
  };
}

type PanelInternals = {
  superAgent: unknown;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: unknown,
  ) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  refreshSuperWaitHeartbeat: () => void;
  queueSuperReport: (entries: Array<{ session: SuperSessionUi; report: SuperReport }>) => void;
  pendingSuperReportPrompts: Array<{ mainSessionId: string | null; text: string }>;
  superScan: { bufferLength: number; push: (chunk: string) => unknown };
  scanSuperDirectives: (content: unknown, scanner?: unknown) => void;
  onSessionUpdate: (n: {
    sessionId: string;
    update: { sessionUpdate: string; content: { type: string; text: string }; agentId?: string };
  }) => void;
  resetSuperDirectiveScans: () => void;
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: SessionState) => void;
    setSuperSessions: (sessions: SuperSessionUi[]) => void;
    sendToast: (...args: unknown[]) => number;
  };
};

describe("子会话汇报 · 归属与投递时机", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let manager: FakeManager;
  let toasts: Array<{ message: string; kind: string }>;

  beforeEach(() => {
    // checkpoint 会拉真实 git 子进程；这里只测状态机，关掉。
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superowner-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    toasts = [];
    manager = makeManager([child()]);
    p.superAgent = manager;
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) =>
        new Promise<{ stopReason: string }>((resolve) => {
          calls.push({ prompt, resolve });
        }),
    ) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    vi.spyOn(p.store, "sendToast").mockImplementation(((kind: string, message: string) => {
      toasts.push({ kind, message });
      return toasts.length;
    }) as unknown as PanelInternals["store"]["sendToast"]);
    p.store.sessionStarted({ sessionId: "session-A" });
    p.store.replaceState({
      ...p.store.getState(),
      sessionId: "session-A",
      activeSessionId: "session-A",
      status: "idle",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  it("会话 A 开着时，会话 B 的子会话收尾 —— 它的汇报不投进 A 的对话", async () => {
    // B 的子会话结束了，A 才是用户当前所在的会话。
    const bChild = child({
      id: "super-b",
      title: "B 的孩子",
      status: "completed",
      mainSessionId: "session-B",
    });
    manager.list = () => [bChild];
    p.queueSuperReport([{ session: bChild, report: READY_REPORT }]);
    await flush();

    // A 没收到任何 prompt：别的会话的汇报不能插进 A 的上下文。
    expect(calls).toHaveLength(0);
    // 汇报还欠着（在 B 那个桶里），切到 B 就能投。
    expect(p.pendingSuperReportPrompts).toHaveLength(0);
  });

  it("切到归属的会话后，那条汇报才会投出去", async () => {
    const bChild = child({
      id: "super-b",
      title: "B 的孩子",
      status: "completed",
      mainSessionId: "session-B",
    });
    manager.list = () => [bChild];
    p.queueSuperReport([{ session: bChild, report: READY_REPORT }]);
    await flush();
    expect(calls).toHaveLength(0);

    // 用户切到 B：汇报这时才投（B 的上下文）。
    p.store.replaceState({
      ...p.store.getState(),
      sessionId: "session-B",
      activeSessionId: "session-B",
    });
    p.refreshSuperWaitHeartbeat();
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("B 的孩子");
  });

  it("「等待 N 个子会话汇报」只数当前主会话的子会话", async () => {
    const mine = child({ id: "super-a", status: "running", mainSessionId: "session-A" });
    const theirs = child({ id: "super-b", status: "running", mainSessionId: "session-B" });
    manager.list = () => [mine, theirs];
    p.store.setSuperSessions([mine, theirs]);
    p.refreshSuperWaitHeartbeat();

    const waiting = toasts.filter((t) => t.message.includes("子会话汇报"));
    expect(waiting.length).toBeGreaterThan(0);
    // 只有 A 的那个孩子在等 → 数字是 1，不是 2。
    expect(waiting[waiting.length - 1]!.message).toContain("1 个子会话汇报");
  });

  it("用户回合进行中时到达的汇报排到用户回合之后，不并发插入", async () => {
    const aChild = child({
      id: "super-a",
      status: "completed",
      mainSessionId: "session-A",
    });
    manager.list = () => [aChild];

    // 用户先发一条消息：这一轮还在跑。
    const turn = p.handleWebviewMessage({ type: "sendPrompt", text: "先把主流程跑通" });
    await flush();
    expect(calls).toHaveLength(1);

    // 用户回合还在跑的时候，汇报到了 —— 不能并发插进来。
    p.queueSuperReport([{ session: aChild, report: READY_REPORT }]);
    await flush();
    expect(calls).toHaveLength(1);

    // 用户回合结束 → 汇报才作为下一轮投出去。
    calls[0]!.resolve({ stopReason: "end_turn" });
    await turn;
    await flush();
    await flush();

    expect(calls).toHaveLength(2);
    // 顺序：先用户那条，再汇报那条。
    expect(calls[0]!.prompt[0]!.text).toContain("先把主流程跑通");
    expect(calls[1]!.prompt[0]!.text).toContain("【汇报】");
  });

  it("汇报回合不会插进用户回合的准备窗口（状态还没翻成 streaming）", async () => {
    const aChild = child({
      id: "super-a",
      status: "completed",
      mainSessionId: "session-A",
    });
    manager.list = () => [aChild];

    // 让「准备阶段」卡住：ensureClient 不立刻返回。
    let releaseClient: (() => void) | null = null;
    let stuck = true;
    p.ensureClient = () => {
      if (!stuck) return Promise.resolve({});
      return new Promise<unknown>((resolve) => {
        releaseClient = () => {
          stuck = false;
          resolve({});
        };
      });
    };

    const turn = p.handleWebviewMessage({ type: "sendPrompt", text: "先把主流程跑通" });
    await flush();
    // 用户回合还在准备阶段（状态还是 idle，没发 prompt）。
    expect(calls).toHaveLength(0);
    expect(p.store.getState().status).toBe("idle");

    // 汇报在这个窗口里到达 —— 不能插进来（否则两个回合并发跑在同一个
    // ACP 会话上：转录交错、上下文互相污染）。
    p.queueSuperReport([{ session: aChild, report: READY_REPORT }]);
    await flush();
    expect(calls).toHaveLength(0);

    // 准备阶段结束 → 用户回合先跑，汇报排到它后面。
    releaseClient!();
    await flush();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt[0]!.text).toContain("先把主流程跑通");

    calls[0]!.resolve({ stopReason: "end_turn" });
    await turn;
    await flush();
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt[0]!.text).toContain("【汇报】");
  });

  it("委派扫描的缓冲有界：大量流式文本不会把缓冲撑大", () => {
    const chunk = "普通叙述段落，用来把扫描缓冲撑起来，长度足够长以至于缓冲会明显增长。".repeat(4);
    for (let i = 0; i < 200; i++) {
      p.scanSuperDirectives(chunk + `（第 ${i} 段）`);
    }
    expect(p.superScan.bufferLength).toBeLessThanOrEqual(MAX_SUPER_SCAN_BUFFER_CHARS);
    // 死区（扫过又没有指令的前缀）被丢掉：缓冲不随会话长度增长。
    expect(p.superScan.bufferLength).toBeLessThan(4096);
  });

  it("缓冲裁剪不会把没收口的委派块切成半截载荷（不会误派发）", () => {
    const chunk = "普通叙述段落。".repeat(20);
    for (let i = 0; i < 100; i++) {
      p.scanSuperDirectives(chunk + `（第 ${i} 段）`);
    }
    // 围栏开栏了，载荷还没写完：此时不能派发任何东西。
    p.scanSuperDirectives("\n```super-agent\n");
    p.scanSuperDirectives('{"tasks":[{"title":"A","task":"任务 A"}]}');
    expect(manager.spawn).not.toHaveBeenCalled();

    // 载荷补齐 → 才派发（说明开栏没被裁掉）。
    p.scanSuperDirectives("\n```\n");
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  const directive = (title: string, task: string): string =>
    ["```super-agent", JSON.stringify({ tasks: [{ title, task }] }), "```"].join("\n");
  const chunk = (sessionUpdate: "agent_thought_chunk" | "agent_message_chunk", text: string): void => {
    p.onSessionUpdate({
      sessionId: "session-A",
      update: { sessionUpdate, content: { type: "text", text } },
    });
  };

  it("思考通道里的委派围栏不是指令：合法/写坏的载荷都不派发、不弹提示", () => {
    // 合法围栏只写在思考里：思考通道不进委派扫描器，不派发、也不报「已派发」。
    chunk("agent_thought_chunk", directive("改登录", "修好 src/auth.ts"));
    // 写坏的载荷同样不被扫描：不能因此弹 invalidBlocks 的「无法解析」提示。
    chunk("agent_thought_chunk", "```super-agent\n{ 这不是 JSON }\n```");
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(toasts.some((t) => t.message.includes("已派发"))).toBe(false);
    expect(toasts.some((t) => t.message.includes("无法解析"))).toBe(false);
  });

  it("思考块与正文块载荷相同 → 只派发 1 个子会话（不发「已派发 0 个」）", () => {
    const payload = directive("改登录", "修好 src/auth.ts");
    chunk("agent_thought_chunk", payload);
    chunk("agent_message_chunk", payload);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    // 全部命中重复时没有可报的派发数量 —— 不能发「已派发 0 个」。
    expect(toasts.some((t) => t.message.includes("已派发 0"))).toBe(false);
    // 首次派发的那一条照常存在（重复条目既不计数也不额外提示）。
    expect(toasts.filter((t) => t.message.includes("已派发 1 个子会话"))).toHaveLength(1);
  });

  it("思考块与正文块载荷不同 → 只有正文通道的那一份派发", () => {
    chunk("agent_thought_chunk", directive("改登录", "修好 src/auth.ts"));
    expect(manager.spawn).not.toHaveBeenCalled();
    chunk("agent_message_chunk", directive("改注册", "修好 src/register.ts"));
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    // 主通道派发照常提示；思考通道既不派发也不拖出「无法解析」提示。
    expect(toasts.filter((t) => t.message.includes("已派发 1 个子会话"))).toHaveLength(1);
    expect(toasts.some((t) => t.message.includes("无法解析"))).toBe(false);
  });

  it("换会话/恢复时清空去重账本：同一载荷在新会话里可以再派发", () => {
    const payload = directive("改登录", "修好 src/auth.ts");
    // 思考通道先写出同一份载荷：不派发、也不占去重账本。
    chunk("agent_thought_chunk", payload);
    expect(manager.spawn).not.toHaveBeenCalled();
    chunk("agent_message_chunk", payload);
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    p.resetSuperDirectiveScans();
    chunk("agent_message_chunk", payload);
    expect(manager.spawn).toHaveBeenCalledTimes(2);
  });
});
