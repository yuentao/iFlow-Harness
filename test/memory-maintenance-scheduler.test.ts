import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_CONSECUTIVE_FAILURES,
  MaintenanceScheduler,
  loadState,
  saveState,
  type MaintenanceSchedulerOptions,
} from "../src/memory/maintenance-scheduler.js";
import type { MaintenanceDeps } from "../src/memory/maintenance.js";

const dirs: string[] = [];

function tempHome(prefix = "iflow-mem-sched-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const CLOCK = "2026-11-24T00:00:00.000Z";
const CONTENT = [
  "# 记忆",
  "",
  "## iFlow Added Memories",
  "",
  "- 使用 pnpm",
  "- 使用 pnpm。",
  "",
].join("\n");

interface FakeDepsOptions {
  fail?: boolean;
  onList?: () => void;
}

function makeDeps(home: string, options: FakeDepsOptions = {}): MaintenanceDeps {
  const file = path.join(home, "AGENTS.md");
  return {
    listFiles: async () => {
      options.onList?.();
      if (options.fail) throw new Error("listFiles boom");
      return [{ path: file, scope: "global", kind: "primary" }];
    },
    readFile: async () => ({ content: CONTENT, hash: "hash" }),
    writeFile: async () => {},
    home,
    now: () => new Date(CLOCK),
  };
}

interface Harness {
  scheduler: MaintenanceScheduler;
  fire(): Promise<boolean>;
  period(): number;
  unrefed(): boolean;
  created(): number;
  cleared(): number;
}

function makeHarness(
  overrides: Partial<MaintenanceSchedulerOptions> & { deps: MaintenanceDeps },
): Harness {
  let callback: (() => void | Promise<void>) | null = null;
  let period = 0;
  let unrefed = false;
  let created = 0;
  let cleared = 0;

  const setTimer = ((fn: () => void | Promise<void>, ms?: number) => {
    callback = fn;
    period = ms ?? 0;
    created++;
    return { unref: () => { unrefed = true; } } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  const clearTimer = (() => {
    callback = null;
    cleared++;
  }) as unknown as typeof clearInterval;

  const base: MaintenanceSchedulerOptions = {
    deps: overrides.deps,
    intervalDays: 7,
    idleMinutes: 15,
    enabled: () => true,
    isIdle: () => true,
    statePath: path.join(overrides.deps.home, "memory-maintenance", "schedule.json"),
    measure: async () => 0,
    now: () => new Date(CLOCK),
    setTimer,
    clearTimer,
  };

  return {
    scheduler: new MaintenanceScheduler({ ...base, ...overrides }),
    async fire() {
      if (!callback) return false;
      await callback();
      return true;
    },
    period: () => period,
    unrefed: () => unrefed,
    created: () => created,
    cleared: () => cleared,
  };
}

describe("MaintenanceScheduler: 触发门槛", () => {
  it("未启用时不运行", async () => {
    const home = tempHome();
    let lists = 0;
    const harness = makeHarness({
      deps: makeDeps(home, { onList: () => lists++ }),
      enabled: () => false,
    });
    harness.scheduler.start();

    expect(await harness.fire()).toBe(true);
    expect(lists).toBe(0);
    expect(harness.scheduler.getState().lastRunAt).toBeUndefined();
    harness.scheduler.dispose();
  });

  it("不空闲时不运行", async () => {
    const home = tempHome();
    let lists = 0;
    const harness = makeHarness({
      deps: makeDeps(home, { onList: () => lists++ }),
      isIdle: () => false,
    });
    harness.scheduler.start();

    await harness.fire();
    expect(lists).toBe(0);
    harness.scheduler.dispose();
  });

  it("未到期时不运行", async () => {
    const home = tempHome();
    const statePath = path.join(home, "memory-maintenance", "schedule.json");
    await saveState(statePath, {
      lastRunAt: CLOCK,
      nextPlanAt: "2026-12-01T00:00:00.000Z",
      failureCount: 0,
    });
    let lists = 0;
    const harness = makeHarness({
      deps: makeDeps(home, { onList: () => lists++ }),
      statePath,
    });
    harness.scheduler.start();

    await harness.fire();
    expect(lists).toBe(0);
    harness.scheduler.dispose();
  });

  it("到期 + 空闲 + 启用时运行并刷新状态", async () => {
    const home = tempHome();
    let lists = 0;
    const harness = makeHarness({ deps: makeDeps(home, { onList: () => lists++ }) });
    harness.scheduler.start();

    await harness.fire();

    expect(lists).toBe(1);
    const state = harness.scheduler.getState();
    expect(state.lastRunAt).toBe(CLOCK);
    expect(state.nextPlanAt).toBe("2026-12-01T00:00:00.000Z");
    expect(state.failureCount).toBe(0);
    harness.scheduler.dispose();
  });

  it("start 幂等，定时器 unref，周期按 idleMinutes", () => {
    const home = tempHome();
    const harness = makeHarness({ deps: makeDeps(home), idleMinutes: 15 });
    harness.scheduler.start();
    harness.scheduler.start();

    expect(harness.created()).toBe(1);
    expect(harness.unrefed()).toBe(true);
    expect(harness.period()).toBe(15 * 60_000);
    harness.scheduler.dispose();
  });
});

describe("MaintenanceScheduler: 并发与锁", () => {
  it("运行中再次 tick 不重入", async () => {
    const home = tempHome();
    let lists = 0;
    let release: (() => void) | null = null;
    let entered: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const deps = makeDeps(home);
    deps.listFiles = async () => {
      lists++;
      entered?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    };
    const harness = makeHarness({ deps });

    const first = harness.scheduler.runNow("manual");
    const second = await harness.scheduler.runNow("manual");
    expect(second).toBeNull();

    await started;
    expect(lists).toBe(1);
    release!();
    const report = await first;
    expect(report).not.toBeNull();
    expect(lists).toBe(1);
  });

  it("拿不到锁时跳过本次且不改状态", async () => {
    const home = tempHome();
    let lists = 0;
    let released = 0;
    const harness = makeHarness({
      deps: makeDeps(home, { onList: () => lists++ }),
      acquireLock: async () => false,
      releaseLock: async () => {
        released++;
      },
    });
    harness.scheduler.start();

    await harness.fire();

    expect(lists).toBe(0);
    expect(released).toBe(0);
    expect(harness.scheduler.getState().lastRunAt).toBeUndefined();
    harness.scheduler.dispose();
  });
});

describe("MaintenanceScheduler: 失败退避", () => {
  it("连续 3 次失败后停用，后续 tick 不再触发", async () => {
    const home = tempHome();
    let lists = 0;
    const harness = makeHarness({
      deps: makeDeps(home, { fail: true, onList: () => lists++ }),
    });
    harness.scheduler.start();

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await harness.fire();
    }
    expect(lists).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(harness.scheduler.getState().failureCount).toBe(MAX_CONSECUTIVE_FAILURES);

    await harness.fire();
    expect(lists).toBe(MAX_CONSECUTIVE_FAILURES);
    harness.scheduler.dispose();
  });
});

describe("MaintenanceScheduler: dispose", () => {
  it("dispose 清掉定时器，后续 tick 不再回调", async () => {
    const home = tempHome();
    let lists = 0;
    const harness = makeHarness({ deps: makeDeps(home, { onList: () => lists++ }) });
    harness.scheduler.start();

    harness.scheduler.dispose();
    expect(harness.cleared()).toBe(1);
    expect(await harness.fire()).toBe(false);

    harness.scheduler.start();
    expect(harness.created()).toBe(1);
    expect(await harness.fire()).toBe(false);
    expect(lists).toBe(0);
  });
});

describe("MaintenanceScheduler: 状态持久化", () => {
  it("成功运行后写盘，可用 loadState 读回", async () => {
    const home = tempHome();
    const statePath = path.join(home, "memory-maintenance", "schedule.json");
    const harness = makeHarness({ deps: makeDeps(home), statePath });
    harness.scheduler.start();

    await harness.fire();

    const persisted = await loadState(statePath);
    expect(persisted.lastRunAt).toBe(CLOCK);
    expect(persisted.nextPlanAt).toBe("2026-12-01T00:00:00.000Z");
    expect(persisted.failureCount).toBe(0);
    harness.scheduler.dispose();
  });

  it("缺失或损坏的状态文件降级为 failureCount 0", async () => {
    const home = tempHome();
    const statePath = path.join(home, "schedule.json");
    expect(await loadState(statePath)).toEqual({ failureCount: 0 });

    writeFileSync(statePath, "{ not json", "utf8");
    expect(await loadState(statePath)).toEqual({ failureCount: 0 });

    writeFileSync(statePath, JSON.stringify({ lastRunAt: "nope", failureCount: -3 }), "utf8");
    expect(await loadState(statePath)).toEqual({ failureCount: 0 });
  });

  it("持久化的连续失败次数在重启后仍然停用", async () => {
    const home = tempHome();
    const statePath = path.join(home, "memory-maintenance", "schedule.json");
    await saveState(statePath, { failureCount: MAX_CONSECUTIVE_FAILURES });
    let lists = 0;
    const harness = makeHarness({
      deps: makeDeps(home, { onList: () => lists++ }),
      statePath,
    });
    harness.scheduler.start();

    await harness.fire();
    expect(lists).toBe(0);
    harness.scheduler.dispose();
  });
});

/**
 * 容量触发（总量预算）：超预算时即使未到周期也跑，但带冷却
 * （max(6 小时, intervalDays/4)），冷却期内不再因容量触发。
 *
 * intervalDays=7 → 冷却 = 7d/4 = 42 小时；所有用例的时钟都停在周期内
 * （远小于 7 天），以隔离「容量」这一条触发来源。
 */
describe("MaintenanceScheduler: 总量预算容量触发", () => {
  const baseState = (extra: Record<string, unknown> = {}) => ({
    lastRunAt: CLOCK,
    nextPlanAt: "2026-12-01T00:00:00.000Z",
    failureCount: 0,
    ...extra,
  });

  async function setup(measureTotal: number, extraState: Record<string, unknown> = {}) {
    const home = tempHome();
    const statePath = path.join(home, "memory-maintenance", "schedule.json");
    await saveState(statePath, baseState(extraState) as Parameters<typeof saveState>[1]);
    let lists = 0;
    const clock = { at: new Date(CLOCK) };
    const harness = makeHarness({
      deps: makeDeps(home, { onList: () => lists++ }),
      statePath,
      intervalDays: 7,
      totalTokenBudget: 1_000,
      measure: async () => measureTotal,
      now: () => clock.at,
    });
    harness.scheduler.start();
    return { harness, lists: () => lists, clock };
  }

  it("超总量预算且未到周期时触发", async () => {
    const { harness, lists } = await setup(5_000);
    await harness.fire();

    expect(lists()).toBe(1);
    expect(harness.scheduler.getState().lastCapacityRunAt).toBe(CLOCK);
    harness.scheduler.dispose();
  });

  it("未超预算且未到周期时不触发", async () => {
    const { harness, lists } = await setup(500);
    await harness.fire();

    expect(lists()).toBe(0);
    expect(harness.scheduler.getState().lastCapacityRunAt).toBeUndefined();
    harness.scheduler.dispose();
  });

  it("冷却期内即使仍超预算也不触发", async () => {
    const { harness, lists, clock } = await setup(5_000);
    await harness.fire();
    expect(lists()).toBe(1);

    // 冷却 = 42 小时；推进 1 小时仍在其内。
    clock.at = new Date(Date.parse(CLOCK) + 60 * 60_000);
    await harness.fire();
    expect(lists()).toBe(1);
    harness.scheduler.dispose();
  });

  it("冷却期外再次超预算时再次触发", async () => {
    const { harness, lists, clock } = await setup(5_000);
    await harness.fire();
    expect(lists()).toBe(1);

    // 42 小时冷却之后（仍远小于 7 天周期）。
    clock.at = new Date(Date.parse(CLOCK) + 43 * 60 * 60_000);
    await harness.fire();
    expect(lists()).toBe(2);
    harness.scheduler.dispose();
  });

  it("旧状态缺 lastCapacityRunAt 时视为无冷却，超预算即触发", async () => {
    // extraState 不写 lastCapacityRunAt，模拟旧版本落盘的状态文件。
    const { harness, lists } = await setup(5_000);
    await harness.fire();

    expect(lists()).toBe(1);
    harness.scheduler.dispose();
  });
});
