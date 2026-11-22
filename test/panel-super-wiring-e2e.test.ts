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
import {
  classifySuperFailureKind,
  type SuperResidueItem,
} from "../src/panel/super-agent.js";

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
    // 固定 sleep 在并行 worker 下会先于 prepare 完成就断言；改为等真实终态。
    await pollUntil(() => manager.get(child.id)?.status === "failed", 1500);

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
    await pollUntil(() => manager.get(child.id)?.status === "failed", 1500);
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
    await pollUntil(() => manager.get(child.id)?.lastError?.kind === "retryable", 1500);
    expect(manager.get(child.id)!.attempts).toBe(1);
    expect(manager.get(child.id)!.lastError?.kind).toBe("retryable");
    // 退避窗口（250ms）+ 第二次执行 → completed。
    await pollUntil(() => manager.get(child.id)!.attempts === 2, 800);
    expect(manager.get(child.id)!.attempts).toBe(2);
    await pollUntil(() => manager.get(child.id)!.status === "completed", 800);
    expect(manager.get(child.id)!.status).toBe("completed");
    await manager.dispose();
  });

  it("缺省 maxAttempts 统一到 DEFAULT(2)：连续 retryable 失败只重试一次就停（不是 Infinity 无限重跑）", async () => {
    // 不注入 maxAttempts —— 缺省走 DEFAULT_SUPER_MAX_ATTEMPTS=2。连续三次都
    // retryable 失败，上限只许「首次 + 一次重试」= 2 次，第二次失败后 attempts
    // 已达上限，不再自动重试。旧实现自动路径 `?? Infinity` / `?? 1` 会分裂。
    const { manager } = makeFailureManager({
      plans: ["exit", "exit", "exit"],
      autoRetryBackoffMs: 30,
    });
    const child = manager.spawn({ title: "缺省上限", task: "连续失败" });
    await pollUntil(() => manager.get(child.id)?.attempts === 2 && manager.get(child.id)?.status === "failed", 2000);
    expect(manager.get(child.id)!.attempts).toBe(2);
    // 再多等几个退避窗口，确认没有第三次尝试（上限确确实实卡在 2）。
    await settle(250);
    expect(manager.get(child.id)!.attempts).toBe(2);
    await manager.dispose();
  });

  it("两条重试路径并发撞车时重入锁让 attempt 只 +1、只入队一次（不重复执行）", async () => {
    // 退避窗口开到极大，彻底关掉自动重试这条路径；只留两次「手动」retry 并发。
    // 旧实现无重入锁：两次 retry 在 await disposeClient 前都读到 attempts=1、
    // 都通过上限、都 reset + 入队 → 同一子会话跑两遍。
    const { manager } = makeFailureManager({
      plans: ["exit", "complete", "complete"],
      maxAttempts: () => 5,
      autoRetryBackoffMs: 100000,
    });
    const child = manager.spawn({ title: "并发重试", task: "失败一次后并发重试两次" });
    await pollUntil(() => manager.get(child.id)?.lastError?.kind === "retryable", 1500);
    expect(manager.get(child.id)!.attempts).toBe(1);

    const [first, second] = await Promise.all([
      manager.retry(child.id),
      manager.retry(child.id),
    ]);
    // 恰好一条路径拿到重试资格，另一条被重入锁挡下。
    expect([first, second].filter(Boolean)).toHaveLength(1);
    // attempt 只 +1（2），不是 +2（3）；第二次尝试最终完成。
    await pollUntil(() => manager.get(child.id)?.status === "completed", 1500);
    expect(manager.get(child.id)!.attempts).toBe(2);
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

  it("重投保留 in-flight：同一份终态汇报第二次 drainSettled 拿不到（不重复投递）", () => {
    // 修 2 的核心回归：中途 Stop / error 的汇报转入 delivered-unacked 账本，
    // reconcile 重新入队时**必须保留 in-flight 标记**。旧实现 reconcile 先
    // buffer.release(keys) 清标，下一拍 settleSuperReportsIfReady 的 drainSettled
    // 会把同一条再取一次 → 队列里两条同一汇报 → 同一份汇报被当成两轮 hidden
    // prompt 投进主会话（每轮一次主会话完整预填充 + 全部历史）。
    const { host, buffer, storeState } = makeHostHarness();
    const session = SETTLED_SESSION();
    buffer.add([{ session, report: { state: "ready", summary: "做完了", at: 2 } }]);
    expect(buffer.drainSettled([session])).toHaveLength(1); // 第一次取到，标记 in-flight
    expect(buffer.drainSettled([session])).toBeNull(); // in-flight 保护，第二次拿不到
    host.reportRedeliveryMs = 0;
    host.markReportDelivered(
      { mainSessionId: "main-1", text: "汇报", reportKeys: ["child-x:1"], final: true },
      "正文",
    );
    storeState.status = "idle";
    host.reconcileReportDelivery(); // 重投：保留 in-flight，重新入队
    expect(host.reportDeliveryUnacked.size).toBe(0);
    expect(host.pendingSuperReportPrompts.length).toBe(1);
    // 关键：重投后 in-flight 仍在，同一条 drain 不出来 —— 队列里不会出现第二条。
    expect(buffer.drainSettled([session])).toBeNull();
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

// ---------------------------------------------------------------------------
// 批次2A：看门狗分级 / 活性采集 / 判定卡死 / 残留令牌 / urgent 写
// ---------------------------------------------------------------------------

class TierFakeClient {
  disposed = false;
  promptStarted = false;
  constructor(
    readonly callbacks: AcpClientCallbacks,
    private readonly hangNewSession: boolean,
    private readonly emitActivity: boolean,
  ) {}
  async newSession(): Promise<{ sessionId: string }> {
    if (this.hangNewSession) return new Promise(() => {});
    return { sessionId: "sub-tier" };
  }
  async setMode(): Promise<unknown> { return {}; }
  async setModel(): Promise<unknown> { return {}; }
  async mcpStatus(): Promise<unknown> { return { available: false, servers: {} }; }
  async prompt(): Promise<{ stopReason: string }> {
    this.promptStarted = true;
    if (this.emitActivity) {
      this.callbacks.onSessionUpdate?.({
        sessionId: "sub-tier",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          toolName: "read_file",
          status: "in_progress",
          title: "读取文件",
        },
      } as never);
    }
    return new Promise(() => {});
  }
  isAlive(): boolean { return true; }
  cancel(): void {}
  async dispose(): Promise<void> { this.disposed = true; }
}

function makeTierManager(options: {
  hangNewSession?: boolean;
  emitActivity?: boolean;
  prepareMs?: number;
  runningMs?: number;
}) {
  const repoRoot = makeRepo();
  const clients: TierFakeClient[] = [];
  const sessions: SuperSessionUi[] = [];
  const manager = new SuperAgentManager({
    repoRoot,
    createClient: async (params) => {
      const client = new TierFakeClient(
        params.callbacks,
        options.hangNewSession === true,
        options.emitActivity === true,
      );
      clients.push(client);
      return client as unknown as AcpClient;
    },
    onSessionsChanged: (next) => { sessions.length = 0; sessions.push(...next); },
    onReport: () => {},
    currentModel: () => null,
    currentMainSessionId: () => "main-1",
    integrationMode: () => "manual",
    maxConcurrentSessions: () => 5,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  manager.prepareStallTimeoutMs = options.prepareMs ?? 60;
  manager.stallTimeoutMs = options.runningMs ?? 60;
  return { manager, clients, sessions };
}

describe("批次2A · 看门狗分级 / 活性采集 / 判定卡死", () => {
  it("准备档独立阈值：newSession 挂起时按准备档归一并写 timeout 诊断", async () => {
    const h = makeTierManager({ hangNewSession: true, prepareMs: 80, runningMs: 5000 });
    try {
      const child = h.manager.spawn({ title: "准备卡死", task: "newSession 永不返回" });
      await pollUntil(() => h.manager.get(child.id)?.status === "failed", 1500);
      const failed = h.manager.get(child.id)!;
      expect(failed.error).toContain("准备中");
      expect(
        failed.diagnostics?.some((d) => d.kind === "timeout" && d.message.includes("准备中")),
      ).toBe(true);
      expect(h.clients[0]!.disposed).toBe(true);
    } finally {
      await h.manager.dispose();
    }
  });

  it("运行档独立阈值：started 之后 prompt 挂起按运行档归一，不用准备档短阈值", async () => {
    const h = makeTierManager({ prepareMs: 5000, runningMs: 80 });
    try {
      const child = h.manager.spawn({ title: "运行卡死", task: "prompt 永不返回" });
      await pollUntil(() => h.clients[0]?.promptStarted === true, 1500);
      await pollUntil(() => h.manager.get(child.id)?.status === "failed", 1500);
      const failed = h.manager.get(child.id)!;
      expect(failed.error).toContain("运行中");
      expect(
        failed.diagnostics?.some((d) => d.kind === "timeout" && d.message.includes("运行中")),
      ).toBe(true);
    } finally {
      await h.manager.dispose();
    }
  });

  it("活性采集：tool_call update 追加诊断并维护最近活动时间戳（不改状态机）", async () => {
    const h = makeTierManager({ emitActivity: true, prepareMs: 5000, runningMs: 5000 });
    try {
      const child = h.manager.spawn({ title: "活跃", task: "持续工具调用" });
      await pollUntil(
        () =>
          (h.manager.get(child.id)?.diagnostics ?? []).some((d) =>
            d.message.includes("工具调用") && d.message.includes("read_file"),
          ),
        1500,
      );
      const session = h.manager.get(child.id)!;
      expect(session.status).toBe("running"); // 诊断不改变状态机
      const snap = h.manager.activitySnapshot().find((a) => a.id === child.id);
      expect(snap?.lastActivityAt).toBeGreaterThan(0);
      expect(snap?.phase).toBe("running");
    } finally {
      await h.manager.dispose();
    }
  });

  it("用户判定卡死：先记 timeout 诊断再按 user 来源中断", async () => {
    const h = makeTierManager({ prepareMs: 5000, runningMs: 5000 });
    try {
      const child = h.manager.spawn({ title: "手动判定", task: "卡住" });
      await pollUntil(() => h.clients[0]?.promptStarted === true, 1500);
      const outcome = await h.manager.judgeStuck(child.id);
      expect(outcome.reason).toBe("cancelled");
      const session = h.manager.get(child.id)!;
      expect(session.status).toBe("cancelled");
      expect(
        session.diagnostics?.some((d) => d.kind === "timeout" && d.message.includes("用户判定卡死")),
      ).toBe(true);
    } finally {
      await h.manager.dispose();
    }
  });
});

describe("批次2A · 残留二次确认令牌与 urgent 写", () => {
  const ITEM: SuperResidueItem = {
    key: "/tmp/wt-1",
    kind: "worktree",
    path: "/tmp/wt-1",
    branch: "iflow/super/legacy-x",
    unmerged: true,
    uncommitted: false,
    inProgress: false,
  };

  it("discard 首次只发确认框并返回令牌；未确认不删除，确认后才执行", async () => {
    const discarded: string[] = [];
    const managerStub = {
      listResidueItems: async () => [ITEM],
      discardResidueItem: async (item: SuperResidueItem) => {
        discarded.push(item.key);
        return { ok: true };
      },
    };
    const { host, deps } = makeHostHarness();
    (deps as unknown as Record<string, unknown>).getSuperAgent = () => managerStub;

    const first = await host.handleSuperResidueAction({ key: ITEM.key, action: "discard" });
    expect(first.ok).toBe(false);
    expect(first.token).toMatch(/^super-residue-discard-/);
    expect(discarded).toHaveLength(0);

    host.handleSuperResidueConfirmResponse(first.token!, false);
    await settle(10);
    expect(discarded).toHaveLength(0); // 取消 = 不丢弃

    const second = await host.handleSuperResidueAction({ key: ITEM.key, action: "discard" });
    host.handleSuperResidueConfirmResponse(second.token!, true);
    await settle(20);
    expect(discarded).toEqual([ITEM.key]);
  });

  it("批量丢弃聚合成一次确认：未确认不删，确认后逐条执行", async () => {
    const ITEM2: SuperResidueItem = {
      ...ITEM,
      key: "/tmp/wt-2",
      path: "/tmp/wt-2",
      branch: "iflow/super/legacy-y",
    };
    const discarded: string[] = [];
    const managerStub = {
      listResidueItems: async () => [ITEM, ITEM2],
      discardResidueItem: async (item: SuperResidueItem) => {
        discarded.push(item.key);
        return { ok: true };
      },
    };
    const { host, deps } = makeHostHarness();
    (deps as unknown as Record<string, unknown>).getSuperAgent = () => managerStub;

    const first = await host.handleSuperResidueDiscardBatch({ keys: [ITEM.key, ITEM2.key] });
    expect(first.ok).toBe(false);
    expect(first.token).toMatch(/^super-residue-discard-/);
    expect(discarded).toHaveLength(0); // 只有一次确认框，未确认不删任何条目

    host.handleSuperResidueConfirmResponse(first.token!, true);
    await settle(20);
    expect(discarded).toEqual([ITEM.key, ITEM2.key]);
  });

  it("批量丢弃忽略已不存在的 key，全部不存在时直接拒绝", async () => {
    const managerStub = {
      listResidueItems: async () => [ITEM],
      discardResidueItem: async () => ({ ok: true }),
    };
    const { host, deps } = makeHostHarness();
    (deps as unknown as Record<string, unknown>).getSuperAgent = () => managerStub;
    const result = await host.handleSuperResidueDiscardBatch({ keys: ["/tmp/gone"] });
    expect(result.ok).toBe(false);
    expect(result.token).toBeUndefined();
  });

  it("urgent 写关键指纹：终态 / 失败分类 / 集成变化才触发强制落盘", () => {
    const { host } = makeHostHarness();
    const base = SETTLED_SESSION();
    expect(host.noteSuperCriticalChange([base])).toBe(true);
    expect(host.noteSuperCriticalChange([base])).toBe(false); // 无变化
    expect(
      host.noteSuperCriticalChange([
        { ...base, lastError: { kind: "retryable", message: "x", at: 3 } },
      ]),
    ).toBe(true);
    expect(host.noteSuperCriticalChange([{ ...base, status: "failed" }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 接线 · 子会话工具白名单进入 session/new settings
// ---------------------------------------------------------------------------

type SeenNewSession = {
  cwd: string;
  mcpServers: readonly unknown[];
  settings?: Record<string, unknown>;
};

class SettingsProbeClient {
  disposed = false;
  constructor(
    readonly callbacks: AcpClientCallbacks,
    private readonly seen: SeenNewSession[],
  ) {}
  async newSession(req: SeenNewSession): Promise<{ sessionId: string }> {
    this.seen.push(req);
    return { sessionId: "sub-settings-probe" };
  }
  async setMode(): Promise<unknown> { return {}; }
  async setModel(): Promise<unknown> { return {}; }
  async mcpStatus(): Promise<unknown> { return { available: false, servers: {} }; }
  async prompt(): Promise<{ stopReason: string }> { return { stopReason: "end_turn" }; }
  isAlive(): boolean { return true; }
  cancel(): void {}
  async dispose(): Promise<void> { this.disposed = true; }
}

function makeSettingsProbeManager(childSettings?: {
  allowed_tools?: string[];
  disallowed_tools?: string[];
}) {
  const repoRoot = makeRepo();
  const seen: SeenNewSession[] = [];
  const manager = new SuperAgentManager({
    repoRoot,
    createClient: async (params) =>
      new SettingsProbeClient(params.callbacks, seen) as unknown as AcpClient,
    // 宿主在缺省配置下给的就是 undefined（buildChildSessionSettings([], [])）。
    childSessionSettings: childSettings ? () => ({ ...childSettings }) : undefined,
    onSessionsChanged: () => {},
    onReport: () => {},
    currentModel: () => null,
    currentMainSessionId: () => "main-1",
    integrationMode: () => "manual",
    maxConcurrentSessions: () => 5,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { manager, seen };
}

describe("接线 · 子会话工具白名单进入 session/new settings", () => {
  it("两个白名单皆空（buildChildSessionSettings 返回 undefined）：不传 settings / 无 allowed_tools", async () => {
    const { manager, seen } = makeSettingsProbeManager(undefined);
    manager.spawn({ title: "缺省", task: "缺省配置" });
    await pollUntil(() => seen.length > 0);
    expect(seen[0]!.settings).toBeUndefined();
    expect(seen[0]!.settings?.allowed_tools).toBeUndefined();
  });

  it("工具白名单非空：session/new settings 带 allowed_tools", async () => {
    const { manager, seen } = makeSettingsProbeManager({
      allowed_tools: ["read_file", "glob"],
    });
    manager.spawn({ title: "白名单", task: "限制工具" });
    await pollUntil(() => seen.length > 0);
    expect(seen[0]!.settings?.allowed_tools).toEqual(["read_file", "glob"]);
  });

  it("与既有 disallowedTools 合并：两种策略同时存在互不覆盖", async () => {
    const { manager, seen } = makeSettingsProbeManager({
      allowed_tools: ["read_file"],
    });
    manager.spawn(
      { title: "合并", task: "两种策略" },
      { policy: { approval: "auto", disallowedTools: ["run_shell_command"] } },
    );
    await pollUntil(() => seen.length > 0);
    expect(seen[0]!.settings?.allowed_tools).toEqual(["read_file"]);
    expect(seen[0]!.settings?.disallowed_tools).toEqual(["run_shell_command"]);
  });
});
