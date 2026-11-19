import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import { AGENT_ATTACHMENT_HEADER } from "../shared/messages.js";
import type { QueuedPromptUi, SessionState } from "../shared/messages.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
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
  reject: (e: unknown) => void;
};

type PanelState = Pick<
  SessionState,
  "sessionId" | "status" | "queue" | "queuePaused" | "blocks" | "initializing" | "replaying"
> & { activeSessionId: string | null };

type PanelInternals = {
  client: { cancel: (id: string) => void; cancelAgent?: (sessionId: string, agentId: string) => Promise<{ stopped?: boolean; reason?: string }> } | null;
  panelVisible: boolean;
  historySyncBusy: boolean;
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  postToWebview: (message: unknown) => void;
  ensureClient: () => Promise<unknown>;
  sendPrompt: (
    text: string,
    images?: { data: string; mimeType: string }[],
    files?: { name: string; path: string }[],
    contexts?: unknown,
    options?: { internal?: boolean; delegateOnBusy?: boolean; hidden?: boolean },
  ) => Promise<boolean>;
  promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  maybeGenerateAiTitle: (id: string) => Promise<void>;
  store: {
    getState: () => PanelState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: unknown) => void;
    sendToast: (...args: unknown[]) => number;
    dismissToast: (toastId: number) => void;
  };
};

/** Let every pending microtask AND the queued macrotasks run. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * 跨平台清理临时存储目录。
 *
 * Linux CI 上 checkpoint 的异步落盘可能在 rmSync 递归删除的途中重建
 * `checkpoints/<session>`，即使 rmSync 自带 maxRetries 也会抛 ENOTEMPTY
 * （PR #8 的真实失败）。这里重试「整棵目录的删除」，让那次在飞写入先落定；
 * 只对瞬态 errno 重试，真正的权限/磁盘错误照常抛出，不掩盖问题。
 */
async function rmStorageDir(dir: string): Promise<void> {
  const transient = new Set(["ENOTEMPTY", "EEXIST", "EBUSY", "EPERM"]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!transient.has(code) || attempt >= 9) throw err;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

/**
 * 主会话车道 / Super Agent 派发接线。
 *
 * Enter while streaming 不再入本地队列（shared/queue.ts 的入队路径已下线）：
 * 整条消息（含附件）改道给子会话（独立 CLI 进程 + worktree）。当前回合内不写
 * 用户块、不碰主会话 CLI；回合结束后由宿主把那条消息以 hidden 回合补投回主
 * 会话，与子会话汇报 / 合并请求共用同一条车道。另覆盖汇报投递、等待心跳、
 * 队列动作（resume/sendNow/edit/clear）与整份状态替换时清空队列。
 */
describe("ChatPanel message queue (P0-3 wiring)", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let toasts: { level: string; message: string; opts?: Record<string, unknown> }[];

  beforeEach(async () => {
    // sendPrompt awaits the M3 workspace snapshot (a real git subprocess); this
    // file tests queue wiring only, so disable checkpoints to keep the prompt
    // landing within a single flush().
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-queue-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) =>
        new Promise<{ stopReason: string }>((resolve, reject) => {
          calls.push({ prompt, resolve, reject });
        }),
    ) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.maybeGenerateAiTitle = async () => {};
    toasts = [];
    vi.spyOn(p.store, "sendToast").mockImplementation(((level: string, message: string, opts?: Record<string, unknown>) => {
      toasts.push({ level, message, opts });
      return 0;
    }) as PanelInternals["store"]["sendToast"]);
    p.store.sessionStarted({ sessionId: "q-session" });
    p.panelVisible = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    await rmStorageDir(storageDir);
  });

  const send = (text: string): Promise<void> => p.handleWebviewMessage({ type: "sendPrompt", text });
  const queue = (): QueuedPromptUi[] => p.store.getState().queue ?? [];

  it("returns host-owned turn diffs with correlation and rejects stale sessions", async () => {
    const post = vi.spyOn(p, "postToWebview").mockImplementation(() => {});
    p.store.replaceState({ ...p.store.getState(), status: "idle", blocks: [
      { kind: "user", id: "u", text: "go" },
      { kind: "tool", toolCallId: "edit", title: "edit", status: "completed", diff: { path: "a", oldText: "a", newText: "b" } },
    ] });
    const request = { type: "requestTurnChanges", sessionId: "q-session", userBlockId: "u", requestId: "r" };
    await p.handleWebviewMessage(request);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "turnChanges", requestId: "r", userBlockId: "u", unavailable: false, records: [expect.objectContaining({ toolCallId: "edit" })] }));
    await p.handleWebviewMessage({ ...request, sessionId: "old" });
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ unavailable: true, records: [] }));
    const open = vi.fn();
    Object.assign(p, { openToolDiff: open });
    await p.handleWebviewMessage({ type: "openDiff", sessionId: "old", toolCallId: "edit" });
    expect(open).not.toHaveBeenCalled();
  });

  it("routes single-file undo with its turn anchor", async () => {
    const revert = vi.fn();
    Object.assign(p, { revertTurnFile: revert });
    await p.handleWebviewMessage({ type: "revertTurnFile", sessionId: "q-session", userBlockId: "u", key: "src/a.ts" });
    expect(revert).toHaveBeenCalledWith("q-session", "u", "src/a.ts");
  });

  it("Enter while streaming dispatches a child session: no queue, no CLI call", async () => {
    const first = send("first turn");
    await flush();
    expect(p.store.getState().status).toBe("streaming");
    const blocksBefore = p.store.getState().blocks.length;
    const spawn = vi.fn((_spec: { title: string; task: string }) => ({ id: "super-1" }));
    Object.assign(p, { getSuperAgent: () => ({ spawn }) });

    await send("delegate this");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ title: "delegate this", task: "delegate this" });
    expect(queue()).toHaveLength(0); // no local queue entry
    expect(p.store.getState().blocks.length).toBe(blocksBefore); // not appended
    expect(calls).toHaveLength(1); // CLI untouched WHILE the main turn runs
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    await flush();

    // 本回合收尾后，那条被改道的消息才补投成主会话的下一个 hidden 回合：
    // 主会话全程不并发，子会话也只派发一次（补投不会二次派发）。
    expect(calls).toHaveLength(2);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(p.store.getState().blocks.filter((b) => b.kind === "user")).toHaveLength(1);
    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("Enter while streaming carries the turn's attachments to the child session", async () => {
    const first = send("first turn");
    await flush();
    expect(p.store.getState().status).toBe("streaming");
    const spawn = vi.fn((_spec: unknown) => ({ id: "super-1" }));
    Object.assign(p, { getSuperAgent: () => ({ spawn }) });

    await p.handleWebviewMessage({
      type: "sendPrompt",
      text: "look at this",
      images: [{ data: "QUJD", mimeType: "image/png" }],
      files: [{ name: "note.txt", path: "C:/tmp/note.txt" }],
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const spec = spawn.mock.calls[0]?.[0] as { task: string; attachments?: unknown[] };
    // Images ride as inline blocks (they have no path), files by source path —
    // the manager copies both into the child's own attachment dir. The name is
    // model-facing (it lands in the child's task prompt), so it is English.
    expect(spec.attachments).toEqual([
      { name: "image1", data: "QUJD", mimeType: "image/png" },
      { name: "note.txt", path: "C:/tmp/note.txt" },
    ]);
    // The parent tree is unreachable from the child's worktree: its path must
    // not be quoted into the task text.
    expect(spec.task).not.toContain("C:/tmp/note.txt");
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    await flush();
    // 回合收尾会补投一个 hidden 回合（内容由下面的专门用例断言）；收掉它，
    // 别留下悬空未决的 prompt。
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("streaming 带附件消息在回合结束后被补投主会话（含附件块/路径，不二次派发）", async () => {
    const first = send("first turn");
    await flush();
    expect(p.store.getState().status).toBe("streaming");
    const spawn = vi.fn((_spec: unknown) => ({ id: "super-1" }));
    Object.assign(p, { getSuperAgent: () => ({ spawn }) });
    const sendSpy = vi.spyOn(p, "sendPrompt");

    await p.handleWebviewMessage({
      type: "sendPrompt",
      text: "look at this",
      images: [{ data: "QUJD", mimeType: "image/png" }],
      files: [{ name: "note.txt", path: "C:/tmp/note.txt" }],
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1); // 派发当刻绝不并发第二个主会话 prompt

    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    await flush();

    // 补投成主会话的下一个 hidden 回合：原文 + 附件块 + 文件路径清单都在。
    expect(calls).toHaveLength(2);
    const backfill = calls[1]!.prompt;
    const text = backfill.map((b) => b.text ?? "").join("\n");
    expect(text).toContain("[补投用户消息]");
    expect(text).toContain("the USER typed while the main session was generating");
    expect(text).toContain("look at this");
    expect(text).not.toContain("[子会话状态上报]"); // 不伪装成子会话汇报
    expect(text).toContain(AGENT_ATTACHMENT_HEADER);
    expect(text).toContain("- note.txt → C:/tmp/note.txt");
    expect(backfill).toContainEqual({ type: "image", data: "QUJD", mimeType: "image/png" });

    // 补投走 hidden + delegateOnBusy:false：不伪造用户气泡、绝不二次派发。
    expect(sendSpy.mock.calls.at(-1)?.[4]).toMatchObject({
      hidden: true,
      delegateOnBusy: false,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(p.store.getState().blocks.filter((b) => b.kind === "user")).toHaveLength(1);

    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
    // 出队后不再重复补投。
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it("child-session reports become the next main-session turn once the current one ends", async () => {
    const first = send("first turn");
    await flush();
    expect(p.store.getState().status).toBe("streaming");
    const reportPrompt = vi.fn(() => "[子会话状态上报] ok");
    Object.assign(p, {
      superAgent: {
        reportPrompt,
        list: () => [{ id: "super-1", status: "completed" }],
      },
    });

    const internals = p as unknown as {
      queueSuperReport: (entries: unknown[]) => void;
    };
    internals.queueSuperReport([{ session: { id: "super-1", title: "t" }, report: { state: "done", summary: "ok" } }]);
    await flush();
    // The main turn is still streaming: the report waits, it must not
    // interleave a second prompt on the same ACP session.
    expect(calls).toHaveLength(1);

    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    await flush();

    // Turn settled → the report is handed over as the NEXT turn, so the agent
    // (not the user) carries the flow forward.
    expect(calls).toHaveLength(2);
    expect(reportPrompt).toHaveBeenCalledTimes(1);
    const text = calls[1]!.prompt.map((b) => b.text ?? "").join("\n");
    expect(text).toContain("[子会话状态上报]");
    expect(text).toContain("[子会话看板]"); // still a main-session turn
    // Hidden instruction: the assistant answers in the transcript, but no
    // user bubble is fabricated for a host-driven turn.
    expect(p.store.getState().blocks.filter((b) => b.kind === "user")).toHaveLength(1);

    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("delivers a report as soon as each child settles (one turn per settled child)", async () => {
    const sessions: { id: string; status: string }[] = [
      { id: "super-1", status: "running" },
      { id: "super-2", status: "running" },
    ];
    const reportPrompt = vi.fn((_entries: unknown[]) => "[子会话状态上报] ok");
    Object.assign(p, { superAgent: { reportPrompt, list: () => sessions } });
    const internals = p as unknown as {
      queueSuperReport: (entries: unknown[]) => void;
      drainSuperReports: () => Promise<void>;
    };

    // 第一个子会话结束 → 立刻交一次汇报（不必等第二个跑完）。
    sessions[0]!.status = "completed";
    internals.queueSuperReport([{ session: { id: "super-1", title: "t1" }, report: { state: "ready", summary: "1 ok" } }]);
    await flush();
    expect(reportPrompt).toHaveBeenCalledTimes(1);
    expect((reportPrompt.mock.calls[0]?.[0] as unknown[]).length).toBe(1);
    expect(calls).toHaveLength(1);

    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();

    // 第二个子会话结束 → 再交一次汇报（各交各的，不合并成一轮）。
    sessions[1]!.status = "completed";
    internals.queueSuperReport([{ session: { id: "super-2", title: "t2" }, report: { state: "ready", summary: "2 ok" } }]);
    await flush();
    expect(reportPrompt).toHaveBeenCalledTimes(2);
    expect((reportPrompt.mock.calls[1]?.[0] as unknown[]).length).toBe(1);
    expect(calls).toHaveLength(2);

    calls[1]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("keeps a queued report while the host is replaying history, delivers it afterwards", async () => {
    const reportPrompt = vi.fn(() => "[子会话状态上报] ok");
    Object.assign(p, {
      superAgent: { reportPrompt, list: () => [{ id: "super-1", status: "completed" }] },
    });
    p.store.replaceState({ ...p.store.getState(), status: "idle", replaying: true });
    const internals = p as unknown as {
      queueSuperReport: (entries: unknown[]) => void;
      drainSuperReports: () => Promise<void>;
    };
    internals.queueSuperReport([{ session: { id: "super-1", title: "t" }, report: { state: "ready", summary: "ok" } }]);
    await flush();
    expect(calls).toHaveLength(0); // never interrupt a replay

    p.store.replaceState({ ...p.store.getState(), replaying: false, status: "idle" });
    void internals.drainSuperReports(); // what the Super Agent heartbeat does on its tick
    await flush();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("shows the waiting heartbeat while children run and the main session is idle", async () => {
    const internals = p as unknown as { refreshSuperWaitHeartbeat: () => void };
    const child = {
      id: "super-1",
      title: "修复登录",
      task: "修好 src/auth.ts",
      status: "running",
      isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a" },
      createdAt: 1,
      updatedAt: 2,
      reports: [],
    };
    p.store.replaceState({
      ...p.store.getState(),
      status: "idle",
      superSessions: [child],
    });
    internals.refreshSuperWaitHeartbeat();
    const pill = toasts.at(-1);
    expect(pill?.level).toBe("info");
    expect(pill?.message).toContain("正在等待 1 个超流体汇报");
    expect(pill?.opts).toMatchObject({ persistent: true, displayOnly: true });

    // Progress frames keep arriving; the same fingerprint must not re-send
    // the pill over and over.
    const count = toasts.length;
    internals.refreshSuperWaitHeartbeat();
    expect(toasts.length).toBe(count);

    // A main-session turn means it is obviously working — no waiting pill.
    p.store.replaceState({ ...p.store.getState(), status: "streaming" });
    internals.refreshSuperWaitHeartbeat();
    expect(toasts.filter((t) => t.message.includes("正在等待"))).toHaveLength(1);
  });

  it("subagent stop routes to _iflow/agent/cancel without cancelling the turn", async () => {
    const cancelTurn = vi.fn();
    const cancelAgent = vi.fn(async (_sessionId: string, agentId: string) =>
      agentId === "child" ? { stopped: true } : { stopped: false, reason: "not_found" });
    p.client = { cancel: cancelTurn, cancelAgent };
    const blocks = [{
      kind: "subagent", agentId: "parent", taskToolCallId: "root", title: "root", agentType: null, status: "in_progress", entries: [{
        kind: "subagent", agentId: "child", taskToolCallId: "task-child", title: "child", agentType: null, status: "pending", entries: [],
      }],
    }];
    p.store.replaceState({ ...p.store.getState(), status: "streaming", blocks: structuredClone(blocks) });
    // gate: wrong session / unknown agent never reach the wire
    await p.handleWebviewMessage({ type: "stopSubagent", sessionId: "old-session", agentId: "child" });
    await p.handleWebviewMessage({ type: "stopSubagent", sessionId: "q-session", agentId: "missing" });
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(cancelTurn).not.toHaveBeenCalled();
    // confirmed stop: card flips to stopped, the TURN keeps running
    await p.handleWebviewMessage({ type: "stopSubagent", sessionId: "q-session", agentId: "child" });
    expect(cancelAgent).toHaveBeenCalledExactlyOnceWith("q-session", "child");
    expect(cancelTurn).not.toHaveBeenCalled();
    const stopped = (p.store.getState().blocks[0] as { entries: { agentId: string; stopped?: boolean; status: string }[] })
      .entries.find((e) => e.agentId === "child")!;
    expect(stopped.stopped).toBe(true);
    expect(stopped.status).toBe("failed");
    expect(p.store.getState().status).toBe("streaming");
    // not_found answers with an info toast, no card mutation
    p.store.replaceState({ ...p.store.getState(), blocks: structuredClone(blocks) });
    await p.handleWebviewMessage({ type: "stopSubagent", sessionId: "q-session", agentId: "parent" });
    expect(toasts.at(-1)?.message).toContain("该子代理已结束");
    // a terminal card is no longer a valid target
    p.store.replaceState({ ...p.store.getState(), status: "idle" });
    await p.handleWebviewMessage({ type: "stopSubagent", sessionId: "q-session", agentId: "child" });
    expect(cancelAgent).toHaveBeenCalledTimes(2);
    p.client = null;
  });

  it("replay-in-progress rejects enqueue (restore must not race the transcript)", async () => {
    const first = send("first turn");
    await flush();
    // beginReplay also reports status "streaming" — the enqueue gate must
    // reject it via the replaying flag instead of queueing into a restore.
    p.store.replaceState({ ...p.store.getState(), replaying: true });
    await send("during replay");
    expect(queue()).toHaveLength(0);
    calls[0]!.reject(new Error("stop test"));
    await first;
    await flush();
  });

  it("contexts assemble into the prompt prefix (titled fence, never slash-leading)", async () => {
    const turn = p.handleWebviewMessage({
      type: "sendPrompt",
      text: "解释这个报错",
      contexts: [
        { id: "c1", kind: "problems", label: "工作区诊断", detail: "2 条", content: "a.ts:\n  [错误] L3: boom" },
        { id: "c2", kind: "git", label: "工作区 Git", detail: "status + diff", content: "  M a.ts" },
      ],
    });
    await flush();
    expect(calls).toHaveLength(1);
    const sent = calls[0]!.prompt[0]!.text!;
    // card order preserved, each a titled fenced section ahead of the text.
    // The section titles in the AGENT-facing prompt are English (the
    // transcript keeps the Chinese ones).
    expect(sent.indexOf("Workspace diagnostics")).toBeLessThan(sent.indexOf("Workspace git status"));
    expect(sent.indexOf("Workspace git status")).toBeLessThan(sent.indexOf("解释这个报错"));
    expect(sent).toContain("```text\na.ts:\n  [错误] L3: boom\n```");
    expect(sent.startsWith("/")).toBe(false); // CLI slash-gate discipline
    calls[0]!.resolve({ stopReason: "end_turn" });
    await turn;
    await flush();
  });

  it("every main-session turn carries the child-session board digest", async () => {
    p.store.replaceState({
      ...p.store.getState(),
      superSessions: [
        {
          id: "super-board-1",
          title: "修复登录跳转",
          task: "修好它",
          status: "running",
          isolation: { kind: "directory", path: "/tmp/wt" },
          createdAt: 1,
          updatedAt: 2,
          reports: [],
        },
      ],
    });
    const turn = send("继续");
    await flush();
    const sent = calls[0]!.prompt[0]!.text!;
    expect(sent.startsWith("[子会话看板]")).toBe(true);
    expect(sent).toContain("super-board-1");
    expect(sent).toContain("继续");
    calls[0]!.resolve({ stopReason: "end_turn" });
    await turn;
    await flush();
  });

  it("普通回合（无超流体）也注入看板标记，作为主会话的角色信号", async () => {
    const turn = send("你好");
    await flush();
    // 系统提示用「有没有 [子会话看板]」区分主会话与子会话；空看板若返回空串，
    // 首轮主会话会被误判成子会话而自己动手干活（测到的真实缺陷）。
    const text = calls[0]!.prompt[0]!.text!;
    expect(text.startsWith("[子会话看板]")).toBe(true);
    expect(text.endsWith("你好")).toBe(true);
    calls[0]!.resolve({ stopReason: "end_turn" });
    await turn;
    await flush();
  });

  it("management actions in the main agent's text drive the manager", async () => {
    const retry = vi.fn(async (_id: string) => true);
    const cancel = vi.fn(async (_id: string) => true);
    Object.assign(p, {
      getSuperAgent: () => ({
        retry,
        cancel,
        respond: vi.fn(() => true),
        merge: vi.fn(async () => ({ ok: true })),
        cleanup: vi.fn(async () => ({ ok: true })),
      }),
    });
    const internals = p as unknown as { scanSuperActions: (content: unknown) => void };
    internals.scanSuperActions({
      type: "text",
      text: ['```super-agent-actions', '{"actions":[{"action":"retry","sessionId":"super-1"}]}', "```"].join("\n"),
    });
    await flush();
    expect(retry).toHaveBeenCalledExactlyOnceWith("super-1");
    expect(cancel).not.toHaveBeenCalled();
    expect(toasts.at(-1)?.message).toContain("成功 1 个");
  });
});

/**
 * 「停止生成」的宿主语义（用户报告：正在生成时点停止很难停下来，要点好几次）。
 *
 * 两层实证根因：
 *  1. 状态先翻成 streaming、`session/prompt` 后发出 —— 中间还要拍一轮
 *     checkpoint 快照。这个窗口里的 `session/cancel` 到不了 CLI（vendor
 *     bundle 实证：`cancelPendingPrompt()` 在没有在飞请求时直接抛
 *     "Not currently generating"），点击被静默丢掉，本轮随后照常跑完，用户
 *     只能再点一次。
 *  2. cancel 生效后，宿主排队中的自动回合（子会话汇报 / 被改道消息补投）
 *     会在同一拍接上下一轮，面板立刻又变回「正在生成」，一次停止看起来
 *     毫无作用（见 panel-super-waiting 的压制用例）。
 *
 * 这里用**真实的** promptWithRetry（不 mock），因为根因修复就在它里面。
 */
describe("ChatPanel 停止生成", () => {
  type StopInternals = {
    client: { cancel: (id: string) => void; prompt?: (req: unknown, timeoutMs?: number) => Promise<{ stopReason: string }> } | null;
    cancelSeen: boolean;
    promptRequestSessionId: string | null;
    cancelSentForPrompt: boolean;
    autoTurnsStoppedFor: string | null;
    ensureClient: () => Promise<unknown>;
    captureWorkspaceSnapshot: (sessionId: string, text: string) => Promise<string | null>;
    promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
    persistActiveTranscript: () => Promise<void>;
    touchActiveSession: () => Promise<void>;
    maybeGenerateAiTitle: (id: string) => Promise<void>;
    handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
    store: {
      getState: () => SessionState;
      sessionStarted: (meta: { sessionId: string }) => void;
    };
  };

  let panel: ChatPanel;
  let p: StopInternals;
  let storageDir: string;
  let client: { cancel: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-stop-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as StopInternals;
    client = { cancel: vi.fn(), prompt: vi.fn() };
    p.client = client;
    p.ensureClient = async () => client;
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.maybeGenerateAiTitle = async () => {};
    p.store.sessionStarted({ sessionId: "stop-session" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    await rmStorageDir(storageDir);
  });

  it("请求还没发出时按停止：这一轮不会被发出去，按 cancelled 收尾", async () => {
    // Hold the turn inside the checkpoint-snapshot window — the status is
    // already "streaming" (the Stop button is on screen) but the CLI has no
    // request yet, which is exactly where the old cancel was silently lost.
    let releaseSnapshot!: (value: string | null) => void;
    p.captureWorkspaceSnapshot = () =>
      new Promise<string | null>((resolve) => {
        releaseSnapshot = resolve;
      });

    const turn = p.handleWebviewMessage({ type: "sendPrompt", text: "跑个长任务" });
    await flush();
    expect(p.store.getState().status).toBe("streaming");

    await p.handleWebviewMessage({ type: "cancel" });
    // Nothing in flight on the CLI → no cancel notification (it would be a
    // no-op rejected as "Not currently generating").
    expect(client.cancel).not.toHaveBeenCalled();

    releaseSnapshot(null);
    await turn;
    await flush();

    // The turn never reached the CLI: the click actually stopped it.
    expect(client.prompt).not.toHaveBeenCalled();
    expect(p.store.getState().status).toBe("idle");
    expect(p.store.getState().stopReason).toBe("cancelled");
  });

  it("请求在飞时连点两次停止：只发一次 session/cancel，settle 后回到 idle", async () => {
    let releasePrompt!: (value: { stopReason: string }) => void;
    client.prompt.mockImplementation(
      () =>
        new Promise<{ stopReason: string }>((resolve) => {
          releasePrompt = resolve;
        }),
    );

    // No snapshot hold here: this turn reaches the CLI and stays in flight.
    p.captureWorkspaceSnapshot = async () => null;
    const turn = p.handleWebviewMessage({ type: "sendPrompt", text: "跑个长任务" });
    await flush();
    expect(client.prompt).toHaveBeenCalledTimes(1);
    expect(p.store.getState().status).toBe("streaming");

    await p.handleWebviewMessage({ type: "cancel" });
    await p.handleWebviewMessage({ type: "cancel" });
    // One in-flight request = one cancel; repeats are not re-sent (the CLI
    // rejects the second with "Not currently generating").
    expect(client.cancel).toHaveBeenCalledExactlyOnceWith("stop-session");

    releasePrompt({ stopReason: "cancelled" });
    await turn;
    await flush();
    expect(p.store.getState().status).toBe("idle");
    expect(p.store.getState().stopReason).toBe("cancelled");
  });
});
