/**
 * 子会话合并请求（宿主侧）。
 *
 * 三条要求：
 *  1. 子会话完成、改动**没能自动合并**时，宿主自动发起合并请求 —— 不再把这
 *     件事留给用户点看板上的按钮；主会话正忙时排队，空闲后再发起（串行）。
 *  2. 合并**不再走主会话的 prompt 通道**：宿主派一个跑在主仓工作区的合并
 *     子会话（repo 档）去执行 `git merge --no-ff`。主会话既不跑 git，也不
 *     收到这段提示词。
 *  3. 排队的是「待派发的合并子会话」，不是一条待发送的提示词。
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
import type { SessionState } from "../shared/messages.js";
import type { SuperSessionUi } from "../shared/super-agent.js";

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
};

/** 宿主派发合并子会话时交给管理器的参数。 */
type MergeSpawn = {
  source: SuperSessionUi;
  task: string;
  title: string;
};

type PanelInternals = {
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: unknown,
  ) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  maybeGenerateAiTitle: (id: string) => Promise<void>;
  /** 宿主自动合并请求的排队入口（管理器回调）。 */
  scheduleSuperMerge: (id: string, reason: string) => void;
  /** 队列的串行 drain（回合结束钩子也会调它）。 */
  drainSuperMerges: () => Promise<void>;
  getSuperAgent: () => unknown;
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: unknown) => void;
  };
};

/** 一个已结束、有分支的子会话（自动集成没把它合进来）。 */
const CHILD: SuperSessionUi = {
  id: "super-1",
  title: "修复登录跳转",
  task: "修好 src/auth.ts",
  status: "completed",
  isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
  createdAt: 1000,
  updatedAt: 2000,
  reports: [],
};

describe("ChatPanel 子会话合并请求（派合并子会话，不再走主会话 prompt）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let merges: MergeSpawn[];

  beforeEach(async () => {
    // sendPrompt 会等一次工作区快照（真实 git 子进程）；这里只测合并请求的
    // 触发与派发，关掉 checkpoint 免得每次都拉起 git。
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-supermerge-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    merges = [];
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) =>
        new Promise<{ stopReason: string }>((resolve) => {
          calls.push({ prompt, resolve });
        }),
    ) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.maybeGenerateAiTitle = async () => {};
    p.store.sessionStarted({ sessionId: "sm-session" });
    Object.assign(p, {
      getSuperAgent: () => ({
        get: () => CHILD,
        // 合并子会话由管理器派发（repo 档）；这里只记录宿主交给它的参数。
        spawnMerge: async (request: MergeSpawn) => {
          merges.push(request);
          return {
            id: "super-merge-1",
            title: request.title,
            task: request.task,
            status: "preparing",
            isolation: { kind: "repo", path: here },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            reports: [],
          };
        },
      }),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  /**
   * 等到合并子会话真的派出为止。合并子会话是异步的（它有自己的 CLI 进程），
   * 所以这里等「已派发」这个信号，而不是等它跑完。
   */
  async function waitForMerges(count: number, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (merges.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("自动触发合并请求：派合并子会话，主会话收不到这段提示词", async () => {
    p.scheduleSuperMerge("super-1", "改动与本地未提交改动重叠");
    await waitForMerges(1);

    expect(merges).toHaveLength(1);
    const request = merges[0]!;
    // 来源就是那个没合进来的子会话。
    expect(request.source.id).toBe("super-1");
    // 标题点明是哪个分支。
    expect(request.title).toBe("合并分支 iflow/super/a");
    // 任务书就是合并任务书本身。
    expect(request.task).toContain("git merge --no-ff iflow/super/a");
    // 自动触发：开头说的是「没能自动合并」，不是「用户在看板点击了」（提示词正文是英文）。
    expect(request.task).toContain("could not be merged automatically");
    expect(request.task).not.toContain("The user clicked");

    // 关键：合并不再走主会话的 prompt 通道（主会话不跑 git）。
    expect(calls).toHaveLength(0);
    expect(p.store.getState().blocks.filter((b) => b.kind === "user")).toHaveLength(0);
  });

  it("主会话正忙时排队，空闲后自动派发（不丢请求）", async () => {
    p.store.replaceState({ ...p.store.getState(), status: "streaming" });
    p.scheduleSuperMerge("super-1", "改动重叠");
    await flush();
    expect(merges).toHaveLength(0);

    p.store.replaceState({ ...p.store.getState(), status: "idle" });
    void p.drainSuperMerges();
    await waitForMerges(1);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.source.id).toBe("super-1");
  });
});