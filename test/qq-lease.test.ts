import { describe, expect, it, vi } from "vitest";
import {
  canRenew,
  chooseOwner,
  createQqLeaseController,
  isLeaseExpired,
  isSameBot,
  QqLeaseController,
  QQ_LEASE_TTL_MS,
  shouldTakeLease,
  type QqLease,
  type QqLeaseStore,
} from "../shared/qq-lease.js";

const NOW = 1_000_000;

function lease(overrides: Partial<QqLease> = {}): QqLease {
  return {
    ownerId: "window-a",
    appId: "app-1",
    acquiredAt: NOW,
    renewedAt: NOW,
    ...overrides,
  };
}

function makeStore(initial?: QqLease): QqLeaseStore & { map: Map<string, QqLease | undefined>; updates: number } {
  const map = new Map<string, QqLease | undefined>();
  map.set("lease", initial);
  return {
    map,
    updates: 0,
    get() {
      return map.get("lease");
    },
    async set(value) {
      this.updates += 1;
      map.set("lease", value);
    },
  };
}

describe("QQ 单活租约 · isSameBot", () => {
  it("按 appId 判定同一个机器人（trim 后严格相等）", () => {
    expect(isSameBot(" app-1 ", "app-1")).toBe(true);
    expect(isSameBot("app-1", "app-2")).toBe(false);
  });

  it("空 appId 不算同一个机器人", () => {
    expect(isSameBot("", "")).toBe(false);
    expect(isSameBot(undefined, "app-1")).toBe(false);
  });
});

describe("QQ 单活租约 · isLeaseExpired", () => {
  it("无租约视为过期；新鲜租约在 TTL 边界内仍有效", () => {
    expect(isLeaseExpired(undefined, NOW)).toBe(true);
    expect(isLeaseExpired(lease(), NOW + QQ_LEASE_TTL_MS)).toBe(false);
    expect(isLeaseExpired(lease(), NOW + QQ_LEASE_TTL_MS + 1)).toBe(true);
  });

  it("renewedAt 缺失 / 非数字视为过期", () => {
    expect(isLeaseExpired(lease({ renewedAt: Number.NaN }), NOW)).toBe(true);
  });

  it("PID 探活：进程已退出立即过期，不受 renewedAt 影响", () => {
    const probe = vi.fn((pid: number) => pid === 4242);
    expect(isLeaseExpired(lease({ pid: 4242 }), NOW + 1, probe)).toBe(false);
    expect(isLeaseExpired(lease({ pid: 9999 }), NOW + 1, probe)).toBe(true);
    expect(probe).toHaveBeenCalledWith(4242);
  });

  it("没带 pid 的旧租约退化为纯 TTL 判定", () => {
    const probe = vi.fn(() => false);
    expect(isLeaseExpired(lease(), NOW + 1, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("QQ 单活租约 · shouldTakeLease", () => {
  it("无租约 / 过期租约可抢占", () => {
    expect(shouldTakeLease(undefined, "window-b", "app-1", NOW)).toBe(true);
    expect(shouldTakeLease(lease({ renewedAt: NOW - QQ_LEASE_TTL_MS - 1 }), "window-b", "app-1", NOW)).toBe(true);
  });

  it("新鲜租约且 owner 是别人 -> 不让抢（先启动者保留）", () => {
    expect(shouldTakeLease(lease(), "window-b", "app-1", NOW + 1)).toBe(false);
  });

  it("appId 不同 -> 不是同一个机器人，放行", () => {
    expect(shouldTakeLease(lease(), "window-b", "app-2", NOW + 1)).toBe(true);
  });

  it("owner 是自己 -> 允许重入 / 宿主重启后的自恢复", () => {
    expect(shouldTakeLease(lease(), "window-a", "app-1", NOW + 1)).toBe(true);
  });

  it("PID 已死即使租约新鲜也能抢", () => {
    expect(shouldTakeLease(lease({ pid: 9999 }), "window-b", "app-1", NOW + 1, () => false)).toBe(true);
  });
});

describe("QQ 单活租约 · canRenew / chooseOwner", () => {
  it("只有新鲜租约的本人能续约", () => {
    expect(canRenew(lease(), "window-a", NOW + 1)).toBe(true);
    expect(canRenew(lease(), "window-b", NOW + 1)).toBe(false);
    expect(canRenew(lease({ renewedAt: NOW - QQ_LEASE_TTL_MS - 1 }), "window-a", NOW)).toBe(false);
    expect(canRenew(lease({ pid: 9999 }), "window-a", NOW + 1, () => false)).toBe(false);
  });

  it("chooseOwner：新鲜租约归属先启动者，过期 / 无租约归挑战者", () => {
    expect(chooseOwner(lease(), "window-b", NOW + 1)).toBe("window-a");
    expect(chooseOwner(undefined, "window-b", NOW)).toBe("window-b");
    expect(chooseOwner(lease({ renewedAt: NOW - QQ_LEASE_TTL_MS - 1 }), "window-b", NOW)).toBe("window-b");
  });
});

describe("QQ 单活租约 · controller 竞态", () => {
  const options = { now: () => NOW, pid: 4242, probe: () => true };

  it("acquire 写后回读自校验：被别人覆盖视为没拿到", async () => {
    const store = makeStore();
    const a = createQqLeaseController(store, "window-a", "app-1", options);
    const originalSet = store.set.bind(store);
    // 模拟 a 写入后、回读前被 b 覆盖（globalState 没有 CAS）。
    store.set = async (value) => {
      await originalSet(value);
      if (store.map.get("lease")?.ownerId === "window-a") {
        await originalSet(lease({ ownerId: "window-b", renewedAt: NOW }));
      }
    };
    expect(await a.acquire()).toBe(false);
    expect(a.isHeld()).toBe(false);
  });

  it("两窗口同时 acquire 只有一个成功", async () => {
    const store = makeStore();
    const a = createQqLeaseController(store, "window-a", "app-1", options);
    const b = createQqLeaseController(store, "window-b", "app-1", options);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    expect(store.map.get("lease")?.ownerId).toBe("window-a");
  });

  it("forceTake 显式接管后旧持有者 canRenew 为 false", async () => {
    const store = makeStore();
    const a = createQqLeaseController(store, "window-a", "app-1", options);
    const b = createQqLeaseController(store, "window-b", "app-1", options);
    expect(await a.acquire()).toBe(true);
    const now = { current: NOW + 1 };
    const bOpts = { now: () => now.current, pid: 4343, probe: () => true };
    const challenger = createQqLeaseController(store, "window-b", "app-1", bOpts);
    expect(await challenger.forceTake()).toBe(true);
    expect(store.map.get("lease")?.ownerId).toBe("window-b");
    expect(a.canRenew()).toBe(false);
    expect(b.isHeld()).toBe(false);
  });

  it("renew 保留 acquiredAt / owner，只刷新 renewedAt", async () => {
    const store = makeStore();
    let tick = NOW;
    const controller = createQqLeaseController(store, "window-a", "app-1", {
      now: () => tick,
      pid: 4242,
      probe: () => true,
    });
    expect(await controller.acquire()).toBe(true);
    tick += 1_000;
    expect(await controller.renew()).toBe(true);
    expect(store.map.get("lease")).toMatchObject({
      ownerId: "window-a",
      acquiredAt: NOW,
      renewedAt: NOW + 1_000,
    });
  });

  it("release 只删自己的租约，不误删接管者", async () => {
    const store = makeStore();
    const a = createQqLeaseController(store, "window-a", "app-1", options);
    const b = createQqLeaseController(store, "window-b", "app-1", options);
    expect(await a.acquire()).toBe(true);
    expect(await b.forceTake()).toBe(true);
    await a.release();
    expect(store.map.get("lease")?.ownerId).toBe("window-b");
    await b.release();
    expect(store.map.get("lease")).toBeUndefined();
  });

  it("非持有者 release 是空操作；同实例 acquire / forceTake 幂等", async () => {
    const store = makeStore();
    const controller: QqLeaseController = createQqLeaseController(store, "window-a", "app-1", options);
    await controller.release();
    expect(store.updates).toBe(0);
    expect(await controller.acquire()).toBe(true);
    expect(await controller.acquire()).toBe(false);
    expect(await controller.forceTake()).toBe(true);
    expect(store.updates).toBe(1);
  });
});
