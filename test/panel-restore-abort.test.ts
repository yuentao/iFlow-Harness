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
  startNewSession: (options?: { bypassSuperWait?: boolean }) => Promise<void>;
  confirmAndPurgeSuperResidue: () => Promise<void>;
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
  getSuperAgent: () => unknown;
  superSweepDelayMs: number;
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
    // 生产默认延时 3000ms 用于避开恢复窗口的 I/O；测试里置 0 让 sweep
    // 立即触发，才能验证「挂住的 sweep 不阻塞恢复」。
    p.superSweepDelayMs = 0;
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

  it("正常恢复：不回归（写转录 + 恢复超流体 + 「已恢复会话」）", async () => {
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

  // -------------------------------------------------------------------------
  // BUG B：残留 worktree 清扫不得卡住「新建会话」
  //
  // 用户实测：重启后点「新建会话」毫无反应，控制台反复打
  // `new session: joining the in-flight run`。因果链是
  // connect() → restoreSession() → restoreSuperSessions() →
  // await sweepStaleWorktrees()（逐个残留目录跑 git status / merge-base），
  // 而 startNewSession 遇到在飞的恢复会先等它 settle —— 清扫有多慢，
  // 「新建会话」就被压多久，且每次点击只是 join 同一个 run。
  // -------------------------------------------------------------------------
  describe("残留清扫改为后台异步", () => {
    /** beforeEach 为了别的用例把 restoreSuperSessions 整体 stub 掉了；这里换回真实实现。 */
    function useRealRestoreSuperSessions(): void {
      const proto = Object.getPrototypeOf(panel) as {
        restoreSuperSessions: (id: string) => Promise<void>;
      };
      p.restoreSuperSessions = proto.restoreSuperSessions.bind(panel);
    }

    /** 注入一个假管理器；三类 sweep 全走传入的 sweep（挂住 / 抛错 / 立即返回），各自计数。 */
    function stubSweep(sweep: () => Promise<unknown>): {
      calls: number;
      attachmentCalls: number;
      dirCalls: number;
    } {
      const counter = { calls: 0, attachmentCalls: 0, dirCalls: 0 };
      p.getSuperAgent = () =>
        ({
          restoreSessions: () => undefined,
          sweepStaleWorktrees: () => {
            counter.calls += 1;
            return sweep();
          },
          // 三类 sweep 全部挂住：恢复必须不 await 它们中的任何一个。
          sweepStaleSuperAttachmentDirs: () => {
            counter.attachmentCalls += 1;
            return sweep();
          },
          sweepStaleSuperDirs: () => {
            counter.dirCalls += 1;
            return sweep();
          },
        }) as never;
      return counter;
    }

    it("清扫挂住时恢复立即完成，新建会话也不被阻塞", async () => {
      useRealRestoreSuperSessions();
      const sweep = deferred<unknown>();
      const counter = stubSweep(() => sweep.promise);

      // 清扫永不 resolve：恢复必须自己走完（旧实现会在这里挂死）。
      const restored = await Promise.race([
        p.restoreSession("restored-session"),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
      ]);
      expect(restored).toBe(true);
      // 定时器到点后三类 sweep 全部触发、全部挂住；恢复没有 await 它们中
      // 的任何一个（旧实现只挂 worktrees 时这一点覆盖不到另两类）。
      await flush();
      expect(counter.calls).toBe(1);
      expect(counter.attachmentCalls).toBe(1);
      expect(counter.dirCalls).toBe(1);
      expect(p.store.getState().sessionId).toBe("restored-session");

      // 清扫还在飞，新建会话照常完成（不再等恢复/清扫 settle）。
      const outcome = await Promise.race([
        p.startNewSession().then(() => "done" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
      ]);
      expect(outcome).toBe("done");
      expect(p.store.getState().sessionId).toMatch(/^probe-/);
      // 后台清扫只跑了一份，没有被恢复/新建会话重复触发。
      expect(counter.calls).toBe(1);
    });

    it("冷启动自动新建跳过残留检测：countResidue 挂住也不阻塞启动", async () => {
      // 模拟 countResidue 扫全工作区卡死：残留检测一旦被调用就永不返回。
      let confirmCalls = 0;
      p.confirmAndPurgeSuperResidue = async () => {
        confirmCalls += 1;
        await new Promise<void>(() => {});
      };

      // 冷启动路径传 bypassSuperWait：残留检测根本不该被碰到。
      const outcome = await Promise.race([
        p.startNewSession({ bypassSuperWait: true }).then(() => "done" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
      ]);
      expect(outcome).toBe("done");
      expect(confirmCalls).toBe(0);
      expect(p.store.getState().sessionId).toMatch(/^probe-/);

      // 对照：用户显式点「新建会话」仍要走残留检测（这里放行以便断言调用）。
      const confirm = vi.spyOn(p, "confirmAndPurgeSuperResidue").mockResolvedValue();
      await p.startNewSession();
      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it("清扫失败不影响恢复与新建（可观测但不冒泡）", async () => {
      useRealRestoreSuperSessions();
      stubSweep(async () => {
        throw new Error("git status 挂了");
      });

      await expect(p.restoreSession("restored-session")).resolves.toBe(true);
      // 让 catch/finally 链跑完：失败只记日志 + toast，绝不变成 unhandled rejection。
      await flush();
      await expect(p.startNewSession()).resolves.toBeUndefined();
      expect(p.store.getState().sessionId).toMatch(/^probe-/);
      expect(p.store.getState().status).not.toBe("error");
    });

    it("超流体看板恢复失败不把整个恢复判成失败，也不挡新建会话", async () => {
      useRealRestoreSuperSessions();
      p.getSuperAgent = () => {
        throw new Error("看板恢复炸了");
      };

      await expect(p.restoreSession("restored-session")).resolves.toBe(true);
      await flush();
      expect(p.store.getState().sessionId).toBe("restored-session");
      // 转录已经恢复，用户不会被一个看板故障困住：新建会话照常。
      await expect(p.startNewSession()).resolves.toBeUndefined();
      expect(p.store.getState().sessionId).toMatch(/^probe-/);
    });

    it("连续点 3 次新建会话只发一次 session/new（不排队成多个 run）", async () => {
      const pending = deferred<{
        sessionId: string;
        modes: { currentModeId: string; availableModes: { id: string }[] };
        _meta: { models: { currentModelId: string }; availableCommands: never[]; availableSkills: never[] };
      }>();
      client.newSession.mockImplementationOnce(() => pending.promise);

      const first = p.startNewSession();
      const second = p.startNewSession();
      const third = p.startNewSession();
      await flush();
      // 三次点击共享同一次 run：CLI 只看到一次 session/new。
      expect(client.newSession).toHaveBeenCalledTimes(1);

      pending.resolve({
        sessionId: "probe-1",
        modes: { currentModeId: "default", availableModes: [{ id: "default" }] },
        _meta: { models: { currentModelId: "m1" }, availableCommands: [], availableSkills: [] },
      });
      await Promise.all([first, second, third]);

      expect(client.newSession).toHaveBeenCalledTimes(1);
      expect(p.store.getState().sessionId).toBe("probe-1");
    });
  });
});
