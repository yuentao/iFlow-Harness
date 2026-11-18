/**
 * Super Agent 队列竞态回归（bug 修复批 SA-A）。
 *
 * 五条互不覆盖的竞态：
 *  1. 动作回执 drain 在 await 之后用过期的 index 出队 —— 等待期间会话被删
 *     会让队列变短，splice(index) 删掉别的会话刚投出的回执，或把这条留在
 *     队列里重复投递（主会话把同一个动作执行两遍）。
 *  2. dispose 漏清两份队列 / 漏复位车道标志 —— 已销毁实例的 drain finally
 *     会把锁写回，残留合并请求还能触发唤醒。
 *  3. 心跳 tick 同步抛错 → auto-stop 不执行 → interval 永久存活。
 *  4. 参数纠错 drain 另立一把锁，与「共用同一条车道」的注释及另外三个 drain
 *     不一致（mainLane 才是实际互斥保证）。
 *  5. 合并 drain 失败时只靠外部回调唤醒；派发失败必须登记一次性唤醒，且
 *     失败的 id 要排到队尾而不是塞回队首挡住后续请求。
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

type PanelInternals = {
  disposed: boolean;
  sendPrompt: (
    text: string,
    images?: unknown,
    files?: unknown,
    contexts?: unknown,
    options?: { hidden?: boolean; delegateOnBusy?: boolean },
  ) => Promise<boolean>;
  drainSuperActionReceipts: () => Promise<void>;
  drainSuperToolCallCorrections: () => Promise<void>;
  drainSuperMerges: () => Promise<void>;
  superHeartbeatTick: () => void;
  ensureSuperHeartbeat: () => void;
  stopSuperHeartbeat: () => void;
  refreshSuperWaitHeartbeat: () => void;
  hasSuperWork: () => boolean;
  currentMainSessionId: () => string | null;
  getSuperAgent: () => unknown;
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: SessionState) => void;
    sendToast: (...args: unknown[]) => number;
  };
  log: { lines: { level: string; message: string }[] };
  pendingSuperActionReceipts: Array<{ mainSessionId: string | null; text: string }>;
  pendingSuperToolCallCorrections: Array<{ mainSessionId: string | null; text: string }>;
  pendingSuperMerges: Array<{ id: string; reason: string }>;
  pendingSuperReportPrompts: Array<{ mainSessionId: string | null; text: string }>;
  pendingDelegatedUserTurns: unknown[];
  superReportRunning: boolean;
  superMergeRunning: boolean;
  mainLane: symbol | null;
  superMergeWakeupTimer: ReturnType<typeof setTimeout> | null;
  superHeartbeatTimer: ReturnType<typeof setInterval> | null;
  autoTurnsStoppedFor: string | null;
};

const COMPLETED_CHILD: SuperSessionUi = {
  id: "super-1",
  title: "修好登录跳转",
  task: "修好 src/auth.ts",
  status: "completed",
  isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
  createdAt: 1000,
  updatedAt: 2000,
  reports: [],
};

describe("Super Agent 队列竞态回归", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let owner: string;

  beforeEach(() => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superrace-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    owner = "main-A";
    p.store.sessionStarted({ sessionId: owner });
    p.store.replaceState({ ...p.store.getState(), status: "idle" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  it("#1 回执等待期间会话被删：按对象身份出队，不误删别的会话回执", async () => {
    const a = { mainSessionId: owner, text: "receipt-A" };
    const b = { mainSessionId: "main-B", text: "receipt-B" };
    p.pendingSuperActionReceipts.push(a, b);
    let release!: (started: boolean) => void;
    p.sendPrompt = vi.fn(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    ) as unknown as PanelInternals["sendPrompt"];

    const draining = p.drainSuperActionReceipts();
    await flush(); // 让 drain 跑到 await 上
    expect(p.superReportRunning).toBe(true);

    // 模拟 deleteSession("main-A") 的并发过滤：等待期间队列被改写，A 已被清掉。
    p.pendingSuperActionReceipts = p.pendingSuperActionReceipts.filter(
      (item) => item.mainSessionId !== owner,
    );
    expect(p.pendingSuperActionReceipts).toEqual([b]);

    release(true);
    await draining;

    // 旧实现用过期 index 会把 B 一并删掉（B 的回执永久丢失）。
    expect(p.pendingSuperActionReceipts).toEqual([b]);
  });

  it("#2 dispose 清两份队列并复位四个车道标志", async () => {
    p.pendingSuperToolCallCorrections.push({ mainSessionId: owner, text: "x" });
    p.pendingSuperMerges.push({ id: "super-x", reason: "r" });
    p.superReportRunning = true;
    p.superMergeRunning = true;
    p.mainLane = Symbol("lane");
    p.superMergeWakeupTimer = setTimeout(() => {}, 60_000);

    await panel.dispose();

    expect(p.pendingSuperActionReceipts).toEqual([]);
    expect(p.pendingDelegatedUserTurns).toEqual([]);
    expect(p.pendingSuperToolCallCorrections).toEqual([]);
    expect(p.pendingSuperMerges).toEqual([]);
    expect(p.superReportRunning).toBe(false);
    expect(p.superMergeRunning).toBe(false);
    expect(p.mainLane).toBeNull();
    expect(p.superMergeWakeupTimer).toBeNull();
  });

  it("#3 心跳 tick 同步抛错仍会 auto-stop 停表", () => {
    p.ensureSuperHeartbeat();
    expect(p.superHeartbeatTimer).not.toBeNull();
    p.refreshSuperWaitHeartbeat = () => {
      throw new Error("boom");
    };

    p.superHeartbeatTick();

    // 抛错被吞掉，hasSuperWork() 的 auto-stop 判断照常执行。
    expect(p.superHeartbeatTimer).toBeNull();
    expect(p.log.lines.some((l) => l.level === "warn" && l.message.includes("heartbeat tick failed"))).toBe(true);
  });

  it("#4 参数纠错 drain 用共用的 superReportRunning 锁", async () => {
    p.pendingSuperToolCallCorrections.push({ mainSessionId: owner, text: "fix" });
    let release!: (started: boolean) => void;
    p.sendPrompt = vi.fn(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    ) as unknown as PanelInternals["sendPrompt"];

    const draining = p.drainSuperToolCallCorrections();
    await flush();
    // 旧实现这里 true 的是独立锁，superReportRunning 仍为 false。
    expect(p.superReportRunning).toBe(true);

    release(true);
    await draining;
    expect(p.superReportRunning).toBe(false);
    expect(p.pendingSuperToolCallCorrections).toEqual([]);
  });

  it("#5 合并派发失败：失败 id 排到队尾并登记一次性唤醒", async () => {
    p.pendingSuperMerges.push({ id: "super-1", reason: "first" });
    p.pendingSuperMerges.push({ id: "super-2", reason: "second" });
    p.getSuperAgent = () => ({
      get: () => COMPLETED_CHILD,
      // null = 已有合并子会话在跑，requestSuperMerge 走 auto 重排队。
      spawnMerge: vi.fn(async () => null),
    });

    await p.drainSuperMerges();

    // 失败 id 没有塞回队首挡住 super-2，而是经 scheduleSuperMerge 去重排到队尾。
    expect(p.pendingSuperMerges.map((item) => item.id)).toEqual(["super-2", "super-1"]);
    // 没派出去时登记一次性唤醒，不只靠外部 onMergeResult 回调。
    expect(p.superMergeWakeupTimer).not.toBeNull();
  });
});
