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

describe("ChatPanel · 子会话归档的恢复接线", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;

  /** 切到某个主会话（与真实的恢复流程一致：切换器选中 → 该会话成为当前会话）。 */
  function switchTo(sessionId: string): void {
    p.store.setSessions([{ id: sessionId, label: sessionId }], sessionId);
  }

  /** 看板投影（管理器 emit 后落到 store 上的内容）。 */
  function board(): { id: string; status: string; restored?: boolean }[] {
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
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("恢复主会话时把它的子会话取回看板", async () => {
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

  it("别的会话的子会话不会串到当前会话的看板上", async () => {
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
    expect(toasts[0]?.message).toContain(".corrupt-");
  });

  it("关键变更（恢复出来的子会话）立刻落盘，不等节流窗口", async () => {
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
});
