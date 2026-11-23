import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMemoryMaintenanceDeps,
  createMemoryMaintenanceLock,
  isMemoryMaintenanceIdle,
  MEMORY_MAINTENANCE_LOCK_KEY,
  MEMORY_MAINTENANCE_LOCK_TTL_MS,
  type MemoryMaintenanceLock,
} from "../src/panel/panel.js";
import { MaintenanceScheduler } from "../src/memory/maintenance-scheduler.js";
import type { MaintenanceDeps } from "../src/memory/maintenance.js";
import { sha256 } from "../src/memory/files.js";
import { estimateMarkdownTokens } from "../shared/memory-curate.js";

/**
 * 记忆整理接入层（P1）的接缝测试。
 *
 * 只驱动 panel.ts 导出的三个适配器（deps / 空闲判定 / 跨窗口锁）与
 * `MaintenanceScheduler`，用假 deps + 假时钟；文件系统只用系统临时目录，
 * 绝不读写真实的 `~/.iflow`。
 */

const dirs: string[] = [];

function tempDir(prefix = "iflow-mem-maint-"): string {
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
  "- 使用 pnpm",
  "",
].join("\n");

interface FakeDeps {
  deps: MaintenanceDeps;
  lists: () => number;
  writes: () => number;
}

function makeFakeDeps(home: string, opts: { dryRun?: boolean } = {}): FakeDeps {
  let lists = 0;
  let writes = 0;
  const file = path.join(home, "AGENTS.md");
  const deps: MaintenanceDeps = {
    listFiles: async () => {
      lists++;
      return [{ path: file, scope: "global", kind: "primary" }];
    },
    readFile: async () => ({ content: CONTENT, hash: sha256(CONTENT) }),
    writeFile: async () => {
      if (!opts.dryRun) writes++;
    },
    home,
    now: () => new Date(CLOCK),
  };
  return { deps, lists: () => lists, writes: () => writes };
}

/** 假定时器：fire() 手动驱动 tick，不真实等待。 */
function makeHarness(
  deps: MaintenanceDeps,
  overrides: Partial<ConstructorParameters<typeof MaintenanceScheduler>[0]> = {},
) {
  let callback: (() => void | Promise<void>) | null = null;
  const setTimer = ((fn: () => void | Promise<void>) => {
    callback = fn;
    return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  const clearTimer = (() => {
    callback = null;
  }) as unknown as typeof clearInterval;
  const scheduler = new MaintenanceScheduler({
    deps,
    intervalDays: 7,
    idleMinutes: 15,
    enabled: () => true,
    isIdle: () => true,
    statePath: path.join(deps.home, "state.json"),
    measure: async () => 0,
    now: () => new Date(CLOCK),
    setTimer,
    clearTimer,
    ...overrides,
  });
  return {
    scheduler,
    async fire() {
      if (!callback) return false;
      await callback();
      return true;
    },
  };
}

describe("记忆整理：调度器接入（假 deps / 假时钟）", () => {
  it("enabled 为 false 时 tick 不跑整理", async () => {
    const home = tempDir();
    const fake = makeFakeDeps(home);
    const harness = makeHarness(fake.deps, { enabled: () => false });
    harness.scheduler.start();

    expect(await harness.fire()).toBe(true);
    expect(fake.lists()).toBe(0);
    expect(fake.writes()).toBe(0);
    expect(harness.scheduler.getState().lastRunAt).toBeUndefined();
    harness.scheduler.dispose();
  });

  it("手动 runNow 绕过 enabled / 空闲 / 到期判定并写回", async () => {
    const home = tempDir();
    const fake = makeFakeDeps(home);
    const harness = makeHarness(fake.deps, {
      enabled: () => false,
      isIdle: () => false,
    });
    harness.scheduler.start();

    const report = await harness.scheduler.runNow("manual");
    expect(report).not.toBeNull();
    expect(report!.trigger).toBe("manual");
    expect(fake.lists()).toBe(1);
    expect(fake.writes()).toBe(1);
    // 报告反映「去重后 token 下降」。
    expect(report!.savedTokens).toBeGreaterThan(0);
    expect(harness.scheduler.getState().lastRunAt).toBe(CLOCK);
    harness.scheduler.dispose();
  });

  it("dispose 之后 tick 与 runNow 都不再跑", async () => {
    const home = tempDir();
    const fake = makeFakeDeps(home);
    const harness = makeHarness(fake.deps);
    harness.scheduler.start();
    harness.scheduler.dispose();

    await harness.fire();
    expect(await harness.scheduler.runNow("manual")).toBeNull();
    expect(fake.lists()).toBe(0);
  });

  it("跨窗口锁被占用时跳过（runNow 返回 null）", async () => {
    const home = tempDir();
    const fake = makeFakeDeps(home);
    let releases = 0;
    const harness = makeHarness(fake.deps, {
      acquireLock: async () => false,
      releaseLock: async () => {
        releases++;
      },
    });
    harness.scheduler.start();

    expect(await harness.scheduler.runNow("manual")).toBeNull();
    expect(fake.lists()).toBe(0);
    expect(releases).toBe(0);
    harness.scheduler.dispose();
  });
});

describe("记忆整理：跨窗口锁", () => {
  function makeMemento() {
    const store = new Map<string, unknown>();
    return {
      store,
      get<T>(key: string): T | undefined {
        return store.get(key) as T | undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    } as unknown as Parameters<typeof createMemoryMaintenanceLock>[0] & {
      store: Map<string, unknown>;
    };
  }

  it("同一时刻只有一个 owner 能拿到锁", async () => {
    const memento = makeMemento();
    const a = createMemoryMaintenanceLock(memento, "window-a", () => 1_000);
    const b = createMemoryMaintenanceLock(memento, "window-b", () => 1_000);

    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    await a.release();
    expect(await b.acquire()).toBe(true);
    await b.release();
  });

  it("持有者崩溃后锁按 TTL 过期，可被下一个窗口接管", async () => {
    const memento = makeMemento();
    const stale = createMemoryMaintenanceLock(memento, "dead-window", () => 1_000);
    expect(await stale.acquire()).toBe(true);
    // 模拟持有者进程消失：不 release，时间越过 TTL。
    const later = createMemoryMaintenanceLock(
      memento,
      "fresh-window",
      () => 1_000 + MEMORY_MAINTENANCE_LOCK_TTL_MS + 1,
    );
    expect(await later.acquire()).toBe(true);
    await later.release();
  });

  it("release 只清自己持有的锁", async () => {
    const memento = makeMemento();
    const a = createMemoryMaintenanceLock(memento, "window-a", () => 1_000);
    const b: MemoryMaintenanceLock = createMemoryMaintenanceLock(memento, "window-b", () => 1_000);
    expect(await a.acquire()).toBe(true);
    // b 没拿到锁，release 必须是空操作。
    await b.release();
    expect(memento.get(MEMORY_MAINTENANCE_LOCK_KEY)).toMatchObject({ owner: "window-a" });
    await a.release();
    expect(memento.get(MEMORY_MAINTENANCE_LOCK_KEY)).toBeUndefined();
  });

  it("同窗口内重入 acquire 返回 false", async () => {
    const memento = makeMemento();
    const a = createMemoryMaintenanceLock(memento, "window-a", () => 1_000);
    expect(await a.acquire()).toBe(true);
    expect(await a.acquire()).toBe(false);
    await a.release();
  });
});

describe("记忆整理：保守空闲判定", () => {
  const base = {
    status: "idle" as const,
    initializing: false,
    replaying: false,
    pendingApproval: false,
    pendingQuestions: false,
    pendingProfileSwitch: false,
    pendingApprovals: 0,
    queuedPrompts: 0,
    activeChildSessions: false,
    lastActivityAt: 0,
    now: 60 * 60_000,
    idleMinutes: 15,
  };

  it("真正空闲且超过阈值时返回 true", () => {
    expect(isMemoryMaintenanceIdle(base)).toBe(true);
  });

  it.each([
    ["回合在流式", { status: "streaming" as const }],
    ["初始化中", { initializing: true }],
    ["回放历史", { replaying: true }],
    ["待审批", { pendingApproval: true }],
    ["待提问", { pendingQuestions: true }],
    ["待切换配置", { pendingProfileSwitch: true }],
    ["宿主还有未回包审批", { pendingApprovals: 1 }],
    ["有排队提示", { queuedPrompts: 1 }],
    ["子会话在跑", { activeChildSessions: true }],
    ["距上次活动不足阈值", { lastActivityAt: 60 * 60_000 - 1 }],
    ["idleMinutes 非法", { idleMinutes: 0 }],
  ])("%s 时判为不空闲", (_label, patch) => {
    expect(isMemoryMaintenanceIdle({ ...base, ...patch })).toBe(false);
  });
});

describe("记忆整理：生产 deps 适配器", () => {
  it("dry-run 策略下不写盘，但报告仍算出预计节省量", async () => {
    const home = tempDir();
    let writes = 0;
    const deps = buildMemoryMaintenanceDeps({
      getCwd: () => null,
      getWorkspaceRoots: () => [],
      getContextFileName: () => null,
      home,
      readFile: async () => CONTENT,
      writeFile: async () => {
        writes++;
      },
      dryRun: () => true,
      now: () => new Date(CLOCK),
    });

    // 直接驱动核心编排（runMaintenance），绕过 discovery 的真实目录扫描。
    const { runMaintenance } = await import("../src/memory/maintenance.js");
    const report = await runMaintenance(
      {
        ...deps,
        listFiles: async () => [{ path: path.join(home, "AGENTS.md"), scope: "global", kind: "primary" }],
      },
      "manual",
    );

    expect(writes).toBe(0);
    expect(report.savedTokens).toBeGreaterThan(0);
    expect(report.files[0]?.status).toBe("applied");
  });

  it("apply 策略下把 expectedHash 传给写回通道", async () => {
    const home = tempDir();
    const seen: Array<{ file: string; hash: string }> = [];
    const deps = buildMemoryMaintenanceDeps({
      getCwd: () => null,
      getWorkspaceRoots: () => [],
      getContextFileName: () => null,
      home,
      readFile: async () => CONTENT,
      writeFile: async (file, _content, expectedHash) => {
        seen.push({ file, hash: expectedHash });
      },
      dryRun: () => false,
      now: () => new Date(CLOCK),
    });

    const { runMaintenance } = await import("../src/memory/maintenance.js");
    const report = await runMaintenance(
      {
        ...deps,
        listFiles: async () => [{ path: path.join(home, "AGENTS.md"), scope: "global", kind: "primary" }],
      },
      "manual",
    );

    expect(report.files[0]?.status).toBe("applied");
    expect(seen).toHaveLength(1);
    // readFile 算出的哈希必须就是读到的内容哈希（写入侧用它做乐观校验）。
    expect(seen[0]?.hash).toBe(sha256(CONTENT));
  });

  it("listFiles 只返回已存在且可编辑的记忆文件，kind 透传 role", async () => {
    const home = tempDir();
    const workspace = tempDir("iflow-mem-ws-");
    writeFileSync(path.join(home, "AGENTS.md"), CONTENT, "utf8");
    mkdirSync(path.join(workspace, ".iflow"), { recursive: true });
    writeFileSync(path.join(workspace, "AGENTS.md"), CONTENT, "utf8");

    const deps = buildMemoryMaintenanceDeps({
      getCwd: () => workspace,
      getWorkspaceRoots: () => [workspace],
      getContextFileName: () => null,
      home,
      readFile: async (file) => {
        const { readFileSync } = await import("node:fs");
        try {
          return readFileSync(file, "utf8");
        } catch {
          return null;
        }
      },
      writeFile: async () => {},
      dryRun: () => true,
    });

    const files = await deps.listFiles();
    const global = files.find((f) => f.path === path.join(home, "AGENTS.md"));
    const project = files.find((f) => f.path === path.join(workspace, "AGENTS.md"));
    expect(global).toMatchObject({ scope: "global", kind: "primary" });
    expect(project).toMatchObject({ scope: "project" });
    // 不存在的候选（IFLOW.md 占位）不会出现在待整理清单里。
    expect(files.every((f) => f.kind !== "legacy")).toBe(true);
  });

  it("readFile 对缺失文件抛错（让核心把该文件记为 error 而不是崩溃）", async () => {
    const home = tempDir();
    const deps = buildMemoryMaintenanceDeps({
      getCwd: () => null,
      getWorkspaceRoots: () => [],
      getContextFileName: () => null,
      home,
      readFile: async () => null,
      writeFile: async () => {},
      dryRun: () => true,
    });
    await expect(deps.readFile(path.join(home, "AGENTS.md"))).rejects.toThrow(/不存在/);
  });

  it("budgets 走 getter：设置页改预算后下一轮立即生效", () => {
    let global = 4_000;
    const deps = buildMemoryMaintenanceDeps({
      getCwd: () => null,
      getWorkspaceRoots: () => [],
      getContextFileName: () => null,
      home: tempDir(),
      readFile: async () => null,
      writeFile: async () => {},
      dryRun: () => true,
      budgets: () => ({ global, project: 2_500 }),
    });
    expect(deps.budgets?.global).toBe(4_000);
    global = 8_000;
    expect(deps.budgets?.global).toBe(8_000);
  });
});

describe("记忆整理：token 计量口径", () => {
  it("estimateMarkdownTokens 对去重后的托管区块给出更小的值", () => {
    const compact = ["## iFlow Added Memories", "- 使用 pnpm", ""].join("\n");
    expect(estimateMarkdownTokens(compact)).toBeLessThan(estimateMarkdownTokens(CONTENT));
  });
});
