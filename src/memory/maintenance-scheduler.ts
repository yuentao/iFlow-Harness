import { readIfExists, writeAtomic } from "./files.js";
import {
  computeNextPlanAt,
  shouldRunCuration,
  type ScheduleState,
} from "../../shared/memory-curate.js";
import { runMaintenance, type MaintenanceDeps, type MaintenanceReport } from "./maintenance.js";

/**
 * 记忆整理调度器。
 *
 * 触发来源有两种，任一命中即跑一轮：
 *  1. **周期**：距上次成功整理 ≥ `intervalDays`（`shouldRunCuration` 的时间分支）；
 *  2. **容量**：所有记忆文件托管区块的 token 合计超过总量预算
 *     （`shouldRunCuration` 的容量分支），**即使未到周期也触发** —— 记忆已经开始
 *     挤占上下文，不该再等。
 *
 * 容量触发带冷却防抖：一轮因「超预算」触发后写入 `lastCapacityRunAt`，冷却期取
 * `max(6 小时, intervalDays / 4)`。冷却期内即使仍然超预算也不再因容量触发（周期分支
 * 照常生效），避免无法再压缩的记忆让每个 tick 都重跑。旧状态文件没有
 * `lastCapacityRunAt` 时视为无冷却（向后兼容）。
 *
 * 触发纪律（每次 tick 依次判定）：
 *  1. `disposed` / 连续失败已停用 / 本轮正在运行 → 直接返回；
 *  2. `enabled()` 为假 → 返回；
 *  3. `isIdle()` 为假 → 返回；
 *  4. 周期未到、且（未超预算 或 处于容量冷却期）→ 返回；
 *  5. 拿不到跨进程锁 → 返回；
 *  6. 跑一轮整理；成功刷新 `lastRunAt` / `nextPlanAt` / `failureCount`，失败累计。
 *     `runNow("manual")` 绕过第 2–4 步的所有门槛。
 *
 * 定时器纪律：
 *  - `setInterval` 的句柄必须 `unref()`（存在时），否则会吊住扩展宿主进程；
 *  - `start()` 幂等，重复调用不会叠加定时器；
 *  - `dispose()` 清掉定时器并让后续 tick 直接返回；测试注入 `setTimer` / `clearTimer`
 *    用假时钟驱动，不依赖真实等待。
 *
 * 失败退避：连续 `MAX_CONSECUTIVE_FAILURES` 次失败后自动停用（并持久化 failureCount，
 * 重启后仍然停用）；之后 tick 不再触发，直到外部重置状态文件或重新部署。
 */

/** 连续失败多少次后自动停用。 */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** idleMinutes 为 0 / 非法时的兜底 tick 周期（分钟）。 */
export const DEFAULT_TICK_MINUTES = 1;
/** 总量预算的默认值（所有记忆文件托管区块合计 token）。与 package.json 一致。 */
export const DEFAULT_TOTAL_TOKEN_BUDGET = 12_000;
/** 容量触发的冷却下限：即便 intervalDays 很短，两次容量触发也至少隔这么久。 */
export const MIN_CAPACITY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * 容量触发的冷却时长：`max(6 小时, intervalDays / 4)`。
 * intervalDays 非法 / 为负按 0 处理（只剩 6 小时下限）。
 */
export function capacityCooldownMs(intervalDays: number): number {
  const quarter = (Number.isFinite(intervalDays) ? Math.max(0, intervalDays) : 0) * 24 * 60 * 60 * 1000 / 4;
  return Math.max(MIN_CAPACITY_COOLDOWN_MS, quarter);
}

/**
 * 调度状态 = 共享 `ScheduleState` + 本调度器私有的冷却簿记。
 * `lastCapacityRunAt` 刻意不放进 `shared/memory-curate.ts`：那里是纯判定逻辑，
 * 冷却属于调度器职责；缺该字段的旧状态文件仍然可读（视为无冷却）。
 */
export interface SchedulerState extends ScheduleState {
  /** 上次因「超预算」触发整理的时间（ISO 字符串），用于容量冷却。 */
  lastCapacityRunAt?: string;
}

export interface MaintenanceSchedulerOptions {
  deps: MaintenanceDeps;
  /** 正常整理周期（天）。 */
  intervalDays: number;
  /** 空闲判定粒度（分钟），同时作为定时器 tick 周期。 */
  idleMinutes: number;
  /** `iflow.memoryMaintenance.enabled` 的运行时读值。 */
  enabled(): boolean;
  /** 宿主侧的空闲判定（例如「距上次用户操作 ≥ idleMinutes」）。 */
  isIdle(): boolean;
  /** 调度状态文件路径（JSON）。 */
  statePath: string;
  /** 当前记忆 token 总量，用于「超预算立即整理」判定。 */
  measure(): Promise<number>;
  /**
   * 总量预算：所有记忆文件托管区块的 token 合计阈值。超过它即视为「该整理了」，
   * 即使未到 intervalDays 也触发（带冷却，见 capacityCooldownMs）。不传则只按周期触发。
   */
  totalTokenBudget?: number;
  /** @deprecated 旧名，等价于 `totalTokenBudget`；仅为向后兼容保留。 */
  budgetTokens?: number;
  now?(): Date;
  setTimer?: typeof setInterval;
  clearTimer?: typeof clearInterval;
  /** 跨进程单实例锁：拿不到（返回 false）就跳过本次。 */
  acquireLock?(): Promise<boolean>;
  releaseLock?(): Promise<void>;
}

function unrefTimer(handle: ReturnType<typeof setInterval>): void {
  const candidate = handle as unknown as { unref?: () => void };
  if (typeof candidate.unref === "function") candidate.unref();
}

/**
 * 读调度状态。文件缺失 / 损坏 / 字段非法一律降级为 `{ failureCount: 0 }`
 * （调度状态是建议性的，读不出来就当从没跑过）。时间字段非法则丢弃该字段。
 */
export async function loadState(statePath: string): Promise<SchedulerState> {
  try {
    const raw = await readIfExists(statePath);
    if (raw === null || raw.trim().length === 0) return { failureCount: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { failureCount: 0 };
    }
    const record = parsed as Record<string, unknown>;
    const rawFailure = record.failureCount;
    const failureCount =
      typeof rawFailure === "number" && Number.isFinite(rawFailure) && rawFailure >= 0
        ? Math.floor(rawFailure)
        : 0;
    const state: SchedulerState = { failureCount };
    if (typeof record.lastRunAt === "string" && Number.isFinite(Date.parse(record.lastRunAt))) {
      state.lastRunAt = record.lastRunAt;
    }
    if (typeof record.nextPlanAt === "string" && Number.isFinite(Date.parse(record.nextPlanAt))) {
      state.nextPlanAt = record.nextPlanAt;
    }
    // 旧状态文件没有 lastCapacityRunAt：解析不到就当作「无冷却」（向后兼容）。
    if (
      typeof record.lastCapacityRunAt === "string"
      && Number.isFinite(Date.parse(record.lastCapacityRunAt))
    ) {
      state.lastCapacityRunAt = record.lastCapacityRunAt;
    }
    return state;
  } catch {
    return { failureCount: 0 };
  }
}

/** 原子写调度状态（temp + rename，见 files.ts 的 writeAtomic）。 */
export async function saveState(statePath: string, state: SchedulerState): Promise<void> {
  await writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export class MaintenanceScheduler {
  private readonly options: MaintenanceSchedulerOptions;
  private readonly now: () => Date;
  private readonly setTimer: typeof setInterval;
  private readonly clearTimer: typeof clearInterval;
  private intervalDays: number;
  private idleMinutes: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private disposed = false;
  private failureStopped = false;
  private state: SchedulerState = { failureCount: 0 };
  private hydration: Promise<void> | null = null;

  constructor(options: MaintenanceSchedulerOptions) {
    this.options = options;
    this.intervalDays = options.intervalDays;
    this.idleMinutes = options.idleMinutes;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? setInterval;
    this.clearTimer = options.clearTimer ?? clearInterval;
  }

  start(): void {
    if (this.disposed || this.timer !== null) return;
    void this.ensureHydrated();
    const handle = this.setTimer(() => this.tick(), this.tickPeriodMs());
    unrefTimer(handle);
    this.timer = handle;
  }

  stop(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /**
   * 立即跑一轮（手动触发 / 命令面板）。绕过 enabled / isIdle / 到期 / 容量冷却，
   * 但仍然遵守「已 dispose」「已在运行」与跨进程锁；失败时返回 null。
   */
  async runNow(trigger: string): Promise<MaintenanceReport | null> {
    return this.runNowInternal(trigger, false);
  }

  /**
   * `capacity` 为真表示这一轮是「超总量预算」触发的：成功后写 `lastCapacityRunAt`
   * 开启冷却。非容量触发（周期 / 手动）保留既有的 `lastCapacityRunAt`，冷却不因
   * 一次无关运行而意外延长。
   */
  private async runNowInternal(trigger: string, capacity: boolean): Promise<MaintenanceReport | null> {
    if (this.disposed) return null;
    if (this.running) return null;
    this.running = true;
    let locked = false;
    try {
      await this.ensureHydrated();
      if (this.disposed) return null;
      if (this.options.acquireLock) {
        locked = await this.options.acquireLock();
        if (!locked) return null;
      }
      const report = await runMaintenance(this.options.deps, trigger);
      const next: SchedulerState = {
        lastRunAt: report.at,
        nextPlanAt: computeNextPlanAt(report.at, this.intervalDays),
        failureCount: 0,
      };
      const lastCapacityRunAt = capacity ? report.at : this.state.lastCapacityRunAt;
      if (lastCapacityRunAt) next.lastCapacityRunAt = lastCapacityRunAt;
      this.state = next;
      this.failureStopped = false;
      await this.persist();
      return report;
    } catch (error) {
      await this.recordFailure(error);
      return null;
    } finally {
      if (locked && this.options.releaseLock) {
        try {
          await this.options.releaseLock();
        } catch (error) {
          this.log("warn", "记忆整理锁释放失败", error);
        }
      }
      this.running = false;
    }
  }

  getState(): SchedulerState {
    return { ...this.state };
  }

  updateConfig(
    config: Partial<{ intervalDays: number; idleMinutes: number; totalTokenBudget: number }>,
  ): void {
    let restart = false;
    if (typeof config.intervalDays === "number" && Number.isFinite(config.intervalDays)) {
      this.intervalDays = Math.max(0, config.intervalDays);
    }
    if (typeof config.totalTokenBudget === "number" && Number.isFinite(config.totalTokenBudget)) {
      this.options.totalTokenBudget = config.totalTokenBudget;
    }
    if (typeof config.idleMinutes === "number" && Number.isFinite(config.idleMinutes)) {
      const next = Math.max(0, config.idleMinutes);
      if (next !== this.idleMinutes) {
        this.idleMinutes = next;
        restart = true;
      }
    }
    if (restart && this.timer !== null) {
      this.stop();
      this.start();
    }
  }

  /** 定时器周期：idleMinutes 分钟；0 / 非法时退回 DEFAULT_TICK_MINUTES。 */
  private tickPeriodMs(): number {
    const minutes = this.idleMinutes > 0 ? this.idleMinutes : DEFAULT_TICK_MINUTES;
    return Math.max(1, minutes) * 60_000;
  }

  private async tick(): Promise<void> {
    let capacityHit = false;
    try {
      if (!this.canTick()) return;
      await this.ensureHydrated();
      if (!this.canTick()) return;

      // 周期分支：与容量冷却无关（传 currentTokens=0 / budget=undefined 只走时间判定）。
      const intervalDue = shouldRunCuration(this.state, this.now(), this.intervalDays, 0, undefined);

      // 容量分支：只有配了总量预算才计量（measure 要走目录扫描，不能白跑）。
      if (!intervalDue) {
        const budget = this.totalTokenBudget();
        if (budget !== undefined) {
          const currentTokens = await this.options.measure();
          if (currentTokens > budget && !this.inCapacityCooldown()) capacityHit = true;
        }
      }

      if (!intervalDue && !capacityHit) return;
    } catch (error) {
      await this.recordFailure(error);
      return;
    }
    await this.runNowInternal("scheduled", capacityHit);
  }

  /** 总量预算：优先 `totalTokenBudget`，退回旧名 `budgetTokens`；非法视为未配置。 */
  private totalTokenBudget(): number | undefined {
    const raw = this.options.totalTokenBudget ?? this.options.budgetTokens;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  }

  /** 当前是否处于容量触发冷却期（旧状态缺 lastCapacityRunAt 视为无冷却）。 */
  private inCapacityCooldown(): boolean {
    const last = this.state.lastCapacityRunAt;
    if (!last) return false;
    const lastMs = Date.parse(last);
    if (!Number.isFinite(lastMs)) return false;
    const nowMs = this.now().getTime();
    if (!Number.isFinite(nowMs)) return false;
    return nowMs - lastMs < capacityCooldownMs(this.intervalDays);
  }

  private canTick(): boolean {
    if (this.disposed || this.failureStopped || this.running) return false;
    return this.options.enabled() && this.options.isIdle();
  }

  private ensureHydrated(): Promise<void> {
    if (!this.hydration) {
      this.hydration = (async () => {
        this.state = await loadState(this.options.statePath);
        if (this.state.failureCount >= MAX_CONSECUTIVE_FAILURES) this.failureStopped = true;
      })().catch((error: unknown) => {
        this.log("warn", "记忆整理调度状态读取失败", error);
      });
    }
    return this.hydration;
  }

  private async recordFailure(error: unknown): Promise<void> {
    const failureCount = this.state.failureCount + 1;
    this.state = { ...this.state, failureCount };
    if (failureCount >= MAX_CONSECUTIVE_FAILURES) this.failureStopped = true;
    this.log("warn", `记忆整理失败（连续 ${failureCount}/${MAX_CONSECUTIVE_FAILURES} 次）`, error);
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await saveState(this.options.statePath, this.state);
    } catch (error) {
      this.log("warn", "记忆整理调度状态写入失败", error);
    }
  }

  private log(level: "info" | "warn" | "error", message: string, detail?: unknown): void {
    this.options.deps.log?.(level, message, detail);
  }
}
