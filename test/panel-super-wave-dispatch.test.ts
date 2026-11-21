/**
 * 波次依赖调度端到端回归（宿主运行时）。
 *
 * 钉住：
 *  1. dispatch 用 planSuperWaves 注入 wave / runId，prepareSpec 保留 dependsOn /
 *     batch，spawn 透传到 session；
 *  2. pump 按 wave 分层门控：上游未终态时下游留队列（不启动），上游失败时下游
 *     标记 failed + lastError.kind="blocked" + statusDetail（dependencyPolicy=
 *     continue 时放行）；
 *  3. 单层主→子架构不变（不新增孙层级）；平铺派发行为逐字不变。
 *
 * 只用 FakeClient + 内存桩，不起真实 CLI / git。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SuperAgentManager } from "../src/panel/super-agent.js";
import { AcpClient, type AcpClientCallbacks } from "../src/acp/client.js";
import type { ContentBlock } from "../src/acp/protocol.js";
import type { SuperReport, SuperSessionUi } from "../shared/super-agent.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄占用，忽略 */ }
  }
});

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-wave-dispatch-"));
  roots.push(dir);
  return dir;
}

type Plan = "hold" | "complete" | "fail";

class WaveFakeClient {
  disposed = false;
  settle: ((value: { stopReason: string }) => void) | null = null;
  constructor(
    readonly callbacks: AcpClientCallbacks,
    private readonly plan: Plan,
  ) {}
  async newSession(): Promise<{ sessionId: string }> {
    return { sessionId: `sub-${Math.random().toString(36).slice(2, 8)}` };
  }
  async setMode(): Promise<unknown> { return {}; }
  async setModel(): Promise<unknown> { return {}; }
  async mcpStatus(): Promise<unknown> { return { available: false, servers: {} }; }
  async prompt(_r: { sessionId: string; prompt: ContentBlock[] }): Promise<{ stopReason: string }> {
    if (this.plan === "fail") throw new Error("内核退出（code=3）");
    if (this.plan === "hold") {
      return new Promise((resolve) => { this.settle = resolve; });
    }
    return { stopReason: "end_turn" };
  }
  isAlive(): boolean { return true; }
  cancel(): void { this.settle?.({ stopReason: "cancelled" }); }
  async dispose(): Promise<void> { this.disposed = true; }
}

function makeManager(options: {
  plans?: Plan[] | Plan;
  maxConcurrent?: number;
  dependencyPolicy?: "block" | "continue";
  maxAttempts?: () => number;
} = {}) {
  const repoRoot = makeRepo();
  const clients: WaveFakeClient[] = [];
  const sessions: SuperSessionUi[] = [];
  const reports: { session: SuperSessionUi; report: SuperReport }[] = [];
  const plans = options.plans ?? "complete";
  const manager = new SuperAgentManager({
    repoRoot,
    createClient: async (params) => {
      const plan = Array.isArray(plans) ? (plans[clients.length] ?? "complete") : plans;
      const client = new WaveFakeClient(params.callbacks, plan);
      clients.push(client);
      return client as unknown as AcpClient;
    },
    onSessionsChanged: (next) => { sessions.length = 0; sessions.push(...next); },
    onReport: (entries) => reports.push(...entries),
    currentModel: () => null,
    currentMainSessionId: () => "main-1",
    integrationMode: () => "manual",
    maxConcurrentSessions: () => options.maxConcurrent ?? 5,
    dependencyPolicy: options.dependencyPolicy ? () => options.dependencyPolicy! : undefined,
    maxAttempts: options.maxAttempts,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { manager, clients, sessions, reports };
}

async function tick(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到条件成立或超时（异步收尾链较长，固定 sleep 不可靠）。 */
async function poll(predicate: () => boolean, timeoutMs = 600, stepMs = 15): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await tick(stepMs);
}

describe("波次调度 · spawn 透传 wave/runId/dependsOn/batch", () => {
  it("带 dependsOn / batch 的 spec 注入到 session 并记录 spawn 诊断", async () => {
    const { manager } = makeManager({ plans: "complete" });
    const upstream = manager.spawn(
      { id: "prepare", title: "准备环境", task: "建目录" },
      { runId: "run-a", wave: 0 },
    );
    const downstream = manager.spawn(
      { title: "实现功能", task: "写代码", dependsOn: ["prepare"] },
      { runId: "run-a", wave: 1 },
    );
    expect(upstream.wave).toBe(0);
    expect(upstream.runId).toBe("run-a");
    expect(downstream.wave).toBe(1);
    expect(downstream.dependsOn).toEqual(["prepare"]);
    expect(manager.get(downstream.id)!.diagnostics?.some((d) => d.kind === "spawn")).toBe(true);
    await tick();
    await manager.dispose();
  });

  it("平铺派发（无 runId/wave）保持 wave 0、无依赖，行为不变", async () => {
    const { manager } = makeManager({ plans: "complete" });
    const child = manager.spawn({ title: "平铺", task: "直接干" });
    expect(child.wave).toBe(0);
    expect(child.dependsOn).toBeUndefined();
    expect(child.runId).toBeUndefined();
    await tick();
    await manager.dispose();
  });
});

describe("波次调度 · pump 分层门控（上游未终态 → 下游留队列）", () => {
  it("上游 hold 未终态时，下游 wave 1 留在队列不启动", async () => {
    const { manager, clients } = makeManager({
      plans: ["hold", "complete"],
      maxConcurrent: 5,
    });
    manager.spawn({ id: "up", title: "上游", task: "慢任务" }, { runId: "run-b", wave: 0 });
    const down = manager.spawn(
      { title: "下游", task: "等上游", dependsOn: ["up"] },
      { runId: "run-b", wave: 1 },
    );
    await poll(() => clients.length >= 1);
    // 上游进程起来了并在 hold；下游因依赖未终态仍 preparing + queued。
    expect(clients.length).toBe(1);
    const projected = manager.get(down.id)!;
    expect(projected.status).toBe("preparing");
    expect(projected.queued).toBe(true);
    await manager.dispose();
  });

  it("上游失败 → 下游标记 failed + lastError.kind=blocked + statusDetail", async () => {
    const { manager } = makeManager({
      plans: ["fail", "complete"],
      maxAttempts: () => 1, // 阻止上游 retryable 失败自动重跑，确保它保持 failed
    });
    manager.spawn({ id: "up-fail", title: "上游失败", task: "炸" }, { runId: "run-c", wave: 0 });
    const down = manager.spawn(
      { title: "下游跳过", task: "不该跑", dependsOn: ["up-fail"] },
      { runId: "run-c", wave: 1 },
    );
    await poll(() => manager.get(down.id)?.status === "failed", 1500);
    const projected = manager.get(down.id)!;
    expect(projected.status).toBe("failed");
    expect(projected.lastError?.kind).toBe("blocked");
    expect(projected.statusDetail ?? "").toContain("上游任务失败");
    await manager.dispose();
  });

  it("dependencyPolicy=continue 时上游失败仍放行下游", async () => {
    const { manager, clients } = makeManager({
      plans: ["fail", "complete"],
      dependencyPolicy: "continue",
      maxAttempts: () => 1,
    });
    manager.spawn({ id: "up-fail2", title: "上游失败", task: "炸" }, { runId: "run-d", wave: 0 });
    const down = manager.spawn(
      { title: "下游照跑", task: "继续", dependsOn: ["up-fail2"] },
      { runId: "run-d", wave: 1 },
    );
    await poll(() => manager.get(down.id)!.status === "completed");
    const projected = manager.get(down.id)!;
    // continue 策略：下游被启动并最终完成，不标 blocked。
    expect(projected.status).toBe("completed");
    expect(clients.length).toBe(2);
    await manager.dispose();
  });

  it("上游完成后下游 gets dispatched（wave 门控解除）", async () => {
    const { manager, clients } = makeManager({ plans: ["complete", "complete"] });
    manager.spawn({ id: "up-ok", title: "上游完成", task: "快" }, { runId: "run-e", wave: 0 });
    manager.spawn(
      { title: "下游跟进", task: "接力", dependsOn: ["up-ok"] },
      { runId: "run-e", wave: 1 },
    );
    await poll(() => clients.length === 2);
    expect(clients.length).toBe(2);
    await manager.dispose();
  });
});

describe("批次2A · 波次批量重试 handler 与尝试上限", () => {
  it("retryWave 按波次重排：先重试上游解开依赖，再重试被阻塞的下一波", async () => {
    const { manager } = makeManager({
      plans: ["fail", "complete", "complete", "complete"],
      maxAttempts: () => 2,
    });
    manager.autoRetryBackoffMs = 60_000; // 关掉自动重试，隔离手动波次重试
    const up = manager.spawn(
      { id: "up-r", title: "上游先失败", task: "炸一次" },
      { runId: "run-r", wave: 0 },
    );
    const d1 = manager.spawn(
      { title: "下游一", task: "等上游" },
      { runId: "run-r", wave: 1 },
    );
    const d2 = manager.spawn(
      { title: "下游二", task: "等上游" },
      { runId: "run-r", wave: 1 },
    );
    await poll(() => manager.get(up.id)?.status === "failed");
    await poll(() => manager.get(d1.id)?.status === "failed");
    expect(manager.get(d1.id)!.lastError?.kind).toBe("blocked");

    const retriedUp = await manager.retryWave({ runId: "run-r", wave: 0 });
    expect(retriedUp).toEqual([up.id]);
    await poll(() => manager.get(up.id)?.status === "completed");

    const retriedDown = await manager.retryWave({ runId: "run-r", wave: 1 });
    expect(retriedDown.sort()).toEqual([d1.id, d2.id].sort());
    await poll(() =>
      manager.get(d1.id)!.status === "completed" && manager.get(d2.id)!.status === "completed",
    );
    expect(manager.get(up.id)!.attempts).toBe(2);
    expect(manager.get(d1.id)!.attempts).toBe(2);
    await manager.dispose();
  });

  it("达到 maxAttempts 时 retryWave / retryFailed 不再重试（上限守门）", async () => {
    const { manager } = makeManager({ plans: "fail", maxAttempts: () => 1 });
    const child = manager.spawn(
      { id: "cap", title: "上限", task: "炸" },
      { runId: "run-cap", wave: 0 },
    );
    await poll(() => manager.get(child.id)?.status === "failed");
    expect(await manager.retryWave({ runId: "run-cap", wave: 0 })).toEqual([]);
    expect(await manager.retryFailed({ runId: "run-cap" })).toEqual([]);
    expect(manager.get(child.id)!.attempts).toBe(1);
    await manager.dispose();
  });

  it("retryFailed 重试整组所有失败任务（不限波次）", async () => {
    const { manager } = makeManager({
      plans: ["fail", "fail", "complete", "complete"],
      maxAttempts: () => 2,
    });
    manager.autoRetryBackoffMs = 60_000;
    const a = manager.spawn({ id: "fail-a", title: "失败 A", task: "x" }, { runId: "run-f", wave: 0 });
    const b = manager.spawn({ id: "fail-b", title: "失败 B", task: "y" }, { runId: "run-f", wave: 0 });
    await poll(() =>
      manager.get(a.id)?.status === "failed" && manager.get(b.id)?.status === "failed",
    );
    const retried = await manager.retryFailed({ runId: "run-f" });
    expect(retried.sort()).toEqual([a.id, b.id].sort());
    await poll(() =>
      manager.get(a.id)!.status === "completed" && manager.get(b.id)!.status === "completed",
    );
    await manager.dispose();
  });
});
