import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import { QqHost, type QqHostCallbacks } from "../src/panel/qq-host.js";
import { QQ_LEASE_TAKEOVER_ACTION, QQ_LEASE_WAIT_ACTION } from "../shared/messages.js";
import {
  QQ_LEASE_KEY,
  QQ_LEASE_TTL_MS,
  type QqLease,
} from "../shared/qq-lease.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TAKEOVER_LABEL = "接管（将停止另一窗口的机器人）";
const WAIT_LABEL = "等待";

/** A toast captured from the QqHost's `getStore().sendToast` stub. */
type CapturedToast = {
  level: string;
  message: string;
  opts?: {
    persistent?: boolean;
    actions?: { actionId: string; label: string; variant?: string }[];
  };
};

/**
 * 两个假窗口共用同一个 backing Map —— 模拟 VSCode globalState 跨窗口共享。
 * 每个 Memento 独立记录自己的 update 调用，便于断言「没写 iflow.qq.enabled」。
 */
function makeMemento(backing: Map<string, unknown>) {
  const updates: Array<[string, unknown]> = [];
  const memento = {
    backing,
    updates,
    get<T>(key: string, defaultValue?: T): T | undefined {
      return backing.has(key) ? (backing.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      updates.push([key, value]);
      if (value === undefined) backing.delete(key);
      else backing.set(key, value);
    },
    keys(): string[] {
      return [...backing.keys()];
    },
  };
  return memento as unknown as vscode.Memento & {
    backing: Map<string, unknown>;
    updates: Array<[string, unknown]>;
  };
}

function makeContext(memento: vscode.Memento): vscode.ExtensionContext {
  return {
    globalState: memento,
    workspaceState: memento,
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    subscriptions: [],
    extensionUri: { fsPath: here },
    extensionPath: here,
    extensionMode: 3,
    logPath: here,
    storageUri: { fsPath: here },
    globalStorageUri: { fsPath: here },
    storagePath: here,
    globalStoragePath: here,
    asAbsolutePath: (p: string) => path.join(here, p),
  } as unknown as vscode.ExtensionContext;
}

type HostInternals = {
  qq?: unknown;
  tickQqLease: () => Promise<void>;
};

function makeHost(
  memento: vscode.Memento,
  ownerId: string,
  posted: unknown[] = [],
  toasts: CapturedToast[] = [],
): QqHost {
  const io = {
    readAll: () => ({ enabled: true, allowedUsers: [] }),
    inspect: () => undefined,
    writeAll: async () => undefined,
    getSecret: async (key: string) => (key.includes("secret") ? "fake-app-secret" : "fake-app-id"),
    setSecret: async () => undefined,
    deleteSecret: async () => undefined,
  };
  const deps: QqHostCallbacks = {
    log: { info: () => undefined, warn: () => undefined },
    getContext: () => makeContext(memento),
    getServices: () => ({ qqSettingsIo: io }),
    getStore: () => ({
      getState: () => ({}),
      pushSnapshot: () => undefined,
      sendToast: (level: string, message: string, opts?: CapturedToast["opts"]) => {
        toasts.push({ level, message, opts });
        return toasts.length;
      },
      dismissToast: () => undefined,
    }) as never,
    isDisposed: () => false,
    getClient: () => null,
    getPendingQuestions: () => new Map(),
    getPendingSuperReportPrompts: () => [],
    isSuperReportRunning: () => false,
    getSuperRepoRoot: () => null,
    postToWebview: (message) => posted.push(message),
    getSuperAgent: () => null,
    requestSuperMerge: async () => ({ dispatched: false, queued: false, reason: "test" }),
    sendPrompt: async () => false,
    sendTurnCancel: () => undefined,
    mainSessionFree: () => true,
    getCancelSeen: () => false,
    setCancelSeen: () => undefined,
    pushQqSettings: async () => undefined,
    onQqSettingsChanged: async () => undefined,
    cancelAllQqMainInjections: () => undefined,
    waitForQqMainFree: async () => "free" as const,
  };
  const host = new QqHost(deps);
  host.qqLeaseOwnerId = ownerId;
  return host;
}

/** 把 doStartQq 换成纯记账：拿到租约就记一次并装一个假现场。 */
function installFakeStart(host: QqHost, calls: string[]) {
  return vi.spyOn(host, "doStartQq").mockImplementation(async () => {
    calls.push(host.qqLeaseOwnerId);
    (host as unknown as HostInternals).qq = {
      service: { stop: async () => undefined, listTasks: () => [] },
      store: {},
      config: { enabled: true },
      io: {},
      qqbot: { adapter: { close: async () => undefined } },
    };
  });
}

/**
 * 直接调用 panel.ts 的 toastAction 分发器，用最小 `this` 顶替整块面板。
 * 这样「点卡片按钮」走的是真实生产分支，却不需要构造 ChatPanel 的一堆服务。
 */
type ToastDispatchThis = {
  store: { dismissToast: (id: number) => void };
  qqHost: { takeoverQqLease: () => Promise<void> };
};
const dispatchToastAction = (
  ChatPanel.prototype as unknown as {
    handleToastAction: (this: ToastDispatchThis, actionId: string, toastId?: number) => void;
  }
).handleToastAction;

function clickToast(actionId: string, takeover: () => Promise<void>): number[] {
  const dismissed: number[] = [];
  dispatchToastAction.call(
    { store: { dismissToast: (id) => dismissed.push(id) }, qqHost: { takeoverQqLease: takeover } },
    actionId,
    42,
  );
  return dismissed;
}

async function flushTakeover(): Promise<void> {
  // takeoverQqLease 里 forceTake + 再次 startQqIfEnabled 有若干 await，
  // 给几轮定时器让它们落定。
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QQ 单活租约 · 宿主侧多窗口", () => {
  it("先持有者保留：后来者 YIELDED 不启动，冲突发面板 toast（非原生弹窗）", async () => {
    const backing = new Map<string, unknown>();
    const a = makeHost(makeMemento(backing), "window-a");
    const postedB: unknown[] = [];
    const toastsB: CapturedToast[] = [];
    const b = makeHost(makeMemento(backing), "window-b", postedB, toastsB);
    const callsA: string[] = [];
    const callsB: string[] = [];
    const startA = installFakeStart(a, callsA);
    const startB = installFakeStart(b, callsB);
    const warningSpy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);

    try {
      await a.startQqIfEnabled();
      await b.startQqIfEnabled();
      expect(callsA).toEqual(["window-a"]);
      expect(callsB).toEqual([]);
      expect(a.qqLeaseState).toBe("ACTIVE");
      expect(b.qqLeaseState).toBe("YIELDED");
      expect((backing.get(QQ_LEASE_KEY) as QqLease).ownerId).toBe("window-a");
      expect(postedB).toContainEqual(
        expect.objectContaining({ type: "qqStatus", connected: false }),
      );
      expect(startA).toHaveBeenCalledTimes(1);
      expect(startB).not.toHaveBeenCalled();

      // 冲突提示改为面板 toast：带 appId / 窗口、常驻、两个 action。
      expect(warningSpy).not.toHaveBeenCalled();
      const conflict = toastsB.find((t) => t.level === "warning" && t.message.includes("未启动"));
      expect(conflict).toBeDefined();
      expect(conflict!.message).toContain("fake-app-id");
      expect(conflict!.message).toContain("window-a");
      expect(conflict!.opts?.persistent).toBe(true);
      expect(conflict!.opts?.actions?.map((a) => a.actionId)).toEqual([
        QQ_LEASE_TAKEOVER_ACTION,
        QQ_LEASE_WAIT_ACTION,
      ]);
      expect(conflict!.opts?.actions?.map((a) => a.label)).toEqual([TAKEOVER_LABEL, WAIT_LABEL]);
    } finally {
      await a.stopQq();
      await b.stopQq();
    }
  });

  it("TTL 过期后新窗口可接管（残留租约被回收）", async () => {
    const backing = new Map<string, unknown>();
    const stale: QqLease = {
      ownerId: "dead-window",
      appId: "fake-app-id",
      acquiredAt: Date.now() - QQ_LEASE_TTL_MS - 100,
      renewedAt: Date.now() - QQ_LEASE_TTL_MS - 100,
    };
    backing.set(QQ_LEASE_KEY, stale);
    const fresh = makeHost(makeMemento(backing), "window-fresh");
    const calls: string[] = [];
    installFakeStart(fresh, calls);
    try {
      await fresh.startQqIfEnabled();
      expect(calls).toEqual(["window-fresh"]);
      expect(fresh.qqLeaseState).toBe("ACTIVE");
      expect((backing.get(QQ_LEASE_KEY) as QqLease).ownerId).toBe("window-fresh");
    } finally {
      await fresh.stopQq();
    }
  });

  it("PID 已死的残留租约立即回收，不必等 TTL", async () => {
    const backing = new Map<string, unknown>();
    backing.set(QQ_LEASE_KEY, {
      ownerId: "dead-window",
      appId: "fake-app-id",
      acquiredAt: Date.now(),
      renewedAt: Date.now(),
      pid: 2_147_483_647,
    } satisfies QqLease);
    const fresh = makeHost(makeMemento(backing), "window-fresh");
    const calls: string[] = [];
    installFakeStart(fresh, calls);
    try {
      await fresh.startQqIfEnabled();
      expect(calls).toEqual(["window-fresh"]);
    } finally {
      await fresh.stopQq();
    }
  });

  it("点「等待」：只关 toast，不触发 forceTake，租约仍归先启动者", async () => {
    const backing = new Map<string, unknown>();
    const a = makeHost(makeMemento(backing), "window-a");
    const b = makeHost(makeMemento(backing), "window-b");
    const callsA: string[] = [];
    const callsB: string[] = [];
    installFakeStart(a, callsA);
    installFakeStart(b, callsB);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    const takeover = vi.fn(async () => { await b.takeoverQqLease(); });

    try {
      await a.startQqIfEnabled();
      await b.startQqIfEnabled();
      expect(clickToast(QQ_LEASE_WAIT_ACTION, takeover)).toEqual([42]);
      expect(takeover).not.toHaveBeenCalled();
      expect(callsB).toEqual([]);
      expect((backing.get(QQ_LEASE_KEY) as QqLease).ownerId).toBe("window-a");
    } finally {
      await a.stopQq();
      await b.stopQq();
    }
  });

  it("点「接管」：走 forceTake，旧方仍靠心跳 stopQq 且不写 iflow.qq.enabled", async () => {
    const backing = new Map<string, unknown>();
    const memA = makeMemento(backing);
    const memB = makeMemento(backing);
    const postedA: unknown[] = [];
    const a = makeHost(memA, "window-a", postedA);
    const b = makeHost(memB, "window-b");
    const callsA: string[] = [];
    const callsB: string[] = [];
    installFakeStart(a, callsA);
    installFakeStart(b, callsB);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(TAKEOVER_LABEL as never);
    const takeover = vi.fn(async () => { await b.takeoverQqLease(); });

    try {
      await a.startQqIfEnabled();
      expect((a as unknown as HostInternals).qq).toBeDefined();
      await b.startQqIfEnabled();
      const forceTake = vi.spyOn(
        (b as unknown as { qqLease: { forceTake(): Promise<boolean> } }).qqLease,
        "forceTake",
      );
      // 真实 dispatch：点「接管」→ 关 toast → takeoverQqLease → forceTake。
      expect(clickToast(QQ_LEASE_TAKEOVER_ACTION, takeover)).toEqual([42]);
      await flushTakeover();
      expect(takeover).toHaveBeenCalledTimes(1);
      expect(forceTake).toHaveBeenCalledTimes(1);
      expect(b.qqLeaseState).toBe("ACTIVE");
      expect((backing.get(QQ_LEASE_KEY) as QqLease).ownerId).toBe("window-b");

      // 旧持有者的下一次心跳发现 owner 变化：静默停连接 + 回推状态。
      await (a as unknown as HostInternals).tickQqLease();
      expect((a as unknown as HostInternals).qq).toBeUndefined();
      expect(a.qqLeaseState).toBe("STOPPED");
      expect(postedA).toContainEqual({
        type: "qqStatus",
        connected: false,
        detail: "QQ 通道已由另一个窗口接管",
      });
      // 关键红线：只停连接，绝不写 iflow.qq.enabled=false 触发级联重启。
      expect(memA.updates.some(([key]) => key === "iflow.qq.enabled")).toBe(false);
      expect(memB.updates.some(([key]) => key === "iflow.qq.enabled")).toBe(false);
      // 旧窗口也不能删掉新持有者刚抢到的租约。
      expect((backing.get(QQ_LEASE_KEY) as QqLease).ownerId).toBe("window-b");
    } finally {
      await a.stopQq();
      await b.stopQq();
    }
  });

  it("两窗口同时启动：回读自校验保证只有一个 ACTIVE", async () => {
    const backing = new Map<string, unknown>();
    const a = makeHost(makeMemento(backing), "window-a");
    const b = makeHost(makeMemento(backing), "window-b");
    const callsA: string[] = [];
    const callsB: string[] = [];
    installFakeStart(a, callsA);
    installFakeStart(b, callsB);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    try {
      await Promise.all([a.startQqIfEnabled(), b.startQqIfEnabled()]);
      expect(callsA.length + callsB.length).toBe(1);
      expect([a.qqLeaseState, b.qqLeaseState].filter((s) => s === "ACTIVE")).toHaveLength(1);
      expect([a.qqLeaseState, b.qqLeaseState]).toContain("YIELDED");
    } finally {
      await a.stopQq();
      await b.stopQq();
    }
  });

  it("主动 stopQq 归还租约，另一个窗口随后可立即启动", async () => {
    const backing = new Map<string, unknown>();
    const a = makeHost(makeMemento(backing), "window-a");
    const b = makeHost(makeMemento(backing), "window-b");
    const callsA: string[] = [];
    const callsB: string[] = [];
    installFakeStart(a, callsA);
    installFakeStart(b, callsB);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    try {
      await a.startQqIfEnabled();
      await a.stopQq();
      expect(backing.has(QQ_LEASE_KEY)).toBe(false);
      await b.startQqIfEnabled();
      expect(callsB).toEqual(["window-b"]);
    } finally {
      await a.stopQq();
      await b.stopQq();
    }
  });
});