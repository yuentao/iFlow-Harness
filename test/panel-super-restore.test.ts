/**
 * 子会话归档的宿主接线（落盘 → 重启 → 恢复历史会话 → 看板重建）。
 *
 * 这是「重启恢复历史会话时子会话没有被正确恢复」的回归防线：
 *  1. 子会话状态一变就落盘（扩展随时可能被重启，不落盘就等于那次运行没发生过）；
 *  2. 恢复某个主会话时把它的子会话取回看板；
 *  3. 恢复出来的记录如实标成历史（进程已亡，不能谎称还在跑）；
 *  4. 归档跟着会话一起删（会话没了，它的子会话记录也不该留着）。
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
import { readSuperSessionArchive, writeSuperSessionArchive } from "../src/panel/super-store.js";
import { fromPersistedSuperSession, type PersistedSuperSession } from "../shared/super-agent.js";

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

type PanelInternals = {
  store: {
    getState: () => {
      activeSessionId: string | null;
      sessionId: string | null;
      superSessions?: { id: string; status: string; restored?: boolean }[];
    };
    sessionStarted: (meta: { sessionId: string }) => void;
    setSessions: (sessions: unknown[], activeSessionId?: string | null) => void;
    sendToast: (level: string, message: string, opts?: unknown) => number;
  };
  restoreSuperSessions: (mainSessionId: string) => Promise<void>;
  persistSuperSessions: (options?: { force?: boolean }) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  currentMainSessionId: () => string | null;
  publishSuperSessions: () => void;
  getSuperAgent: () => unknown;
  superAgent: unknown;
  superHeartbeatTimer: NodeJS.Timeout | null;
  pruneUnrestorableSessions: () => Promise<unknown[]>;
  persistSessions: (sessions: unknown[], activeId: string | null) => Promise<void>;
  hasPersistedTranscript: (id: string) => boolean;
  migrateLegacyTranscripts: () => Promise<void>;
  ensureSuperHeartbeat: () => void;
  pendingSuperReportPrompts: Array<{ mainSessionId: string | null; text: string }>;
  pendingSuperActionReceipts: Array<{ mainSessionId: string | null; text: string }>;
  pendingDelegatedUserTurns: Array<{
    mainSessionId: string | null;
    text: string;
    images: { data: string; mimeType: string }[];
    files: { name: string; path: string }[];
    droppedByChild: number;
  }>;
  pendingSuperToolCallCorrections: Array<{ mainSessionId: string | null; text: string }>;
  pendingSuperMerges: Array<{ id: string; reason: string }>;
};

function record(overrides: Partial<PersistedSuperSession> = {}): PersistedSuperSession {
  return {
    id: "super-old",
    title: "上次没跑完的活",
    task: "干活",
    status: "running",
    mainSessionId: "main-1",
    isolation: { kind: "git_worktree", path: "/tmp/wt-old", branch: "iflow/super/old", baseRef: "abc" },
    createdAt: 100,
    updatedAt: 200,
    reports: [],
    ...overrides,
  };
}

describe("ChatPanel · 超流体归档的恢复接线", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;

  /** 切到某个主会话（与真实的恢复流程一致：切换器选中 → 该会话成为当前会话）。 */
  function switchTo(sessionId: string): void {
    p.store.setSessions([{ id: sessionId, label: sessionId }], sessionId);
  }

  /** 看板投影（管理器 emit 后落到 store 上的内容）。 */
  function board(): {
    id: string;
    status: string;
    restored?: boolean;
    isolation?: { kind?: string; released?: boolean; recycled?: boolean };
  }[] {
    return p.store.getState().superSessions ?? [];
  }

  beforeEach(async () => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superrestore-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    p.store.sessionStarted({ sessionId: "main-1" });
    switchTo("main-1");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("恢复主会话时把它的超流体取回看板", async () => {
    await writeSuperSessionArchive(storageDir, "main-1", [record()]);

    await p.restoreSuperSessions("main-1");

    expect(board()).toHaveLength(1);
    expect(board()[0]?.id).toBe("super-old");
  });

  it("恢复出来的记录标成历史，且不谎称还在运行", async () => {
    await writeSuperSessionArchive(storageDir, "main-1", [record({ status: "running" })]);

    await p.restoreSuperSessions("main-1");

    const restored = board()[0];
    // 进程早随扩展宿主退出了 —— 说它还在跑就是撒谎。
    expect(restored?.status).toBe("cancelled");
    expect(restored?.restored).toBe(true);
  });

  it("别的会话的超流体不会串到当前会话的看板上", async () => {
    await writeSuperSessionArchive(storageDir, "main-1", [record()]);
    await writeSuperSessionArchive(storageDir, "main-2", [record({ id: "super-other" })]);

    switchTo("main-2");
    await p.restoreSuperSessions("main-2");

    expect(board()).toHaveLength(1);
    expect(board()[0]?.id).toBe("super-other");
  });

  it("没有归档的主会话恢复出空看板（不报错）", async () => {
    await p.restoreSuperSessions("never-dispatched");
    expect(board()).toEqual([]);
  });

  it("归档写进去再读出来，记录原样回来", async () => {
    await writeSuperSessionArchive(storageDir, "main-1", [record()]);
    const loaded = await readSuperSessionArchive(storageDir, "main-1");
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0]?.isolation.branch).toBe("iflow/super/old");
    expect(loaded.damaged).toBe(false);
    // 往返一次后仍然是可恢复的历史记录。
    expect(fromPersistedSuperSession(loaded.sessions[0]!).restored).toBe(true);
  });

  it("归档损坏时如实提示用户，而不是静默清空看板", async () => {
    // 损坏的归档读出来必须是「损坏」，不能是「没有子会话」—— 否则用户重启后
    // 只看到空板子，完全看不出发生过什么。
    const dir = path.join(storageDir, "super-sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "main-1.json"), "{ 截断的 JSON", "utf8");

    const toasts: { level: string; message: string }[] = [];
    const original = p.store.sendToast.bind(p.store);
    p.store.sendToast = (level: string, message: string, opts?: unknown) => {
      toasts.push({ level, message });
      return original(level, message, opts);
    };

    await p.restoreSuperSessions("main-1");

    // 记录确实读不出来 → 看板是空的……
    expect(board()).toEqual([]);
    // ……但用户**被明确告知**了（而不是静默的空）：警告里带着备份路径。
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts[0]?.level).toBe("warning");
    expect(toasts[0]?.message).toContain("记录已损坏");
    expect(toasts[0]?.message).toContain(".corrupt");
  });

  it("关键变更（恢复出来的超流体）立刻落盘，不等节流窗口", async () => {
    const manager = p.getSuperAgent() as {
      restoreSessions: (mainSessionId: string, records: unknown[]) => void;
    };
    manager.restoreSessions("main-1", [
      {
        id: "super-old",
        title: "上次没跑完的活",
        task: "干活",
        status: "cancelled",
        restored: true,
        isolation: { kind: "git_worktree", path: "/tmp/wt-old", branch: "iflow/super/old" },
        mainSessionId: "main-1",
        createdAt: 100,
        updatedAt: 200,
        reports: [],
      },
    ]);

    const file = path.join(storageDir, "super-sessions", "main-1.json");
    // 关键变更不排队：立刻能读到磁盘上的归档。
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(file)).toBe(true);
    const loaded = await readSuperSessionArchive(storageDir, "main-1");
    expect(loaded.sessions.map((s) => s.id)).toEqual(["super-old"]);
  });

  it("内容没变时不重复写归档（写放大控制）", async () => {
    const manager = p.getSuperAgent() as {
      restoreSessions: (mainSessionId: string, records: unknown[]) => void;
      archivableSessions: (mainSessionId: string) => PersistedSuperSession[];
    };
    manager.restoreSessions("main-1", [
      {
        id: "super-old",
        title: "上次没跑完的活",
        task: "干活",
        status: "cancelled",
        restored: true,
        isolation: { kind: "git_worktree", path: "/tmp/wt-old", branch: "iflow/super/old" },
        mainSessionId: "main-1",
        createdAt: 100,
        updatedAt: 200,
        reports: [],
      },
    ]);
    const file = path.join(storageDir, "super-sessions", "main-1.json");

    // 第一次落盘是 fire-and-forget（管理器 emit → 宿主落盘）。**文件出现不等于
    // 写链收尾**：归档写是「临时文件 + rename」的串行链，rename 落地之后才记
    // lastWritten。只轮询 existsSync 会让紧随其后的 force 落在记账之前，被当成
    // 「内容变了」再写一次（mtime 变动，用例偶发失败）。
    // 归档写是串行链：再排一次**同样内容**的写并 await 它，就等于等此前所有写
    //（含 lastWritten 记账）全部完成 —— 这是可 await 的收尾信号，不是猜时间。
    await writeSuperSessionArchive(storageDir, "main-1", manager.archivableSessions("main-1"));
    expect(fs.existsSync(file)).toBe(true);
    const first = fs.statSync(file).mtimeMs;

    // 再落一次同样的内容：文件不该被重写（mtime 不变）。
    await p.persistSuperSessions({ force: true });
    expect(fs.statSync(file).mtimeMs).toBe(first);
  });

  it("删除会话：终止其超流体、清掉它的待投递队列、归档删除且空转心跳停表", async () => {
    // 管理器替身：记录删除归属，看板投影为空（子会话已被清掉）。
    const forgotten: string[] = [];
    const manager = {
      forgetMainSession: vi.fn(async (id: string) => {
        forgotten.push(id);
        return { ids: ["super-x"], worktrees: [] };
      }),
      list: () => [],
      archivableMainSessionIds: () => [],
      archivableSessions: () => [],
    };
    p.superAgent = manager;
    await writeSuperSessionArchive(storageDir, "main-1", [record()]);
    // 欠着这个会话的待投递内容（汇报 / 回执 / 改道消息 / 参数纠错 / 合并）。
    p.pendingSuperReportPrompts = [{ mainSessionId: "main-1", text: "旧汇报" }];
    p.pendingSuperActionReceipts = [{ mainSessionId: "main-1", text: "旧回执" }];
    p.pendingDelegatedUserTurns = [
      { mainSessionId: "main-1", text: "旧消息", images: [], files: [], droppedByChild: 0 },
    ];
    p.pendingSuperToolCallCorrections = [{ mainSessionId: "main-1", text: "旧纠错" }];
    p.pendingSuperMerges = [{ id: "super-x", reason: "旧的合并请求" }];
    p.ensureSuperHeartbeat();
    expect(p.superHeartbeatTimer).not.toBeNull();

    await p.deleteSession("main-1");

    expect(forgotten).toEqual(["main-1"]);
    // 队列清干净：留着它们既投不出去，又会让心跳永远停不下来。
    expect(p.pendingSuperReportPrompts).toEqual([]);
    expect(p.pendingSuperActionReceipts).toEqual([]);
    expect(p.pendingDelegatedUserTurns).toEqual([]);
    expect(p.pendingSuperToolCallCorrections).toEqual([]);
    expect(p.pendingSuperMerges).toEqual([]);
    // 归档文件与看板投影都跟着会话消失。
    expect(fs.existsSync(path.join(storageDir, "super-sessions", "main-1.json"))).toBe(false);
    expect(board()).toEqual([]);
    // 没有待办 → 心跳停表（旧实现让它常驻）。
    expect(p.superHeartbeatTimer).toBeNull();
  });

  it("#6 prune 会一并回收 .corrupt 损坏备份，且不误删仍归属会话的归档", async () => {
    // 损坏备份名固定为「归档名.corrupt」（SA-D）；旧 prune 只删 .json，
    // 备份会永久堆积。这里钉住：会话离开列表时本体与备份一起回收，仍归属
    // 的会话其本体和备份都原样保留。
    await p.persistSessions([{ id: "main-1", label: "main-1" }], "main-1");
    vi.spyOn(p, "hasPersistedTranscript").mockReturnValue(true);
    vi.spyOn(p, "migrateLegacyTranscripts").mockResolvedValue(undefined);

    const dir = path.join(storageDir, "super-sessions");
    fs.mkdirSync(dir, { recursive: true });
    const names = [
      "main-1.json",
      "main-1.json.corrupt",
      "main-gone.json",
      "main-gone.json.corrupt",
    ];
    for (const name of names) fs.writeFileSync(path.join(dir, name), "[]", "utf8");

    await p.pruneUnrestorableSessions();

    expect(fs.existsSync(path.join(dir, "main-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "main-1.json.corrupt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "main-gone.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "main-gone.json.corrupt"))).toBe(false);
  });

  it("#7 恢复时目录已不在磁盘 → 校正为已清理状态（不再显示待清理）", async () => {
    // 归档里的 worktree 路径指向一个不存在的目录（被外部删除），恢复出来的
    // 记录不该再显示「清理工作目录」。分支事实无法确定时保守显示「目录已删、
    // 分支保留」，绝不谎报什么都没有 —— 也不自动删任何东西。
    const missing = path.join(storageDir, "already-gone");
    await writeSuperSessionArchive(storageDir, "main-1", [
      record({ isolation: { kind: "git_worktree", path: missing, branch: "iflow/super/old" } }),
    ]);

    await p.restoreSuperSessions("main-1");

    const isolation = board()[0]?.isolation;
    expect(isolation?.released).toBe(true);
    expect(isolation?.recycled).toBe(true); // 分支事实未知 → 保守保留
    expect(fs.existsSync(missing)).toBe(false); // 只读校正，绝不自动删
  });

  it("#7 恢复时目录其实还在 → 撤销归档里过期的 released 标记", async () => {
    const live = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superrestore-live-"));
    try {
      await writeSuperSessionArchive(storageDir, "main-1", [
        record({
          status: "completed",
          isolation: { kind: "git_worktree", path: live, branch: "iflow/super/old", released: true },
        }),
      ]);

      await p.restoreSuperSessions("main-1");

      const isolation = board()[0]?.isolation;
      // 归档说已清理，目录实际还在：撤销过期标记，看板恢复可清理入口。
      expect(isolation?.released).toBeFalsy();
      expect(isolation?.recycled).toBeFalsy();
    } finally {
      fs.rmSync(live, { recursive: true, force: true });
    }
  });

  it("S3 · 子会话清理后归档写空，恢复时不再冒出已清理的子会话", async () => {
    // 归档一条历史子会话（released=true → 清理只删记录，不做磁盘操作）。
    await writeSuperSessionArchive(storageDir, "main-1", [
      record({
        status: "completed",
        isolation: {
          kind: "git_worktree",
          path: "/tmp/wt-old",
          branch: "iflow/super/old",
          released: true,
        },
      }),
    ]);
    await p.restoreSuperSessions("main-1");
    expect(board()).toHaveLength(1);

    const mgr = p.getSuperAgent() as { cleanup: (id: string) => Promise<{ ok: boolean }> };
    expect((await mgr.cleanup("super-old")).ok).toBe(true);
    expect(board()).toEqual([]);

    // 关键不变量：清理后落盘的是空数组（归属 main-1 仍在），不是把旧记录留在
    // 磁盘上等下次恢复复活。
    await p.persistSuperSessions({ force: true });
    const loaded = await readSuperSessionArchive(storageDir, "main-1");
    expect(loaded.damaged).toBe(false);
    expect(loaded.sessions).toEqual([]);

    // 再恢复一次：已清理的子会话不会再出现。
    await p.restoreSuperSessions("main-1");
    expect(board()).toEqual([]);
  });
});
