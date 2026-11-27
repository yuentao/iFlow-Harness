/**
 * QQ 机器人跨窗口单活租约（纯逻辑，零 VSCode 依赖）。
 *
 * 背景：同一台机器上可能开着多个 VSCode 窗口，每个窗口都有独立的扩展宿主
 * 与 `ChatPanel`。若每个窗口都按 `iflow.qq.enabled=true` 启动 QQBot，官方
 * 网关会对同一个 appId 建立多条连接，互相顶掉 session、重复处理消息。
 *
 * 本模块只描述「租约怎么判、谁能拿、怎么续、怎么放」；真正的载体是宿主的
 * `globalState`（跨窗口共享的 Memento），由 `src/qq/lease-host.ts` 适配。
 * 之所以不直接复用 `createMemoryMaintenanceLock`：那边锁的是「定时整理」
 * 这种低频独占，TTL 30 分钟；QQ 通道有心跳与主动接管，TTL 15s + PID 探活
 * 才能既挡住僵死窗口，又让「接管」在秒级生效。
 *
 * 并发纪律（与 memory lock 一致）：globalState 没有 CAS，写入后必须**回读**
 * 自校验 owner 仍是自己，否则视为没拿到；release 也只能删自己的租约，
 * 绝不删别人刚抢到的那份。
 */

/** globalState 里租约的键。 */
export const QQ_LEASE_KEY = "iflow.qq.activeLease";

/** 租约有效期：超过这个时间没续约就算过期。 */
export const QQ_LEASE_TTL_MS = 15_000;

/** 心跳周期：远小于 TTL，给跨窗口可见性留出余量。 */
export const QQ_LEASE_HEARTBEAT_MS = 5_000;

/** 租约数据结构。`pid` 为可选项：老租约 / 测试夹具可能没有。 */
export interface QqLease {
  /** 持有者的窗口会话 id（宿主取 `vscode.env.sessionId`）。 */
  ownerId: string;
  /** 机器人身份：源码没有 accountId，按 appId 判定「是不是同一个机器人」。 */
  appId: string;
  acquiredAt: number;
  renewedAt: number;
  /** 持有者扩展宿主进程 id；用于「进程已退出即租约失效」的快速回收。 */
  pid?: number;
}

/** 最小存储接口：宿主把 `vscode.Memento` 适配成它即可。 */
export interface QqLeaseStore {
  get(): QqLease | undefined;
  set(lease: QqLease | undefined): Promise<void>;
}

/** PID 探活函数：只发 signal 0，不真正杀进程。 */
export type QqPidProbe = (pid: number) => boolean;

/** Node 默认探活：任何异常（含 ESRCH / EPERM）都按「进程已退出」处理。 */
export function defaultQqPidProbe(pid: number): boolean {
  const proc = (globalThis as {
    process?: { kill(pid: number, signal: 0): void };
  }).process;
  if (!proc) return true; // 没有 process（例如 webview）时不做 PID 判定
  try {
    proc.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** appId trim 后严格相等；空 appId 永不与任何东西算作同一个机器人。 */
export function isSameBot(
  a: string | undefined,
  b: string | undefined,
): boolean {
  const left = typeof a === "string" ? a.trim() : "";
  const right = typeof b === "string" ? b.trim() : "";
  return left.length > 0 && left === right;
}

/**
 * 租约是否失效：TTL 超时，或持有者进程已退出。
 *
 * `now - renewedAt > TTL`（严格大于）：边界帧仍算有效，避免心跳抖动导致
 * 两个窗口同时认为自己该抢。没有 PID 的租约退化为纯 TTL 判定。
 */
export function isLeaseExpired(
  lease: QqLease | undefined,
  now: number,
  probe: QqPidProbe = defaultQqPidProbe,
): boolean {
  if (!lease) return true;
  if (typeof lease.renewedAt !== "number" || !Number.isFinite(lease.renewedAt)) return true;
  if (now - lease.renewedAt > QQ_LEASE_TTL_MS) return true;
  if (typeof lease.pid === "number" && Number.isFinite(lease.pid)) {
    if (!probe(lease.pid)) return true;
  }
  return false;
}

/**
 * 新窗口能否安全地抢占当前租约。
 *
 * 三条放行路径：无租约 / 过期（含 PID 已死）/ appId 不同（不是同一个机器人）
 * / owner 本就是自己（同一窗口重入或扩展宿主重启后的自恢复）。
 */
export function shouldTakeLease(
  current: QqLease | undefined,
  ownerId: string,
  appId: string,
  now: number,
  probe: QqPidProbe = defaultQqPidProbe,
): boolean {
  if (!current) return true;
  if (current.ownerId === ownerId) return true;
  if (!isSameBot(current.appId, appId)) return true;
  return isLeaseExpired(current, now, probe);
}

/** 租约是否还能由给定 owner 续约（心跳每 5s 调一次）。 */
export function canRenew(
  current: QqLease | undefined,
  ownerId: string,
  now: number,
  probe: QqPidProbe = defaultQqPidProbe,
): boolean {
  if (!current || current.ownerId !== ownerId) return false;
  return !isLeaseExpired(current, now, probe);
}

/**
 * 竞争裁决：决定「最终谁持有租约」。
 *
 * 租约新鲜且持有者还活着 -> 先启动者保留；过期 / 无租约 -> 挑战者上位。
 * 注意这里不比较 appId —— 「不是同一个机器人」的放行由
 * {@link shouldTakeLease} 负责，`chooseOwner` 只回答「同一个机器人的归属」。
 */
export function chooseOwner(
  current: QqLease | undefined,
  challengerId: string,
  now: number,
  probe: QqPidProbe = defaultQqPidProbe,
): string {
  if (!current || isLeaseExpired(current, now, probe)) return challengerId;
  return current.ownerId;
}

export interface QqLeaseControllerOptions {
  now?: () => number;
  probe?: QqPidProbe;
  pid?: number;
}

/**
 * 租约控制器：把「判断」和「写后回读自校验」绑在一起。
 *
 * `held` 只防同实例重入；跨实例的竞态靠 globalState 回读：两个窗口同时
 * 写入时，后写者回读到的 owner 是自己、先写者回读到的 owner 是对方，
 * 因此只有一个拿到租约。`forceTake()` 是用户点「接管」时的显式抢占，
 * 跳过 `shouldTakeLease` 但仍做回读自校验。
 */
export function createQqLeaseController(
  store: QqLeaseStore,
  ownerId: string,
  appId: string,
  options: QqLeaseControllerOptions = {},
) {
  const now = options.now ?? Date.now;
  const probe = options.probe ?? defaultQqPidProbe;
  let held = false;

  const makeLease = (at: number): QqLease => ({
    ownerId,
    appId,
    acquiredAt: at,
    renewedAt: at,
    ...(typeof options.pid === "number" ? { pid: options.pid } : {}),
  });

  /** 写入并回读：只有回读到**别的 owner**才算竞态失败。 */
  const writeSelf = async (lease: QqLease): Promise<boolean> => {
    await store.set(lease);
    const check = store.get();
    // globalState 有跨窗口可见性延迟；测试用的 Memento stub 更可能根本不
    // 持久化。回读为空时不能判定失败（那会让「不可观测」变成永久让出），
    // 信任本次写入；真正被别人覆盖时回读到的 owner 一定不是自己。
    if (check && check.ownerId !== ownerId) return false;
    held = true;
    return true;
  };

  return {
    ownerId,
    appId,
    isHeld(): boolean {
      return held;
    },
    current(): QqLease | undefined {
      return store.get();
    },
    async acquire(): Promise<boolean> {
      if (held) return false;
      const at = now();
      if (!shouldTakeLease(store.get(), ownerId, appId, at, probe)) return false;
      return writeSelf(makeLease(at));
    },
    /** 用户显式接管：无视新鲜租约直接抢占，仍受回读自校验保护。 */
    async forceTake(): Promise<boolean> {
      if (held) return true;
      return writeSelf(makeLease(now()));
    },
    canRenew(): boolean {
      if (!held) return false;
      const current = store.get();
      // 回读不到租约（stub 不持久化 / 可见性延迟）时不下线，由 renew 重建。
      if (!current) return true;
      return canRenew(current, ownerId, now(), probe);
    },
    /** 心跳续约：只刷新 renewedAt，不换 owner / acquiredAt。 */
    async renew(): Promise<boolean> {
      if (!held) return false;
      const current = store.get();
      if (current && !canRenew(current, ownerId, now(), probe)) {
        held = false;
        return false;
      }
      const next = current ? { ...current, renewedAt: now() } : makeLease(now());
      return writeSelf(next);
    },
    /** 释放：非持有者空操作；即便已持有，也只删 owner 仍是自己的租约。 */
    async release(): Promise<void> {
      if (!held) return;
      held = false;
      const check = store.get();
      if (check && check.ownerId === ownerId) await store.set(undefined);
    },
  };
}

export type QqLeaseController = ReturnType<typeof createQqLeaseController>;
