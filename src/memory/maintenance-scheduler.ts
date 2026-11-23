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
 * 触发纪律（每次 tick 依次判定）：
 *  1. `disposed` / 连续失败已停用 / 本轮正在运行 → 直接返回；
 *  2. `enabled()` 为假 → 返回；
 *  3. `isIdle()` 为假 → 返回；
 *  4. `shouldRunCuration(state, now, intervalDays, currentTokens, budget)` 为假 → 返回；
 *  5. 拿不到跨进程锁 → 返回；
 *  6. 跑一轮整理；成功刷新 `lastRunAt` / `nextPlanAt` / `failureCount`，失败累计。
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
  /** 预算；与 `shouldRunCuration` 的 budgetTokens 同义。 */
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
export async function loadState(statePath: string): Promise<ScheduleState> {
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
    const state: ScheduleState = { failureCount };
    if (typeof record.lastRunAt === "string" && Number.isFinite(Date.parse(record.lastRunAt))) {
      state.lastRunAt = record.lastRunAt;
    }
    if (typeof record.nextPlanAt === "string" && Number.isFinite(Date.parse(record.nextPlanAt))) {
      state.nextPlanAt = record.nextPlanAt;
    }
    return state;
  } catch {
    return { failureCount: 0 };
  }
}

/** 原子写调度状态（temp + rename，见 files.ts 的 writeAtomic）。 */
export async function saveState(statePath: string, state: ScheduleState): Promise<void> {
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
  private state: ScheduleState = { failureCount: 0 };
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
   * 立即跑一轮（手动触发 / tick 内部使用）。绕过 enabled / isIdle / 到期判定，
   * 但仍然遵守「已 dispose」「已在运行」与跨进程锁；失败时返回 null。
   */
  async runNow(trigger: string): Promise<MaintenanceReport | null> {
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
      this.state = {
        lastRunAt: report.at,
        nextPlanAt: computeNextPlanAt(report.at, this.intervalDays),
        failureCount: 0,
      };
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

  getState(): ScheduleState {
    return { ...this.state };
  }

  updateConfig(config: Partial<{ intervalDays: number; idleMinutes: number }>): void {
    let restart = false;
    if (typeof config.intervalDays === "number" && Number.isFinite(config.intervalDays)) {
      this.intervalDays = Math.max(0, config.intervalDays);
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
    try {
      if (!this.canTick()) return;
      await this.ensureHydrated();
      if (!this.canTick()) return;
      const currentTokens = await this.options.measure();
      const due = shouldRunCuration(
        this.state,
        this.now(),
        this.intervalDays,
        currentTokens,
        this.options.budgetTokens,
      );
      if (!due) return;
    } catch (error) {
      await this.recordFailure(error);
      return;
    }
    await this.runNow("scheduled");
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
