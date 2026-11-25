/**
 * 定向回归：附件 base64 合法性、自动压缩的按会话归属，
 * 以及审批/提问回包按 id 精确路由（S1 核实：不存在跨请求串台）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { SessionUsageUi } from "../shared/messages.js";

const here = path.dirname(fileURLToPath(import.meta.url));

interface UriLike {
  fsPath: string;
}
type WorkspaceMut = {
  fs?: {
    createDirectory?: (uri: UriLike) => Promise<void>;
    writeFile: (uri: UriLike, content: Uint8Array) => Promise<void>;
  };
};
const workspaceMut = vscode.workspace as unknown as WorkspaceMut;

type NoopTimer = NodeJS.Timeout;

type Internals = {
  stageDroppedFiles: (msg: {
    type: "stageFiles";
    requestId: number;
    files: Array<{ name: string; data: string }>;
  }) => Promise<void>;
  handleWebviewMessage: (msg: unknown) => Promise<void>;
  handleApprovalResponse: (id: string, optionId: string | null) => void;
  handleQuestionAnswers: (id: string, answers: Record<string, string | string[]>) => void;
  postToWebview: (message: unknown) => void;
  pendingApprovals: Map<
    string,
    {
      options: Array<{ optionId: string; kind: string; name: string }>;
      toolName: string;
      resolve: (response: unknown) => void;
      timer: NoopTimer;
    }
  >;
  pendingQuestions: Map<string, { resolve: (response: unknown) => void; timer: NoopTimer }>;
  client: unknown;
  historySyncBusy: boolean;
  autoCompressInFlight: boolean;
  autoCompressSessions: Set<string>;
  maybeAutoCompressOnIdle: (sessionId: string) => Promise<boolean>;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: unknown,
  ) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  store: {
    getState: () => {
      sessionId: string | null;
      status: string;
      usage?: SessionUsageUi | null;
      pendingApproval: unknown;
      pendingQuestions: unknown;
    };
    sessionStarted: (meta: { sessionId: string }) => void;
    sendToast: (...args: unknown[]) => number;
    dismissToast: (id: number) => void;
  };
};

/** A timer object that is never scheduled: the handlers only clear it. */
const deadTimer = (): NoopTimer => undefined as unknown as NoopTimer;

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      store.has(key) ? (store.get(key) as T) : (defaultValue as T),
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

function usage(window: number | null, used: number): SessionUsageUi {
  return {
    inputTokens: used,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: used,
    contextWindow: window,
    contextUsed: used,
    estimated: false,
  };
}

describe("stageDroppedFiles · base64 合法性", () => {
  let panel: ChatPanel;
  let p: Internals;
  let tmp: string;
  let writes: Array<{ fsPath: string; text: string }>;
  let posted: unknown[];

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-stage-base64-"));
    writes = [];
    posted = [];
    workspaceMut.fs = {
      createDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async (uri: UriLike, content: Uint8Array) => {
        writes.push({ fsPath: uri.fsPath, text: Buffer.from(content).toString("utf8") });
      }),
    };
    panel = new ChatPanel(makeContext(tmp), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as Internals;
    vi.spyOn(p, "postToWebview").mockImplementation((message: unknown) => {
      posted.push(message);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("写入规范 base64 并回报真实路径", async () => {
    const data = Buffer.from("hello", "utf8").toString("base64");
    await p.stageDroppedFiles({
      type: "stageFiles",
      requestId: 11,
      files: [{ name: "note.txt", data }],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toBe("hello");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "stagedFiles", requestId: 11 });
    expect((posted[0] as { paths: Array<string | null> }).paths[0]).toMatch(/note\.txt$/);
  });

  it("接受不带填充的规范 base64", async () => {
    const data = Buffer.from("hello", "utf8").toString("base64").replace(/=+$/, "");
    await p.stageDroppedFiles({
      type: "stageFiles",
      requestId: 12,
      files: [{ name: "unpadded.txt", data }],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toBe("hello");
  });

  it("非法字符：不写截断文件，回包对应槽位为 null", async () => {
    await p.stageDroppedFiles({
      type: "stageFiles",
      requestId: 13,
      files: [{ name: "bad.txt", data: "aGVs@@bG8=" }],
    });
    expect(writes).toHaveLength(0);
    expect((posted[0] as { paths: Array<string | null> }).paths).toEqual([null]);
  });

  it("错位填充与长度%4===1：逐文件失败且互不影响", async () => {
    await p.stageDroppedFiles({
      type: "stageFiles",
      requestId: 14,
      files: [
        { name: "pad.txt", data: "aG=VsbG8=" },
        { name: "len.txt", data: "a" },
      ],
    });
    expect(writes).toHaveLength(0);
    expect((posted[0] as { paths: Array<string | null> }).paths).toEqual([null, null]);
  });

  it("void 路由在文件系统异常时记录日志而非抛出未处理拒绝", async () => {
    workspaceMut.fs!.createDirectory = vi.fn(async () => {
      throw new Error("fs exploded");
    });
    await p.handleWebviewMessage({
      type: "stageFiles",
      requestId: 15,
      files: [{ name: "x.txt", data: "eA==" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const log = (panel as unknown as {
      log: { lines: Array<{ level: string; message: string }> };
    }).log;
    expect(log.lines.some((line) => line.level === "warn" && line.message.includes("stageFiles failed"))).toBe(
      true,
    );
    expect(
      posted.some((message) => (message as { type?: string }).type === "stagedFiles"),
    ).toBe(false);
  });
});

describe("自动压缩按 sessionId 归属", () => {
  let panel: ChatPanel;
  let p: Internals;
  let tmp: string;
  let compressCalls: string[];
  let resolvers: Array<() => void>;

  beforeEach(async () => {
    setConfigOverrides({ checkpoints: false, autoCompressOnIdle: true });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-compress-sessions-"));
    panel = new ChatPanel(makeContext(tmp), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as Internals;
    compressCalls = [];
    resolvers = [];
    const fakeClient = {};
    p.client = fakeClient;
    p.ensureClient = async () => fakeClient;
    p.persistActiveTranscript = async () => {};
    p.promptWithRetry = vi.fn(
      async (_client: unknown, sessionId: string) =>
        await new Promise<{ stopReason: string }>((resolve) => {
          compressCalls.push(sessionId);
          resolvers.push(() => resolve({ stopReason: "end_turn" }));
        }),
    ) as unknown as Internals["promptWithRetry"];
    vi.spyOn(p.store, "sendToast").mockImplementation((() => 7) as unknown as Internals["store"]["sendToast"]);
    vi.spyOn(p.store, "dismissToast").mockImplementation((() => {}) as unknown as Internals["store"]["dismissToast"]);
    p.store.sessionStarted({ sessionId: "s-A" });
    p.store.getState().status = "idle";
    p.store.getState().usage = usage(1000, 990);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setConfigOverrides({});
    await panel.dispose();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("会话 A 压缩在飞时不阻塞会话 B", async () => {
    const first = p.maybeAutoCompressOnIdle("s-A");
    expect(p.autoCompressSessions.has("s-A")).toBe(true);

    // 切到 B：A 会在 await 之后的 sessionId 复核处自行退出，但它的在飞标记
    // 在 finally 释放之前，旧的全局布尔会直接把 B 挡在门外。
    p.store.sessionStarted({ sessionId: "s-B" });
    p.store.getState().status = "idle";
    p.store.getState().usage = usage(1000, 990);
    const second = p.maybeAutoCompressOnIdle("s-B");
    expect(p.autoCompressSessions.has("s-B")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(compressCalls).toContain("s-B");

    if (resolvers[0]) resolvers[0]();
    await Promise.all([first, second]);
    expect(p.autoCompressSessions.size).toBe(0);
  });

  it("同一会话内仍保持互斥", async () => {
    const first = p.maybeAutoCompressOnIdle("s-A");
    expect(p.autoCompressSessions.has("s-A")).toBe(true);
    expect(await p.maybeAutoCompressOnIdle("s-A")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(compressCalls).toEqual(["s-A"]);
    resolvers[0]!();
    await first;
    expect(p.autoCompressSessions.size).toBe(0);
  });

  it("兼容旧全局覆盖布尔：置 true 时任何会话都不压缩", async () => {
    p.autoCompressInFlight = true;
    expect(await p.maybeAutoCompressOnIdle("s-A")).toBe(false);
    expect(compressCalls).toHaveLength(0);
  });
});

describe("审批/提问回包按请求 id 路由", () => {
  let panel: ChatPanel;
  let p: Internals;
  let tmp: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-approval-route-"));
    panel = new ChatPanel(makeContext(tmp), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as Internals;
  });

  afterEach(async () => {
    await panel.dispose();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("点第二张审批卡只解析第二张，第一张仍在等待", () => {
    let resolvedA: unknown = "pending";
    let resolvedB: unknown = "pending";
    const options = [
      { optionId: "allow", kind: "allow", name: "允许" },
      { optionId: "reject", kind: "reject", name: "拒绝" },
    ];
    p.pendingApprovals.set("ap-1", {
      options,
      toolName: "write_1",
      resolve: (response) => {
        resolvedA = response;
      },
      timer: deadTimer(),
    });
    p.pendingApprovals.set("ap-2", {
      options,
      toolName: "write_2",
      resolve: (response) => {
        resolvedB = response;
      },
      timer: deadTimer(),
    });

    p.handleApprovalResponse("ap-2", "allow");

    expect(resolvedA).toBe("pending");
    expect(resolvedB).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(p.pendingApprovals.has("ap-1")).toBe(true);
    expect(p.pendingApprovals.has("ap-2")).toBe(false);

    p.handleApprovalResponse("ap-1", "reject");
    expect(resolvedA).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(p.pendingApprovals.size).toBe(0);
  });

  it("点第二张提问卡只解析第二张，第一张仍在等待", () => {
    let resolvedA: unknown = "pending";
    let resolvedB: unknown = "pending";
    p.pendingQuestions.set("q-1", {
      resolve: (response) => {
        resolvedA = response;
      },
      timer: deadTimer(),
    });
    p.pendingQuestions.set("q-2", {
      resolve: (response) => {
        resolvedB = response;
      },
      timer: deadTimer(),
    });

    p.handleQuestionAnswers("q-2", { topic: "b" });

    expect(resolvedA).toBe("pending");
    expect(resolvedB).toEqual({ answers: { topic: "b" } });
    expect(p.pendingQuestions.has("q-1")).toBe(true);
    expect(p.pendingQuestions.has("q-2")).toBe(false);
  });
});
