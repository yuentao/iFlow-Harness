/**
 * 核心接线与端到端回归（宿主运行时）。
 *
 * 钉住三件事的**真实路径**：
 *  1. 失败归一后投影里 diagnostics / lastError / statusDetail 真有数据，且四类
 *     失败（retryable / terminal / blocked / interrupted）分类正确；
 *  2. retry 的 maxAttempts 上限与 retryable 失败自动重试的退避；
 *  3. 汇报投递的 G2 delivered-unacked：回合没真正 settle 时汇报留在缓冲/账本，
 *     settle 后 confirm，中途 Stop / 失败时重新入队重投（不丢）。
 *
 * 只用 FakeClient + 内存桩，不起真实 CLI / SecretStorage / git。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAgentManager } from "../src/panel/super-agent.js";
import { SuperAgentHost } from "../src/panel/super-agent-host.js";
import { AcpClient, type AcpClientCallbacks } from "../src/acp/client.js";
import type { ContentBlock } from "../src/acp/protocol.js";
import { SuperReportBuffer, type SuperReport, type SuperSessionUi } from "../shared/super-agent.js";
import { classifySuperFailureKind } from "../src/panel/super-agent.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄占用，忽略 */ }
  }
  vi.useRealTimers();
});

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-wiring-e2e-"));
  roots.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 失败点 → 诊断 / 失败分类 / 状态说明
// ---------------------------------------------------------------------------

type FailurePlan = "exit" | "throw" | "complete";

class FailureFakeClient {
  disposed = false;
  constructor(
    readonly callbacks: AcpClientCallbacks,
    private readonly plan: FailurePlan,
  ) {}
  async newSession(): Promise<{ sessionId: string }> {
    return { sessionId: `sub-${Math.random().toString(36).slice(2, 8)}` };
  }
  async setMode(): Promise<unknown> { return {}; }
  async setModel(): Promise<unknown> { return {}; }
  async mcpStatus(): Promise<unknown> { return { available: false, servers: {} }; }
  async prompt(_request: { sessionId: string; prompt: ContentBlock[] }): Promise<{ stopReason: string }> {
    if (this.plan === "exit") {
      // 走 onExit 失败点 → failed；错误文本含「内核退出」→ retryable。
      this.callbacks.onExit?.(7);
      return { stopReason: "end_turn" };
    }
    if (this.plan === "throw") throw new Error("prepare kernel crashed");
    return { stopReason: "end_turn" };
  }
  isAlive(): boolean { return true; }
  cancel(): void {}
  async dispose(): Promise<void> { this.disposed = true; }
}

function makeFailureManager(options: {
  plans?: FailurePlan[];
  maxAttempts?: () => number;
  autoRetryBackoffMs?: number;
} = {}) {
  const repoRoot = makeRepo();
  const clients: FailureFakeClient[] = [];
  const sessions: SuperSessionUi[] = [];
  const reports: { session: SuperSessionUi; report: SuperReport }[] = [];
  const plans = options.plans ?? ["exit"];
  const manager = new SuperAgentManager({
    repoRoot,
    createClient: async (params) => {
      const plan = plans[clients.length] ?? "complete";
      const client = new FailureFakeClient(params.callbacks, plan);
      clients.push(client);
      return client as unknown as AcpClient;
    },
    onSessionsChanged: (next) => { sessions.length = 0; sessions.push(...next); },
    onReport: (entries) => reports.push(...entries),
    currentModel: () => null,
    currentMainSessionId: () => "main-1",
    integrationMode: () => "manual",
    maxConcurrentSessions: () => 5,
    maxAttempts: options.maxAttempts,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  if (options.autoRetryBackoffMs !== undefined) manager.autoRetryBackoffMs = options.autoRetryBackoffMs;
  return { manager, clients, sessions, reports };
}

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(predicate: () => boolean, timeoutMs = 800, stepMs = 15): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await settle(stepMs);
}

describe("核心接线 · 失败归一后诊断/失败分类/状态说明有数据", () => {
  it("内核退出失败：投影里 diagnostics / lastError / statusDetail 非空且分类 retryable", async () => {
    const { manager } = makeFailureManager({ plans: ["exit"] });
    const child = manager.spawn({ title: "失败任务", task: "跑到一半内核退出" });
    await settle();

    const projected = manager.get(child.id)!;
    expect(projected.status).toBe("failed");
    expect(projected.diagnostics?.length ?? 0).toBeGreaterThan(0);
    expect(projected.diagnostics!.some((d) => d.kind === "session")).toBe(true);
    expect(projected.lastError).toBeTruthy();
    expect(projected.lastError!.kind).toBe("retryable");
    expect(projected.lastError!.message).toContain("内核退出");
    expect((projected.statusDetail ?? "").length).toBeGreaterThan(0);
    await manager.dispose();
  });

  it("四分类归一函数覆盖 blocked/interrupted/retryable/terminal", () => {
    expect(classifySuperFailureKind("Host guard blocked destructive command")).toBe("blocked");
    expect(classifySuperFailureKind("上游任务失败，已跳过本任务")).toBe("blocked");
    expect(classifySuperFailureKind("user stopped by cancel")).toBe("interrupted");
    expect(classifySuperFailureKind("超流体内核退出（code=7）")).toBe("retryable");
    expect(classifySuperFailureKind("无响应超时 watchdog")).toBe("retryable");
    expect(classifySuperFailureKind("plain prepare error")).toBe("terminal");
  });

  it("spawn 阶段先留 spawn 诊断，再叠加 session/failed 诊断形成轨迹", async () => {
    const { manager } = makeFailureManager({ plans: ["throw"] });
    const child = manager.spawn({ title: "prepare 抛错", task: "炸在准备阶段" });
    await settle();
    const projected = manager.get(child.id)!;
    const kinds = (projected.diagnostics ?? []).map((d) => d.kind);
    expect(kinds).toContain("spawn");
    expect(projected.status).toBe("failed");
    expect(projected.lastError).toBeTruthy();
    await manager.dispose();
  });
});

describe("核心接线 · retry 上限与自动重试", () => {
  it("attempts >= maxAttempts 时 retry 返回 false", async () => {
    const { manager } = makeFailureManager({ plans: ["exit"] });
    const child = manager.spawn({ title: "上限用例", task: "失败一次" });
    await settle();
    expect(manager.get(child.id)!.attempts).toBe(1);
    // 注入上限 = 1：当前 attempts=1 >= 1，不允许重试。
    (manager.get(child.id)! as { maxAttempts?: number }).maxAttempts = 1;
    expect(await manager.retry(child.id)).toBe(false);
    await manager.dispose();
  });

  it("retryable 失败在 maxAttempts>1 时退避后自动 retry（attempts 递增到完成）", async () => {
    const { manager } = makeFailureManager({
      plans: ["exit", "complete"],
      maxAttempts: () => 2,
      autoRetryBackoffMs: 250,
    });
    const child = manager.spawn({ title: "自动重试", task: "第一次内核退出" });
    // 首次：prepareInner 跑到 prompt → onExit → failed + 归一 retryable。
    await settle(80);
    expect(manager.get(child.id)!.attempts).toBe(1);
    expect(manager.get(child.id)!.lastError?.kind).toBe("retryable");
    // 退避窗口（250ms）+ 第二次执行 → completed。
    await pollUntil(() => manager.get(child.id)!.attempts === 2, 800);
    expect(manager.get(child.id)!.attempts).toBe(2);
    await pollUntil(() => manager.get(child.id)!.status === "completed", 800);
    expect(manager.get(child.id)!.status).toBe("completed");
    await manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// 汇报投递 G2：delivered-unacked + 心跳重投
// ---------------------------------------------------------------------------

function makeHostHarness() {
  const buffer = new SuperReportBuffer();
  const storeState = { status: "streaming" as string };
  const webview: unknown[] = [];
  const deps = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    getContext: () => ({} as never),
    getServices: () => ({ workspaceRoot: "/tmp" }),
    getStore: () => ({
      getState: () => storeState,
      setSuperSessions: () => {},
      setSuperWaiting: () => {},
      sendToast: () => 1,
    }),
    isDisposed: () => false,
    getEditorPanel: () => undefined,
    isHistorySyncBusy: () => false,
    getQqHost: () => ({
      qqFinalRescueOwnerPending: () => false,
      qqFinalRescueText: new Map(),
      qqReportFallbackText: new Map(),
    }),
    getQqFinalRescueText: () => new Map(),
    announceCue: () => {},
    appendQqArchiveEvent: () => Promise.resolve(),
    captureQqReportTurnText: () => "",
    currentMainSessionId: () => "main-1",
    contextReportFile: () => "",
    getSuperAgent: () => null,
    refreshSuperWaitHeartbeat: () => {},
    deliverQqMainIntermediateText: () => {},
    forwardQqMainTaskChildQuestion: () => {},
    forwardQqTaskQuestion: () => {},
    materializeSystemPrompt: () => Promise.resolve(null),
    mcpProjectCwd: () => "/tmp",
    notifyOs: () => true,
    postToWebview: (m: unknown) => webview.push(m),
    qqFinalRescueDue: () => false,
    qqFinalRescueOwnerPending: () => false,
    readMcpScopes: () => ({ global: {} }),
    refreshMcpStatusFromBroker: () => {},
    resolveEntry: () => "/tmp/entry.js",
    resolveWorkspaceHandshakeCreds: () => Promise.resolve(null),
    chunkText: (c: unknown) => (typeof c === "string" ? c : ""),
    sendPrompt: () => Promise.resolve(true),
  };
  const host = new SuperAgentHost(deps as never);
  // 把测试缓冲登记到宿主，使 markReportDelivered / reconcileReportDelivery
  // 的 confirm / release 作用于同一个缓冲实例。
  host.pendingSuperReports.set("main-1", buffer);
  return { host, buffer, storeState, deps };
}

const SETTLED_SESSION = (): SuperSessionUi => ({
  id: "child-x",
  title: "投递用例",
  task: "汇报",
  status: "completed",
  isolation: { kind: "directory", path: "/tmp/wt" },
  createdAt: 1,
  updatedAt: 2,
  reports: [],
});

describe("核心接线 · 汇报投递 G2 delivered-unacked", () => {
  it("markReportDelivered 转入账本且不立即 confirm（缓冲键仍 in-flight）", () => {
    const { host, buffer } = makeHostHarness();
    const session = SETTLED_SESSION();
    const keys = ["child-x:1"];
    buffer.add([{ session, report: { state: "ready", summary: "做完了", at: 2 } }]);
    buffer.drainSettled([session]);
    expect(buffer.size).toBe(1); // 仍留缓冲（in-flight）

    host.markReportDelivered(
      {
        mainSessionId: "main-1",
        text: "汇报 child-x",
        reportKeys: keys,
        fallbackText: "做完了",
        final: true,
      },
      "主会话正文",
    );
    expect(host.reportDeliveryUnacked.size).toBe(1);
    expect(buffer.size).toBe(1); // 未 confirm：中途失败也不丢
  });

  it("回合恢复 settle（idle）后未确认汇报重新入队重投（不丢）", () => {
    const { host, buffer, storeState } = makeHostHarness();
    const session = SETTLED_SESSION();
    buffer.add([{ session, report: { state: "ready", summary: "做完了", at: 2 } }]);
    buffer.drainSettled([session]);
    host.reportRedeliveryMs = 0;
    host.markReportDelivered(
      { mainSessionId: "main-1", text: "汇报", reportKeys: ["child-x:1"], final: true },
      "正文",
    );
    storeState.status = "idle";
    host.reconcileReportDelivery();
    expect(host.reportDeliveryUnacked.size).toBe(0); // 出账本
    expect(host.pendingSuperReportPrompts.length).toBe(1); // 重新入队重投
    expect(buffer.size).toBe(1); // 缓冲仍在（未 confirm，可重取）
  });

  it("回合中途 streaming：未确认汇报留在账本等待，不 confirm 也不丢", () => {
    const { host, buffer, storeState } = makeHostHarness();
    const session = SETTLED_SESSION();
    buffer.add([{ session, report: { state: "ready", summary: "做完了", at: 2 } }]);
    buffer.drainSettled([session]);
    host.reportRedeliveryMs = 0;
    host.markReportDelivered(
      { mainSessionId: "main-1", text: "汇报", reportKeys: ["child-x:1"], final: true },
      "",
    );
    storeState.status = "streaming"; // 回合还在跑（中途失败尚未归一）
    host.reconcileReportDelivery();
    expect(host.reportDeliveryUnacked.size).toBe(1); // 留在账本
    expect(buffer.size).toBe(1); // 缓冲仍在（未 confirm）
    expect(host.pendingSuperReportPrompts.length).toBe(0); // 不提前重投
  });

  it("Stop 压住（autoTurnsHeld）时不 confirm，也不重投，等用户继续", () => {
    const { host, buffer, storeState } = makeHostHarness();
    const session = SETTLED_SESSION();
    buffer.add([{ session, report: { state: "ready", summary: "做完了", at: 2 } }]);
    buffer.drainSettled([session]);
    host.reportRedeliveryMs = 0;
    host.autoTurnsStoppedFor = "main-1";
    host.markReportDelivered(
      { mainSessionId: "main-1", text: "汇报", reportKeys: ["child-x:1"], final: true },
      "",
    );
    storeState.status = "idle"; // 即便 idle，被 Stop 压住也不 confirm
    host.reconcileReportDelivery();
    expect(host.reportDeliveryUnacked.size).toBe(1);
    expect(buffer.size).toBe(1);
  });
});
