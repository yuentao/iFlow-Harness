/**
 * QQ 出站的两个「内容被吃掉」缺陷的回归（2026-11-19）。
 *
 * 缺陷一（占位烧掉真实答复）：
 *   `completeMainFinalAnswer` 在 `status !== "injected"` 时早退，
 *   `deliverResult` 又被 `resultDeliveredAt` 幂等锚点挡住 —— 于是「先投了
 *   22 字占位（QQ_MAIN_FINAL_EMPTY_NOTICE）」之后，后到的真实长正文**没有
 *   第二次投递机会**，任务归档里的 summary 永远停在占位。
 *
 * 缺陷二（中间正文被节流后不补发）：
 *   `deliverProgressLike` 的「最小间隔 + 指纹去重」命中后，中间正文被静默
 *   压掉，只在本地弹提示，QQ 端再没有补发机会（同一批子会话快速完成时，
 *   进度全被压成第一条）。
 *
 * 本文件只钉住这两处的行为，不碰入站 / 待审核队列 / 接管冻结语义。
 */

import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/qq/adapter/types.js";
import type { QqConfig } from "../src/qq/config.js";
import {
  QqService,
  QQ_MAIN_FINAL_EMPTY_NOTICE,
  QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS,
  type QqMainInjectInput,
  type QqMainInjectResult,
  type QqServiceHost,
} from "../src/qq/service.js";
import type {
  QqTaskEvent,
  QqTaskIndexEntry,
  QqTaskRecord,
  QqTaskStore,
} from "../src/qq/store.js";
import type { QqTask } from "../shared/qq-task.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

class MemoryStore {
  readonly records = new Map<string, QqTask>();
  readonly events: QqTaskEvent[] = [];

  async saveTask(task: QqTaskRecord): Promise<void> {
    this.records.set(task.taskId, JSON.parse(JSON.stringify(task)) as QqTask);
  }

  async loadTask(taskId: string): Promise<QqTask | null> {
    const record = this.records.get(taskId);
    return record ? (JSON.parse(JSON.stringify(record)) as QqTask) : null;
  }

  async listTasks(): Promise<QqTaskIndexEntry[]> {
    return [...this.records.values()]
      .map((task) => ({
        taskId: task.taskId,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        chatId: task.source.chatId,
        senderId: task.source.senderId,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId));
  }

  async appendEvent(event: QqTaskEvent): Promise<void> {
    this.events.push(event);
  }
}

interface Delivered {
  chatType: "private" | "group";
  chatId: string;
  text: string;
  replyToMsgId?: string;
  dedupeKey?: string;
}

interface Injection {
  input: QqMainInjectInput;
  resolve: (result: QqMainInjectResult) => void;
}

interface Fixture {
  service: QqService;
  store: MemoryStore;
  delivered: Delivered[];
  notes: string[];
  injections: Injection[];
  /** 让后续投递一律失败（模拟额度用尽 / 平台拒绝）。 */
  failDelivery: (fail: boolean) => void;
}

function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
  return {
    enabled: true,
    allowedUsers: ["u1"],
    allowedGroups: ["g1"],
    workspace: "/ws",
    remotePolicy: "supervised",
    maxConcurrentTasks: 2,
    rateLimitPerMin: 6,
    resultDetail: "standard",
    autoMerge: false,
    ...overrides,
  };
}

function makeFixture(options: {
  config?: Partial<QqConfig>;
  now?: () => number;
  monotonicNow?: () => number;
} = {}): Fixture {
  const store = new MemoryStore();
  const delivered: Delivered[] = [];
  const notes: string[] = [];
  const injections: Injection[] = [];
  let deliveryFails = false;

  const host: QqServiceHost = {
    workspaceRoots: () => ["/ws"],
    dispatchTask: async () => ({ superSessionId: "super-1", branch: "iflow/qq/test" }),
    cancelTask: async () => undefined,
    mergeTask: async () => ({ ok: true, detail: "已合并" }),
    discardTask: async () => ({}),
    readTaskOutcome: () => ({ summary: "超流体完成", stopReason: "end_turn" }),
    deliver: async (msg) => {
      delivered.push({ ...msg });
      if (deliveryFails) {
        return { ok: false, retryable: false, error: "QQBot: 业务错误 40054（主动消息额度已用尽）" };
      }
      return { ok: true };
    },
    onPendingUser: () => undefined,
    unbindAccount: async () => ({ ok: true, message: "已解绑" }),
    notify: (text) => {
      notes.push(text);
    },
    injectIntoMainSession: (input: QqMainInjectInput) =>
      new Promise<QqMainInjectResult>((resolve) => {
        injections.push({ input, resolve });
      }),
  };

  const service = new QqService({
    config: makeConfig(options.config),
    store: store as unknown as QqTaskStore,
    host,
    newTaskChannel: "main",
    deliveryRetryDelayMs: 0,
    log: () => undefined,
    ...(options.now ? { now: options.now } : {}),
    ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}),
  });
  return {
    service,
    store,
    delivered,
    notes,
    injections,
    failDelivery: (fail: boolean) => {
      deliveryFails = fail;
    },
  };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatType: "private",
    chatId: "u1",
    senderId: "u1",
    msgId: "m1",
    text: "/qq task 修一下这个问题",
    mentionsBot: false,
    attachments: [],
    timestamp: 0,
    ...overrides,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * 走完入站 + 注入，并让注入轮以 delegated=true 收尾 —— 任务停在 `injected`
 * 等最终答复（这正是「先占位、后真实正文」与「中间正文」两条链路的起点）。
 */
async function injectedMainTask(f: Fixture): Promise<string> {
  await f.service.handleInboundMessage(inbound({ msgId: "m-main" }));
  await waitFor(() => f.injections.length === 1);
  await f.injections[0]!.input.onInjected();
  f.injections[0]!.resolve({
    injected: true,
    text: "已派超流体去做，先等一下",
    stopReason: "end_turn",
    delegated: true,
  });
  await waitFor(() => f.delivered.some((item) => item.text.includes("已受理，正在处理")));
  const summary = f.service.listTasks()[0];
  if (!summary) throw new Error("没有任务");
  return summary.taskId;
}

function taskOf(f: Fixture, taskId: string): QqTask {
  const task = f.service.getTask(taskId);
  if (!task) throw new Error(`任务 ${taskId} 不在内存中`);
  return task;
}

// ---------------------------------------------------------------------------
// 缺陷一：占位可升级为真实正文并重投
// ---------------------------------------------------------------------------

describe("QQ 出站 — 占位结果可升级为真实正文", () => {
  it("先投占位、后到真实正文：归档 summary 被改写并重投一次", async () => {
    let wall = Date.now() - 60_000;
    const f = makeFixture({ now: () => wall });
    const taskId = await injectedMainTask(f);

    // ① 先到的是**空正文**（服务侧兜底成占位文案）—— 占位被投给 QQ。
    await f.service.completeMainFinalAnswer({ taskId, text: "   ", stopReason: "end_turn" });
    const placeholder = taskOf(f, taskId);
    expect(placeholder.result?.summary).toBe(QQ_MAIN_FINAL_EMPTY_NOTICE);
    expect(placeholder.resultDeliveredAt).toBeTypeOf("number");
    expect(f.store.events.filter((e) => e.type === "task_result_delivered")).toHaveLength(1);
    const deliveredBefore = f.delivered.length;

    // ② 真实长正文随后才到（这是修复前被吞掉的那一份）。
    wall += 5_000;
    const real = "真正最终答复：三个文件都改好了，测试全过，命令如下……";
    await f.service.completeMainFinalAnswer({ taskId, text: real, stopReason: "end_turn" });

    const upgraded = taskOf(f, taskId);
    // 归档里的 summary 不再停在占位。
    expect(upgraded.result?.summary).toBe(real);
    // 幂等锚点被更新为**重投时刻**（不是沿用占位那次）。
    expect(upgraded.resultDeliveredAt).toBeTypeOf("number");
    expect(upgraded.resultDeliveredAt!).toBeGreaterThan(placeholder.resultDeliveredAt!);
    // 回包没有失败记录。
    expect(upgraded.deliveryError).toBeUndefined();
    // 归档事件：占位一次 + 重投一次。
    expect(f.store.events.filter((e) => e.type === "task_result_delivered")).toHaveLength(2);
    expect(f.store.events.some((e) => e.type === "task_result_upgraded")).toBe(true);
    // QQ 端至少收到一次含真实正文的摘要。
    expect(f.delivered.length).toBeGreaterThan(deliveredBefore);
    expect(f.delivered.some((item) => item.text.includes(real))).toBe(true);
  });

  it("同一份真实正文重复到达不重复投递（幂等）", async () => {
    let wall = Date.now() - 60_000;
    const f = makeFixture({ now: () => wall });
    const taskId = await injectedMainTask(f);

    await f.service.completeMainFinalAnswer({ taskId, text: "", stopReason: "end_turn" });
    const real = "唯一的一份最终答复。";
    wall += 1_000;
    await f.service.completeMainFinalAnswer({ taskId, text: real, stopReason: "end_turn" });
    const afterUpgrade = f.delivered.length;

    // 迟到的同一份正文再来一次：占位通道已关闭（summary 已不是占位），
    // 既不改写归档也不重投。
    wall += 1_000;
    await f.service.completeMainFinalAnswer({ taskId, text: real, stopReason: "end_turn" });
    expect(f.delivered).toHaveLength(afterUpgrade);
    expect(taskOf(f, taskId).result?.summary).toBe(real);
    expect(f.store.events.filter((e) => e.type === "task_result_delivered")).toHaveLength(2);
  });

  it("非占位的终态结果不被迟到的第二份结论覆盖", async () => {
    let wall = Date.now() - 60_000;
    const f = makeFixture({ now: () => wall });
    const taskId = await injectedMainTask(f);

    await f.service.completeMainFinalAnswer({
      taskId,
      text: "第一份结论：功能已实现。",
      stopReason: "end_turn",
    });
    const afterFirst = f.delivered.length;

    // 第二份结论是**不同**的内容：用户已经收到第一份，不能被悄悄改写。
    wall += 1_000;
    await f.service.completeMainFinalAnswer({
      taskId,
      text: "第二份结论：其实是另一个问题。",
      stopReason: "end_turn",
    });
    expect(taskOf(f, taskId).result?.summary).toBe("第一份结论：功能已实现。");
    expect(f.delivered).toHaveLength(afterFirst);
  });

  it("占位升级投递失败时如实留痕（deliveryError + 归档事件）", async () => {
    let wall = Date.now() - 60_000;
    const f = makeFixture({ now: () => wall });
    const taskId = await injectedMainTask(f);

    await f.service.completeMainFinalAnswer({ taskId, text: "", stopReason: "end_turn" });
    // 让后续投递全部失败（模拟额度用尽）。
    f.failDelivery(true);
    wall += 1_000;
    await f.service.completeMainFinalAnswer({
      taskId,
      text: "真实答复但送不出去。",
      stopReason: "end_turn",
    });
    const task = taskOf(f, taskId);
    // 归档里的正文已经升级（内容不丢），但回包失败如实留痕。
    expect(task.result?.summary).toBe("真实答复但送不出去。");
    expect(task.deliveryError).toContain("未能送达");
    expect(f.store.events.some((e) => e.type === "task_result_undelivered")).toBe(true);
  });

  it("占位那轮投递失败（锚点未落）时，真实正文仍能升级并投递", async () => {
    let wall = Date.now() - 60_000;
    const f = makeFixture({ now: () => wall });
    const taskId = await injectedMainTask(f);

    // 占位那一轮就送不出去。
    f.failDelivery(true);
    await f.service.completeMainFinalAnswer({ taskId, text: "", stopReason: "end_turn" });
    const placeholder = taskOf(f, taskId);
    expect(placeholder.result?.summary).toBe(QQ_MAIN_FINAL_EMPTY_NOTICE);
    expect(placeholder.resultDeliveredAt).toBeUndefined();
    expect(placeholder.deliveryError).toContain("未能送达");

    // 平台恢复后真实正文到达：升级并成功投递。
    f.failDelivery(false);
    wall += 1_000;
    const real = "迟到的真实最终答复。";
    await f.service.completeMainFinalAnswer({ taskId, text: real, stopReason: "end_turn" });
    const upgraded = taskOf(f, taskId);
    expect(upgraded.result?.summary).toBe(real);
    expect(upgraded.resultDeliveredAt).toBeTypeOf("number");
    expect(upgraded.deliveryError).toBeUndefined();
    expect(f.delivered.some((item) => item.text.includes(real))).toBe(true);
  });

  it("用户已取消 / 已丢弃的任务不升级（不该再往 QQ 推正文）", async () => {
    let wall = Date.now() - 60_000;
    const f = makeFixture({ now: () => wall });
    const taskId = await injectedMainTask(f);

    await f.service.completeMainFinalAnswer({
      taskId,
      text: "",
      stopReason: "canceled",
    });
    const canceled = taskOf(f, taskId);
    expect(canceled.status).toBe("canceled");
    expect(canceled.result?.summary).toBe(QQ_MAIN_FINAL_EMPTY_NOTICE);
    const deliveredBefore = f.delivered.length;

    wall += 1_000;
    await f.service.completeMainFinalAnswer({
      taskId,
      text: "取消之后才到的正文。",
      stopReason: "end_turn",
    });
    expect(taskOf(f, taskId).result?.summary).toBe(QQ_MAIN_FINAL_EMPTY_NOTICE);
    expect(f.delivered).toHaveLength(deliveredBefore);
  });
});

// ---------------------------------------------------------------------------
// 缺陷二：被节流压掉的中间正文可补发
// ---------------------------------------------------------------------------

describe("QQ 出站 — 被节流压掉的中间正文可补发", () => {
  it("60 秒内的第二条正文在下一个窗口补发（不再是只收到一条）", async () => {
    let mono = 1_000;
    const f = makeFixture({ monotonicNow: () => mono });
    const taskId = await injectedMainTask(f);

    // 第一条正文：立刻送达。
    await f.service.deliverMainTurnText(taskId, "第一段：已经拆成两个子任务");
    expect(f.delivered.filter((item) => item.text.includes("第一段"))).toHaveLength(1);

    // 第二条正文在 60 秒最小间隔内 → 被节流压住（此时还没到补发时机）。
    mono += 1_000;
    await f.service.deliverMainTurnText(taskId, "第二段：子任务 A 已完成");
    expect(f.delivered.filter((item) => item.text.includes("第二段"))).toHaveLength(0);

    // 下一个窗口产生新指纹 → 被压掉的那条被补发（与新正文合并成一条消息）。
    mono += QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS + 1;
    await f.service.deliverMainTurnText(taskId, "第三段：子任务 B 正在跑");
    const texts = f.delivered.map((item) => item.text);
    expect(texts.some((text) => text.includes("第二段"))).toBe(true);
    expect(texts.some((text) => text.includes("第三段"))).toBe(true);
    // 用户最终收到的是「第一段」+「合并了第二、三段的一条」= 2 条，不是 1 条。
    const progress = f.delivered.filter(
      (item) =>
        item.text.includes("第一段") ||
        item.text.includes("第二段") ||
        item.text.includes("第三段"),
    );
    expect(progress).toHaveLength(2);
  });

  it("补发过的正文不会在稍后被当成新的再发一遍（仍然防重复）", async () => {
    let mono = 1_000;
    const f = makeFixture({ monotonicNow: () => mono });
    const taskId = await injectedMainTask(f);

    await f.service.deliverMainTurnText(taskId, "第一段：已经拆成两个子任务");
    mono += 1_000;
    await f.service.deliverMainTurnText(taskId, "第二段：子任务 A 已完成");
    mono += QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS + 1;
    await f.service.deliverMainTurnText(taskId, "第三段：子任务 B 正在跑");
    const afterBackfill = f.delivered.length;

    // 迟到的第二段再来一次：已送达过，不再重发。
    mono += QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS + 1;
    await f.service.deliverMainTurnText(taskId, "第二段：子任务 A 已完成");
    expect(f.delivered).toHaveLength(afterBackfill);
  });

  it("节流纪律不变：窗口内的连续刷新不刷屏（仍只发一条）", async () => {
    let mono = 1_000;
    const f = makeFixture({ monotonicNow: () => mono });
    const taskId = await injectedMainTask(f);

    await f.service.deliverMainTurnText(taskId, "同一段正文");
    mono += 1_000;
    await f.service.deliverMainTurnText(taskId, "同一段正文");
    mono += 2_000;
    await f.service.deliverMainTurnText(taskId, "同一段正文");
    // 同一段正文（指纹未变）：窗口内外都不重发。
    expect(f.delivered.filter((item) => item.text.includes("同一段正文"))).toHaveLength(1);
  });
});
