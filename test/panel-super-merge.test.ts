/**
 * 子会话合并请求（宿主侧）。
 *
 * 两条要求：
 *  1. 子会话完成、改动**没能自动合并**时，宿主自动发起合并请求 —— 不再把这
 *     件事留给用户点看板上的按钮；主会话正忙时排队，空闲后再发起（串行）。
 *  2. 合并请求是内部指令：提示词发给智能体，但**不在转录里显形**（没有用户
 *     气泡，也不会把会话标题改成这段提示词）。
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

describe("ChatPanel 子会话合并请求（自动触发 + 隐藏提示词）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];

  beforeEach(async () => {
    // sendPrompt 会等一次工作区快照（真实 git 子进程）；这里只测合并请求的
    // 触发与隐藏，关掉 checkpoint 免得每次都拉起 git。
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-supermerge-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
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
        recordAgentMerge: async () => true,
      }),
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

  /**
   * 等到合并请求真的发出为止。夹具里的 promptWithRetry 永不 resolve（这一轮
   * 在测试里就是「还没结束」），所以只能等「请求已发出」这个信号，不能 await
   * 整条 drain 链。
   */
  async function waitForCalls(count: number, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (calls.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("自动触发合并请求：提示词发给智能体，但转录里没有用户气泡", async () => {
    p.scheduleSuperMerge("super-1", "改动与本地未提交改动重叠");
    await waitForCalls(1);

    expect(calls).toHaveLength(1);
    const text = calls[0]!.prompt.map((b) => b.text ?? "").join("\n");
    expect(text).toContain("git merge --no-ff iflow/super/a");
    // 自动触发：开头说的是「没能自动合并」，不是「用户在看板点击了」。
    expect(text).toContain("没能自动合并");
    expect(text).not.toContain("用户在看板点击了");
    // 内部指令不在转录里显形（没有用户气泡）。
    expect(p.store.getState().blocks.filter((b) => b.kind === "user")).toHaveLength(0);

    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();
  });

  it("主会话正忙时排队，空闲后自动发起（不丢请求）", async () => {
    p.store.replaceState({ ...p.store.getState(), status: "streaming" });
    p.scheduleSuperMerge("super-1", "改动重叠");
    await flush();
    expect(calls).toHaveLength(0);

    p.store.replaceState({ ...p.store.getState(), status: "idle" });
    void p.drainSuperMerges();
    await waitForCalls(1);
    expect(calls).toHaveLength(1);

    calls[0]!.resolve({ stopReason: "end_turn" });
    await flush();
  });
});
